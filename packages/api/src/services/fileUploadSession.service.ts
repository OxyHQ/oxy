/**
 * Large, any-type uploads by an application's service token (ADR 0043 stage 4b).
 *
 *   open      POST /assets/service/{app,user-media}/uploads
 *   parts     POST …/:uploadId/parts      presigned UploadPart URLs (≤ 100 a call)
 *   describe  GET  …/:uploadId             status, and the parts S3 holds (resume)
 *   complete  POST …/:uploadId/complete    assemble, then VERIFY (below)
 *   abort     DELETE …/:uploadId
 *
 * The client PUTs the parts to S3 itself; no byte passes through the API until
 * the API reads the assembled object back to hash it. Only bytes that hash to
 * the declared SHA-256 become a file (`AssetService.finalizeLargeUpload`, under
 * the content-hash lock with the takedown blocklist re-checked): S3 cannot
 * enforce a whole-object SHA-256 on a multipart upload (its full-object
 * checksums are CRCs; a SHA-256 multipart checksum is a hash of the parts'
 * hashes), and dedupe, shared storage and the blocklist all trust that hash.
 *
 * Verification runs in the request that completes the upload when it finishes
 * within {@link COMPLETE_WAIT_MS}; otherwise the answer is `202 verifying` and
 * the upload worker (`fileUploadSession.worker.ts`, every API task, leased)
 * finishes it — a task that dies mid-hash leaves an expiring lease another task
 * takes over. The worker also aborts the uploads nobody completed.
 *
 * Refused at open, before any byte is sent: executables and active documents
 * (`utils/fileContentPolicy.ts`, 415), more than 8 GiB (413), blocked bytes
 * (451), a storage plan that cannot hold the file (413, a metered owner with
 * storage admission on — reserved for the whole upload, D3). The owner's own
 * existing file of the declared bytes answers at once as `completed` +
 * `deduplicated`, without an upload: the owner already holds them.
 */

import crypto from 'node:crypto';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { normalizeInlineText } from '@oxy.so/core';
import { getDb } from '../config/postgres';
import {
  fileUploadSessions,
  OPEN_FILE_UPLOAD_SESSION_STATUSES,
  type FileUploadSessionReference,
  type FileUploadSessionRow,
} from '../db/schema/fileUploadSessions';
import { FILE_LIVE_STATUSES, files } from '../db/schema/files';
import type { AssetService } from './assetService';
import type { S3Service } from './s3Service';
import { IMMUTABLE_ASSET_CACHE_CONTROL } from '../config/cdn';
import { withContentHashLock } from './contentHashLock';
import { assertContentNotBlocked, CONTENT_BLOCKED_CODE } from './contentClaims/contentBlocklist';
import { findLiveFileBySha256ForOwner, isUniqueViolation } from './fileRepository';
import { mayApplicationReference } from './fileReference.service';
import { grantUploadAccess } from './fileAccessGrant.service';
import { loadProductBillingCatalogue } from './productBillingCatalogue.service';
import {
  releaseTerminalMultipartReservation,
  reserveStorageBytes,
} from './storageByteReservation.service';
import { storageAccountForOwner } from './storageQuota.service';
import type { FileOwner, FileRecord, FileVisibility } from '../types/file.types';
import { ApiError, BadRequestError, ConflictError, NotFoundError } from '../utils/error';
import {
  contentDispositionFor,
  isDeniedUploadType,
  LARGE_UPLOAD_MAX_BYTES,
  largeUploadPartSize,
  normalizeContentType,
  storedExtensionFor,
} from '../utils/fileContentPolicy';
import { logger } from '../utils/logger';
import {
  isSvgType,
  readBounded,
  sanitizeSvg,
  SVG_MAX_BYTES,
  withoutServerSvgMetadata,
} from '../utils/svgSanitizer';

/** How long a presigned part URL is valid. */
export const PART_URL_TTL_SECONDS = 60 * 60;
/** An `uploading` session not completed within a day of its last part-URL request is aborted… */
export const UPLOAD_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
/** …and none lives longer than a week, however often it asks for URLs. */
export const UPLOAD_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** How long `complete` waits for verification before answering `202 verifying`. */
export const COMPLETE_WAIT_MS = Number(process.env.LARGE_UPLOAD_COMPLETE_WAIT_MS ?? 20_000);
/** Verification attempts (each a fresh lease) before a session is failed. */
export const MAX_VERIFY_ATTEMPTS = 5;
/** Part URLs `open` hands out with the session; the rest come from `parts`. */
export const OPEN_PART_URLS = 100;

/** The slowest read rate a verification lease allows for. */
const VERIFY_BYTES_PER_SECOND = 16 * 1024 * 1024;

const LEASE_OWNER = `upload-verify:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

/** Who the file will belong to. */
export type LargeUploadOwner =
  | { kind: 'application'; applicationId: string }
  | { kind: 'account'; userId: string };

export interface OpenLargeUploadRequest {
  sha256: string;
  size: number;
  mime: string;
  filename?: string;
  visibility: FileVisibility;
  metadata?: Record<string, unknown>;
  reference?: FileUploadSessionReference;
}

export interface UploadPartUrl {
  partNumber: number;
  url: string;
  /** The exact Content-Length S3 will accept for this part (it is signed). */
  size: number;
}

/** The wire view of a session (or of a file that needed no upload). */
export interface LargeUploadView {
  uploadId: string | null;
  status: FileUploadSessionRow['status'];
  size: number;
  partSize?: number;
  partCount?: number;
  expiresAt?: Date;
  parts?: UploadPartUrl[];
  uploadedParts?: { partNumber: number; size: number }[];
  file?: FileRecord;
  deduplicated?: boolean;
  reference?: string;
  error?: { code: string; message: string; status: number };
}

/** The HTTP status a failed session's error answers with. */
const FAILURE_STATUS: Record<string, number> = {
  CHECKSUM_MISMATCH: 422,
  INVALID_SVG: 415,
  PAYLOAD_TOO_LARGE: 413,
  SIZE_MISMATCH: 422,
  [CONTENT_BLOCKED_CODE]: 451,
  STORAGE_QUOTA_EXCEEDED: 413,
  OWNER_GONE: 410,
  EXPIRED: 410,
  ABORTED: 410,
  VERIFICATION_FAILED: 500,
};

function ownerColumns(owner: LargeUploadOwner): FileOwner {
  return owner.kind === 'application'
    ? { ownerUserId: null, systemOwner: null, ownerApplicationId: owner.applicationId }
    : { ownerUserId: owner.userId, systemOwner: null };
}

function sessionOwner(row: FileUploadSessionRow): FileOwner {
  return row.kind === 'application'
    ? { ownerUserId: null, systemOwner: null, ownerApplicationId: row.ownerApplicationId as string }
    : { ownerUserId: row.ownerUserId as string, systemOwner: null };
}

function ownerPredicate(owner: LargeUploadOwner) {
  return owner.kind === 'application'
    ? eq(fileUploadSessions.ownerApplicationId, owner.applicationId)
    : eq(fileUploadSessions.ownerUserId, owner.userId);
}

/** Bytes of part `partNumber` (1-based) of a session: `part_size`, or the remainder for the last. */
export function partLength(
  row: Pick<FileUploadSessionRow, 'size' | 'partSize' | 'partCount'>,
  partNumber: number,
): number {
  return partNumber < row.partCount ? row.partSize : row.size - row.partSize * (row.partCount - 1);
}

function errorFields(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError) {
    return { code: error.code ?? 'VERIFICATION_FAILED', message: error.message };
  }
  return {
    code: 'VERIFICATION_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
}

/** A finalization error that will not go away on retry. */
function isTerminalFinalizeError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return (
      error.code === CONTENT_BLOCKED_CODE ||
      error.code === 'STORAGE_QUOTA_EXCEEDED' ||
      error.statusCode === 403 ||
      error.statusCode === 404
    );
  }
  for (
    let current: unknown = error;
    current instanceof Error;
    current = Reflect.get(current, 'cause')
  ) {
    // A foreign-key violation: the owning account is gone.
    if (Reflect.get(current, 'code') === '23503') return true;
  }
  return false;
}

export class FileUploadSessionService {
  constructor(
    private readonly assets: AssetService,
    private readonly s3: S3Service,
  ) {}

  /**
   * Open (or resume) an upload of `request` for `owner`, by the application
   * `uploaderApplicationId`. See the module header for what is refused here.
   */
  async open(
    owner: LargeUploadOwner,
    uploaderApplicationId: string,
    request: OpenLargeUploadRequest,
  ): Promise<LargeUploadView> {
    const mime = normalizeContentType(request.mime);
    if (!mime) throw new BadRequestError('mime must be a valid content type (type/subtype)');
    if (isDeniedUploadType(mime, request.filename)) {
      throw new ApiError(
        415,
        'Executables, installers and active documents (HTML, XML, scripts) cannot be stored',
        'UNSUPPORTED_MEDIA_TYPE',
      );
    }
    if (request.size > LARGE_UPLOAD_MAX_BYTES) {
      throw new ApiError(413, 'A file can be at most 8 GiB', 'PAYLOAD_TOO_LARGE');
    }
    // An SVG is sanitized once verified (stage 4c), in memory: it is bounded.
    if (isSvgType(mime) && request.size > SVG_MAX_BYTES) {
      throw new ApiError(413, 'An SVG can be at most 5 MiB', 'PAYLOAD_TOO_LARGE');
    }
    await assertContentNotBlocked(request.sha256);

    const columns = ownerColumns(owner);
    const own = await findLiveFileBySha256ForOwner(request.sha256, columns);
    if (own) {
      // The owner already holds these bytes: nothing to upload.
      const file = await this.assets.reuseOwnLiveFile(own, columns);
      // A person's file the application is storing for them: it may read it
      // back (ADR 0042 stage 4c), the bytes already being theirs included.
      if (owner.kind === 'account') await grantUploadAccess(file.id, uploaderApplicationId);
      const reference = await this.addReference(file, request.reference, uploaderApplicationId);
      return {
        uploadId: null,
        status: 'completed',
        size: file.size,
        file: reference ? ((await this.assets.getFile(file.id)) ?? file) : file,
        deduplicated: true,
        ...(reference ? { reference } : {}),
      };
    }

    const resumed = await this.findOpen(owner, request.sha256);
    if (resumed) return this.resume(resumed, uploaderApplicationId, request.size);

    const ext = storedExtensionFor(mime, request.filename);
    const partSize = largeUploadPartSize(request.size);
    const partCount = Math.ceil(request.size / partSize);
    const stagingKey = this.assets.largeUploadStagingKey(request.sha256, ext);
    const finalKey = this.assets.largeUploadFinalKey(stagingKey, request.visibility);

    // A metered owner with storage admission on: the whole file is reserved
    // against the plan before a byte is sent (ADR 0043 D3), at the key the row
    // will name, so the reservation and the row are counted once.
    const catalogue = await loadProductBillingCatalogue();
    const accountId = catalogue.storageAdapter
      ? await storageAccountForOwner(getDb(), columns)
      : null;
    const now = Date.now();
    const expiresAt = new Date(now + UPLOAD_IDLE_TTL_MS);
    const reservation = accountId
      ? await reserveStorageBytes({
          accountId,
          sha256: request.sha256,
          objectKey: finalKey,
          size: request.size,
          kind: 'presigned',
          recoverAfter: new Date(now + UPLOAD_MAX_LIFETIME_MS),
        })
      : null;

    let uploadId: string;
    try {
      uploadId = await this.s3.createMultipartUpload(stagingKey, {
        contentType: mime,
        contentDisposition: contentDispositionFor(mime),
        cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
      });
    } catch (error) {
      await this.releaseReservation(request.sha256, reservation?.id ?? null);
      throw error;
    }

    let row: FileUploadSessionRow;
    try {
      [row] = await getDb()
        .insert(fileUploadSessions)
        .values({
          kind: owner.kind,
          ownerUserId: owner.kind === 'account' ? owner.userId : null,
          ownerApplicationId: owner.kind === 'application' ? owner.applicationId : null,
          uploaderApplicationId,
          sha256: request.sha256,
          size: request.size,
          mime,
          ext,
          originalName: request.filename ? normalizeInlineText(request.filename) : null,
          visibility: request.visibility,
          // `metadata.svg` is the server's record of a sanitization, never the caller's.
          metadata: withoutServerSvgMetadata(request.metadata) ?? null,
          reference: request.reference ?? null,
          stagingKey,
          s3UploadId: uploadId,
          partSize,
          partCount,
          reservationId: reservation?.id ?? null,
          expiresAt,
        })
        .returning();
    } catch (error) {
      await this.s3.abortMultipartUpload(stagingKey, uploadId).catch(() => undefined);
      await this.releaseReservation(request.sha256, reservation?.id ?? null);
      if (!isUniqueViolation(error)) throw error;
      // Opened concurrently by another request: answer that session.
      const raced = await this.findOpen(owner, request.sha256);
      if (!raced) throw error;
      return this.resume(raced, uploaderApplicationId, request.size);
    }

    logger.info('Large upload opened', {
      uploadId: row.id,
      owner: owner.kind,
      uploaderApplicationId,
      size: request.size,
      mime,
      partCount,
    });
    return {
      ...(await this.view(row)),
      parts: await this.partUrls(
        row,
        Array.from({ length: Math.min(partCount, OPEN_PART_URLS) }, (_, index) => index + 1),
      ),
    };
  }

  /** The caller's session `uploadId`, or 404 (another caller's answers the same). */
  async load(
    uploadId: string,
    owner: LargeUploadOwner,
    uploaderApplicationId: string,
  ): Promise<FileUploadSessionRow> {
    const [row] = await getDb()
      .select()
      .from(fileUploadSessions)
      .where(
        and(
          eq(fileUploadSessions.id, uploadId),
          eq(fileUploadSessions.kind, owner.kind),
          eq(fileUploadSessions.uploaderApplicationId, uploaderApplicationId),
          ownerPredicate(owner),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundError('Upload not found');
    return row;
  }

  /** Presigned URLs for `partNumbers` of an `uploading` session; slides its idle deadline. */
  async requestPartUrls(
    row: FileUploadSessionRow,
    partNumbers: number[],
  ): Promise<LargeUploadView> {
    if (row.status !== 'uploading') {
      throw new ConflictError(`This upload is ${row.status}`);
    }
    const invalid = partNumbers.filter((part) => part < 1 || part > row.partCount);
    if (invalid.length > 0) {
      throw new BadRequestError(`Part numbers must be between 1 and ${row.partCount}`);
    }
    const expiresAt = new Date(
      Math.min(row.createdAt.getTime() + UPLOAD_MAX_LIFETIME_MS, Date.now() + UPLOAD_IDLE_TTL_MS),
    );
    const [updated] = await getDb()
      .update(fileUploadSessions)
      .set({ expiresAt })
      .where(and(eq(fileUploadSessions.id, row.id), eq(fileUploadSessions.status, 'uploading')))
      .returning();
    if (!updated) throw new ConflictError('This upload is no longer open');
    return {
      ...(await this.view(updated)),
      parts: await this.partUrls(
        updated,
        [...new Set(partNumbers)].sort((a, b) => a - b),
      ),
    };
  }

  /** The session as it stands; an `uploading` one lists the parts S3 already holds. */
  async describe(row: FileUploadSessionRow): Promise<LargeUploadView> {
    return this.view(row, { withUploadedParts: true });
  }

  /**
   * Assemble the parts and verify. Idempotent: a session already verifying,
   * completed or failed answers as it stands. Missing or mis-sized parts are
   * 409 `UPLOAD_INCOMPLETE` naming them, and the session stays open.
   */
  async complete(row: FileUploadSessionRow): Promise<LargeUploadView> {
    if (row.status === 'uploading') {
      const parts = await this.s3.listParts(row.stagingKey, row.s3UploadId);
      if (!parts) {
        // S3 no longer knows the upload (aborted out of band): it cannot complete.
        await this.fail(row, {
          code: 'ABORTED',
          message: 'The upload no longer exists in storage',
        });
        return this.view(await this.reload(row.id));
      }
      const held = new Map(parts.map((part) => [part.partNumber, part]));
      const missing: number[] = [];
      const wrongSize: number[] = [];
      for (let partNumber = 1; partNumber <= row.partCount; partNumber++) {
        const part = held.get(partNumber);
        if (!part) missing.push(partNumber);
        else if (part.size !== partLength(row, partNumber)) wrongSize.push(partNumber);
      }
      const extra = parts
        .filter((part) => part.partNumber > row.partCount)
        .map((p) => p.partNumber);
      if (missing.length > 0 || wrongSize.length > 0 || extra.length > 0) {
        throw new ApiError(
          409,
          'Some parts are missing or have the wrong size',
          'UPLOAD_INCOMPLETE',
          {
            missingParts: missing.slice(0, 1000),
            wrongSizeParts: wrongSize.slice(0, 1000),
            unexpectedParts: extra.slice(0, 1000),
          },
        );
      }
      await this.s3.completeMultipartUpload(
        row.stagingKey,
        row.s3UploadId,
        parts.filter((part) => part.partNumber <= row.partCount),
      );
      await getDb()
        .update(fileUploadSessions)
        .set({ status: 'verifying', leaseOwner: null, leaseExpiresAt: null })
        .where(and(eq(fileUploadSessions.id, row.id), eq(fileUploadSessions.status, 'uploading')));
    }
    const current = await this.reload(row.id);
    if (current.status === 'verifying') {
      const verification = this.verify(current.id).catch((error) => {
        logger.error('Large upload verification failed unexpectedly', {
          uploadId: current.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      await Promise.race([
        verification,
        new Promise((resolve) => setTimeout(resolve, COMPLETE_WAIT_MS).unref?.()),
      ]);
    }
    return this.view(await this.reload(row.id));
  }

  /** Abort an `uploading` session: S3 discards its parts. Verifying is too late (409). */
  async abort(row: FileUploadSessionRow): Promise<LargeUploadView> {
    if (row.status === 'verifying') throw new ConflictError('This upload is being verified');
    if (row.status === 'uploading') {
      await this.s3.abortMultipartUpload(row.stagingKey, row.s3UploadId);
      await this.finish(row, 'aborted', { code: 'ABORTED', message: 'Aborted by the uploader' });
    }
    return this.view(await this.reload(row.id));
  }

  /**
   * Verify one `verifying` session under a lease (see the header). Returns
   * without doing anything when another verifier holds the lease.
   */
  async verify(uploadId: string): Promise<void> {
    // The lease covers reading the whole object at a slow 16 MiB/s, ten minutes at least.
    const [row] = await getDb()
      .update(fileUploadSessions)
      .set({
        leaseOwner: LEASE_OWNER,
        leaseExpiresAt: sql`now() + make_interval(secs => greatest(600, ${fileUploadSessions.size} / ${VERIFY_BYTES_PER_SECOND}))`,
        attempts: sql`${fileUploadSessions.attempts} + 1`,
      })
      .where(
        and(
          eq(fileUploadSessions.id, uploadId),
          eq(fileUploadSessions.status, 'verifying'),
          or(
            isNull(fileUploadSessions.leaseExpiresAt),
            lt(fileUploadSessions.leaseExpiresAt, sql`now()`),
          ),
        ),
      )
      .returning();
    if (!row) return;

    // The owner already holds the bytes — another upload or import of them, or
    // this very session's file from an attempt that stored it and died before
    // saying so. Nothing of this upload is stored: no hash needed.
    const holds = await findLiveFileBySha256ForOwner(row.sha256, sessionOwner(row));
    if (holds) {
      await this.store(row);
      return;
    }

    let digest: string;
    let bytes = 0;
    try {
      const { body } = await this.s3.getObjectStreamRange(row.stagingKey);
      const hash = crypto.createHash('sha256');
      for await (const chunk of body as AsyncIterable<Buffer>) {
        bytes += chunk.length;
        hash.update(chunk);
      }
      digest = hash.digest('hex');
    } catch (error) {
      await this.retryLater(row, error);
      return;
    }

    if (bytes !== row.size) {
      await this.fail(row, {
        code: 'SIZE_MISMATCH',
        message: `The assembled file is ${bytes} bytes, not the ${row.size} declared`,
      });
      return;
    }
    if (digest !== row.sha256) {
      await this.fail(row, {
        code: 'CHECKSUM_MISMATCH',
        message: 'The uploaded bytes do not hash to the declared sha256',
      });
      return;
    }

    if (isSvgType(row.mime)) {
      await this.storeSanitizedSvg(row);
      return;
    }
    await this.store(row);
  }

  /**
   * A verified SVG becomes a file only as its sanitized document (ADR 0042
   * stage 4c): the uploaded bytes are read (bounded at open), sanitized, and
   * the sanitized bytes written next to them (a key derived from the upload's,
   * so a retried attempt rewrites the same object); the file's hash is the
   * sanitized bytes', the declared one is kept as `metadata.svg.originalSha256`.
   * The upload's reservation was for the declared bytes at another key: it is
   * released, and the insert is admitted against the plan on its own. The
   * upload's own object goes once the session is settled — a transient failure
   * keeps it for the next attempt.
   */
  private async storeSanitizedSvg(row: FileUploadSessionRow): Promise<void> {
    let sanitized: ReturnType<typeof sanitizeSvg>;
    try {
      const { body } = await this.s3.getObjectStreamRange(row.stagingKey);
      sanitized = sanitizeSvg(await readBounded(body as AsyncIterable<Buffer>, SVG_MAX_BYTES));
    } catch (error) {
      if (error instanceof ApiError) {
        await this.fail(row, { code: error.code, message: error.message });
      } else {
        await this.retryLater(row, error);
      }
      return;
    }
    const stagingKey = `${row.stagingKey.replace(/\.svg$/i, '')}-sanitized${row.ext}`;
    try {
      await this.s3.uploadBuffer(stagingKey, sanitized.bytes, {
        contentType: row.mime,
        cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
      });
    } catch (error) {
      await this.retryLater(row, error);
      return;
    }
    await this.releaseReservation(row.sha256, row.reservationId);
    await this.store({
      ...row,
      sha256: sanitized.sha256,
      size: sanitized.bytes.length,
      stagingKey,
      reservationId: null,
      metadata: { ...(row.metadata ?? {}), svg: sanitized.record },
    });
    if ((await this.reload(row.id)).status === 'verifying') return;
    await this.s3.deleteFile(row.stagingKey).catch((cause: unknown) => {
      logger.warn('Large upload: could not delete an SVG as uploaded', {
        uploadId: row.id,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });
  }

  /** Make a verified session's bytes its owner's file, register its reference, and complete it. */
  private async store(row: FileUploadSessionRow): Promise<void> {
    let stored: { file: FileRecord; deduplicated: boolean };
    try {
      stored = await this.assets.finalizeLargeUpload({
        owner: sessionOwner(row),
        sha256: row.sha256,
        size: row.size,
        mime: row.mime,
        ext: row.ext,
        originalName: row.originalName,
        visibility: row.visibility,
        metadata: {
          ...(row.metadata ?? {}),
          serviceAppId: row.uploaderApplicationId,
          upload: 'multipart',
        },
        stagingKey: row.stagingKey,
        reservationId: row.reservationId,
      });
    } catch (error) {
      if (isTerminalFinalizeError(error)) {
        const fields = errorFields(error);
        await this.fail(row, {
          code:
            fields.code === CONTENT_BLOCKED_CODE || fields.code === 'STORAGE_QUOTA_EXCEEDED'
              ? fields.code
              : 'OWNER_GONE',
          message: fields.message,
        });
      } else {
        await this.retryLater(row, error);
      }
      return;
    }

    // A person's file the uploading application stored for them: it may read
    // it back (ADR 0042 stage 4c).
    if (row.kind === 'account') await grantUploadAccess(stored.file.id, row.uploaderApplicationId);
    const reference = await this.addReference(
      stored.file,
      row.reference ?? undefined,
      row.uploaderApplicationId,
    );
    await getDb()
      .update(fileUploadSessions)
      .set({
        status: 'completed',
        fileId: stored.file.id,
        deduplicated: stored.deduplicated,
        referenceResult: reference ?? null,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: new Date(),
      })
      .where(and(eq(fileUploadSessions.id, row.id), eq(fileUploadSessions.status, 'verifying')));
    logger.info('Large upload verified', {
      uploadId: row.id,
      fileId: stored.file.id,
      deduplicated: stored.deduplicated,
      size: row.size,
    });
  }

  /**
   * The worker's pass: verify sessions whose lease is free (a crashed verifier's
   * included), and abort `uploading` sessions past their deadline. Bounded per
   * call; returns what it did.
   */
  async sweep(limit = 20): Promise<{ verified: number; expired: number }> {
    const db = getDb();
    const due = await db
      .select({ id: fileUploadSessions.id })
      .from(fileUploadSessions)
      .where(
        and(
          eq(fileUploadSessions.status, 'verifying'),
          or(
            isNull(fileUploadSessions.leaseExpiresAt),
            lt(fileUploadSessions.leaseExpiresAt, sql`now()`),
          ),
        ),
      )
      .limit(limit);
    let verified = 0;
    for (const { id } of due) {
      await this.verify(id);
      verified++;
    }

    const stale = await db
      .select()
      .from(fileUploadSessions)
      .where(
        and(
          eq(fileUploadSessions.status, 'uploading'),
          lt(fileUploadSessions.expiresAt, sql`now()`),
        ),
      )
      .limit(limit);
    let expired = 0;
    for (const row of stale) {
      try {
        await this.s3.abortMultipartUpload(row.stagingKey, row.s3UploadId);
        if (await this.finish(row, 'aborted', { code: 'EXPIRED', message: 'The upload expired' })) {
          expired++;
        }
      } catch (error) {
        logger.warn('Large upload: could not abort an expired upload; will retry', {
          uploadId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { verified, expired };
  }

  private async findOpen(
    owner: LargeUploadOwner,
    sha256: string,
  ): Promise<FileUploadSessionRow | undefined> {
    const [row] = await getDb()
      .select()
      .from(fileUploadSessions)
      .where(
        and(
          ownerPredicate(owner),
          eq(fileUploadSessions.sha256, sha256),
          inArray(fileUploadSessions.status, [...OPEN_FILE_UPLOAD_SESSION_STATUSES]),
        ),
      )
      .limit(1);
    return row;
  }

  /** Re-opening bytes with an open session answers it — the same uploader and size only. */
  private async resume(
    row: FileUploadSessionRow,
    uploaderApplicationId: string,
    size: number,
  ): Promise<LargeUploadView> {
    if (row.uploaderApplicationId !== uploaderApplicationId || row.size !== size) {
      throw new ApiError(
        409,
        'An upload of these bytes for this owner is already in progress',
        'UPLOAD_IN_PROGRESS',
      );
    }
    if (row.status !== 'uploading') return this.view(row);
    const view = await this.view(row, { withUploadedParts: true });
    const held = new Set(view.uploadedParts?.map((part) => part.partNumber) ?? []);
    const missing: number[] = [];
    for (let part = 1; part <= row.partCount && missing.length < OPEN_PART_URLS; part++) {
      if (!held.has(part)) missing.push(part);
    }
    return { ...view, parts: await this.partUrls(row, missing) };
  }

  private async partUrls(
    row: FileUploadSessionRow,
    partNumbers: number[],
  ): Promise<UploadPartUrl[]> {
    return Promise.all(
      partNumbers.map(async (partNumber) => {
        const size = partLength(row, partNumber);
        return {
          partNumber,
          size,
          url: await this.s3.getPresignedUploadPartUrl(row.stagingKey, row.s3UploadId, partNumber, {
            expiresIn: PART_URL_TTL_SECONDS,
            contentLength: size,
          }),
        };
      }),
    );
  }

  private async view(
    row: FileUploadSessionRow,
    options: { withUploadedParts?: boolean } = {},
  ): Promise<LargeUploadView> {
    const view: LargeUploadView = {
      uploadId: row.id,
      status: row.status,
      size: row.size,
      partSize: row.partSize,
      partCount: row.partCount,
      expiresAt: row.expiresAt,
    };
    if (row.status === 'uploading' && options.withUploadedParts) {
      const parts = (await this.s3.listParts(row.stagingKey, row.s3UploadId)) ?? [];
      view.uploadedParts = parts.map((part) => ({ partNumber: part.partNumber, size: part.size }));
    }
    if (row.status === 'completed' && row.fileId) {
      const file = await this.assets.getFile(row.fileId);
      if (file) view.file = file;
      view.deduplicated = row.deduplicated;
      if (row.referenceResult) view.reference = row.referenceResult;
    }
    if ((row.status === 'failed' || row.status === 'aborted') && row.errorCode) {
      view.error = {
        code: row.errorCode,
        message: row.errorMessage ?? row.errorCode,
        status: FAILURE_STATUS[row.errorCode] ?? 500,
      };
    }
    return view;
  }

  private async reload(id: string): Promise<FileUploadSessionRow> {
    const [row] = await getDb()
      .select()
      .from(fileUploadSessions)
      .where(eq(fileUploadSessions.id, id))
      .limit(1);
    if (!row) throw new NotFoundError('Upload not found');
    return row;
  }

  /** `POST /assets/service/references`' rule, for the upload's own reference. */
  private async addReference(
    file: FileRecord,
    reference: FileUploadSessionReference | undefined,
    applicationId: string,
  ): Promise<'created' | 'exists' | 'not_found' | undefined> {
    if (!reference) return undefined;
    if (!mayApplicationReference(file, applicationId)) return 'not_found';
    const { created } = await this.assets.linkFile(file.id, {
      applicationId,
      entityType: reference.entityType,
      entityId: reference.entityId,
      createdByUserId: null,
    });
    return created ? 'created' : 'exists';
  }

  /**
   * Fail a session that was assembled (or whose upload S3 lost): its object
   * goes, its reservation is released, and the error is kept for the client.
   */
  private async fail(
    row: FileUploadSessionRow,
    error: { code: string; message: string },
  ): Promise<void> {
    // The session's own keys — but never one a live row names (an attempt that
    // stored the file and died before completing the session).
    const finalKey = this.assets.largeUploadFinalKey(row.stagingKey, row.visibility);
    const keys = [...new Set([row.stagingKey, finalKey])];
    const used = new Set(
      (
        await getDb()
          .select({ key: files.storageKey })
          .from(files)
          .where(
            and(inArray(files.storageKey, keys), inArray(files.status, [...FILE_LIVE_STATUSES])),
          )
      ).map((file) => file.key),
    );
    for (const key of keys.filter((candidate) => !used.has(candidate))) {
      await this.s3.deleteFile(key).catch((cause: unknown) => {
        logger.warn('Large upload: could not delete a failed upload object', {
          uploadId: row.id,
          key,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    }
    await this.finish(row, 'failed', error);
    logger.warn('Large upload failed', { uploadId: row.id, code: error.code });
  }

  /** Move an open session to a terminal state and release its reservation; `false` if it was no longer open. */
  private async finish(
    row: FileUploadSessionRow,
    status: 'failed' | 'aborted',
    error: { code: string; message: string },
  ): Promise<boolean> {
    const [done] = await getDb()
      .update(fileUploadSessions)
      .set({
        status,
        errorCode: error.code,
        errorMessage: error.message.slice(0, 1000),
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(fileUploadSessions.id, row.id),
          inArray(fileUploadSessions.status, [...OPEN_FILE_UPLOAD_SESSION_STATUSES]),
        ),
      )
      .returning({ id: fileUploadSessions.id });
    if (!done) return false;
    await this.releaseReservation(row.sha256, row.reservationId);
    return true;
  }

  /** A transient failure: free the lease for a later attempt, or fail after the last. */
  private async retryLater(row: FileUploadSessionRow, error: unknown): Promise<void> {
    const fields = errorFields(error);
    if (row.attempts >= MAX_VERIFY_ATTEMPTS) {
      await this.fail(row, { code: 'VERIFICATION_FAILED', message: fields.message });
      return;
    }
    logger.warn('Large upload verification will be retried', {
      uploadId: row.id,
      attempt: row.attempts,
      error: fields.message,
    });
    await getDb()
      .update(fileUploadSessions)
      .set({
        leaseOwner: null,
        // Back off: one minute times the attempts so far.
        leaseExpiresAt: sql`now() + make_interval(mins => ${row.attempts})`,
      })
      .where(and(eq(fileUploadSessions.id, row.id), eq(fileUploadSessions.status, 'verifying')));
  }

  private async releaseReservation(sha256: string, reservationId: string | null): Promise<void> {
    if (!reservationId) return;
    await withContentHashLock(sha256, (tx) =>
      releaseTerminalMultipartReservation(tx, reservationId),
    );
  }
}
