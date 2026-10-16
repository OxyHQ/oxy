/**
 * Bytes Oxy receives or fetches before their hash is known (ADR 0042 stage 4c,
 * `file_ingests`): large imports by URL and recording targets. See the
 * schema's header for the model; this module is its lifecycle.
 *
 *   import     startLargeImport → receive (stream → staging, hashed) → finalize
 *   recording  createRecordingTarget → the S3 ingest writes the object
 *              (`recordingIngest.ts`) → verify (hash if not yet) → finalize
 *
 * `finalize` is `AssetService.finalizeLargeUpload` with the hash Oxy computed:
 * per-owner dedupe, shared storage, the takedown blocklist and a metered
 * owner's plan (`insertFile`'s quota check) — then the creator's reference, a
 * person's access grant for the creator, and an import's `file_sources` row.
 * A failure that will not go away deletes the staging object; anything else is
 * retried by the upload worker (`fileUploadSession.worker.ts` sweeps both
 * tables), which also re-fetches an import whose fetcher died and aborts what
 * nobody finished.
 */

import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Transform, type Readable } from 'node:stream';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { normalizeInlineText } from '@oxy.so/core';
import { getDb } from '../config/postgres';
import { IMMUTABLE_ASSET_CACHE_CONTROL } from '../config/cdn';
import {
  fileIngests,
  OPEN_FILE_INGEST_STATUSES,
  type FileIngestReference,
  type FileIngestRow,
  type FileIngestStatus,
} from '../db/schema/fileIngests';
import { applications } from '../db/schema/applications';
import { fileSources } from '../db/schema/fileSources';
import { FILE_LIVE_STATUSES, files } from '../db/schema/files';
import type { FileOwner, FileRecord, FileVisibility } from '../types/file.types';
import { ApiError, BadRequestError, ConflictError, NotFoundError } from '../utils/error';
import { LARGE_UPLOAD_MAX_BYTES, storedExtensionFor } from '../utils/fileContentPolicy';
import { logger } from '../utils/logger';
import { openSecret, sealSecret } from '../utils/secretBox';
import type { AssetService } from './assetService';
import { CONTENT_BLOCKED_CODE } from './contentClaims/contentBlocklist';
import { grantUploadAccess } from './fileAccessGrant.service';
import { mayApplicationReference } from './fileReference.service';
import type { S3Service } from './s3Service';

/** Who the file will belong to. */
export type IngestOwner =
  | { kind: 'application'; applicationId: string }
  | { kind: 'account'; userId: string };

/** How long an import may take to arrive in all, and to send nothing at all. */
export const LARGE_IMPORT_TOTAL_TIMEOUT_MS = Number(
  process.env.LARGE_IMPORT_TOTAL_TIMEOUT_MS ?? 60 * 60 * 1000,
);
export const LARGE_IMPORT_IDLE_TIMEOUT_MS = 60_000;
/** An import nobody finished is abandoned this long after it began. */
export const LARGE_IMPORT_TTL_MS = 24 * 60 * 60 * 1000;
/** Fetch or verification attempts before an ingest fails. */
export const INGEST_MAX_ATTEMPTS = 5;
/** How long a recording target's `complete` waits for verification before answering 202. */
export const RECORDING_COMPLETE_WAIT_MS = Number(
  process.env.LARGE_UPLOAD_COMPLETE_WAIT_MS ?? 20_000,
);
export const RECORDING_DEFAULT_TTL_SECONDS = 24 * 60 * 60;
/** The bucket name a recording target's S3 configuration names (path-style, Oxy's own endpoint). */
export const RECORDING_BUCKET = 'oxy-recordings';
/** Any region signs the same here; this is the one handed out. */
export const RECORDING_REGION = 'us-east-1';
/** The main object's name a target hands out, under `<targetId>/` (an egress appends its extension). */
export const RECORDING_OBJECT_BASENAME = 'recording';
/** A side object (an egress's JSON manifest) is accepted up to this and discarded. */
export const RECORDING_SIDE_OBJECT_MAX_BYTES = 1024 * 1024;

const VERIFY_BYTES_PER_SECOND = 16 * 1024 * 1024;
const LEASE_OWNER = `file-ingest:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

const RECORDING_EXTENSION_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  mkv: 'video/x-matroska',
  ts: 'video/mp2t',
};

/** The HTTP status a failed ingest's error answers with. */
const FAILURE_STATUS: Record<string, number> = {
  [CONTENT_BLOCKED_CODE]: 451,
  STORAGE_QUOTA_EXCEEDED: 413,
  PAYLOAD_TOO_LARGE: 413,
  OWNER_GONE: 410,
  EXPIRED: 410,
  ABORTED: 410,
  SOURCE_FETCH_FAILED: 502,
  SOURCE_FETCH_TIMEOUT: 504,
  SOURCE_URL_REFUSED: 422,
  UNSUPPORTED_MEDIA_TYPE: 415,
  EMPTY_RECORDING: 422,
  INGEST_FAILED: 500,
};

function secretContext(id: string): string {
  return `file-ingest-secret|${id}`;
}

function sourceContext(id: string): string {
  return `file-ingest-source|${id}`;
}

export function ingestOwnerColumns(
  row: Pick<FileIngestRow, 'kind' | 'ownerUserId' | 'ownerApplicationId'>,
): FileOwner {
  return row.kind === 'application'
    ? { ownerUserId: null, systemOwner: null, ownerApplicationId: row.ownerApplicationId as string }
    : { ownerUserId: row.ownerUserId as string, systemOwner: null };
}

function ownerPredicate(owner: IngestOwner) {
  return owner.kind === 'application'
    ? eq(fileIngests.ownerApplicationId, owner.applicationId)
    : eq(fileIngests.ownerUserId, owner.userId);
}

function errorFields(error: unknown): { code: string; message: string } {
  if (error instanceof ApiError) {
    return { code: error.code ?? 'INGEST_FAILED', message: error.message };
  }
  return {
    code: 'INGEST_FAILED',
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
    if (Reflect.get(current, 'code') === '23503') return true;
  }
  return false;
}

/** The wire view of an ingest. */
export interface IngestView {
  id: string;
  source: FileIngestRow['source'];
  status: FileIngestStatus;
  expiresAt: Date;
  size: number | null;
  sourceHost: string | null;
  fetchedAt: Date | null;
  etag: string | null;
  lastModified: string | null;
  file?: FileRecord;
  deduplicated?: boolean;
  reference?: string;
  error?: { code: string; message: string; status: number };
}

/** What an import hands over once it knows its source is large. */
export interface LargeImportInput {
  owner: IngestOwner;
  creatorApplicationId: string;
  source: { url: string; host: string; sha256: string };
  visibility: FileVisibility;
  reference?: FileIngestReference;
  metadata: Record<string, unknown>;
  originalName: string;
  mime: string;
  etag: string | null;
  lastModified: string | null;
  /** The source's `Content-Length`: the body must be exactly that long. */
  declaredLength: number | null;
}

/** What creating a recording target asks for. */
export interface RecordingTargetInput {
  owner: IngestOwner;
  creatorApplicationId: string;
  visibility: FileVisibility;
  filename?: string;
  metadata?: Record<string, unknown>;
  reference?: FileIngestReference;
  maxBytes?: number;
  expiresInSeconds?: number;
}

/** A recording object as the S3 ingest receives it. */
export interface RecordingObjectWrite {
  objectName: string;
  contentType: string | undefined;
  body: Readable;
  /** Bytes the body will carry, when the client declared them. */
  contentLength?: number;
}

/** Re-fetch an import's source (the worker, after its fetcher died): its response and type. */
export type ImportRefetch = (
  row: FileIngestRow,
  url: string,
  signal: AbortSignal,
) => Promise<{
  response: IncomingMessage;
  mime: string;
  etag: string | null;
  lastModified: string | null;
  declaredLength: number | null;
}>;

export class FileIngestService {
  constructor(
    private readonly assets: AssetService,
    private readonly s3: S3Service,
  ) {}

  /** The staging key of an ingest: its own, private spelling. */
  stagingKeyFor(id: string, ext: string): string {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    return `content/${now.getFullYear()}/${month}/ingest/${id}${ext}`;
  }

  /** The caller's ingest `id` of `source`, or 404 (anybody else's answers the same). */
  async load(
    id: string,
    source: FileIngestRow['source'],
    owner: IngestOwner,
    creatorApplicationId: string,
  ): Promise<FileIngestRow> {
    const [row] = await getDb()
      .select()
      .from(fileIngests)
      .where(
        and(
          eq(fileIngests.id, id),
          eq(fileIngests.source, source),
          eq(fileIngests.kind, owner.kind),
          eq(fileIngests.creatorApplicationId, creatorApplicationId),
          ownerPredicate(owner),
        ),
      )
      .limit(1);
    if (!row)
      throw new NotFoundError(
        source === 'import' ? 'Import not found' : 'Recording target not found',
      );
    return row;
  }

  async reload(id: string): Promise<FileIngestRow> {
    const [row] = await getDb().select().from(fileIngests).where(eq(fileIngests.id, id)).limit(1);
    if (!row) throw new NotFoundError('Ingest not found');
    return row;
  }

  async view(row: FileIngestRow): Promise<IngestView> {
    const view: IngestView = {
      id: row.id,
      source: row.source,
      status: row.status,
      expiresAt: row.expiresAt,
      size: row.size,
      sourceHost: row.sourceHost,
      fetchedAt: row.source === 'import' ? row.createdAt : null,
      etag: row.etag,
      lastModified: row.lastModified,
    };
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

  // -------------------------------------------------------------------------
  // Large imports
  // -------------------------------------------------------------------------

  /**
   * Take over an import whose source is too large to store in the request:
   * write the row (leased to this task), and receive `response` in the
   * background. The caller answers `202` with the row's id.
   */
  async startLargeImport(
    input: LargeImportInput,
    response: IncomingMessage,
    controller: AbortController,
  ): Promise<FileIngestRow> {
    const id = crypto.randomUUID();
    const ext = storedExtensionFor(input.mime, input.originalName);
    const [row] = await getDb()
      .insert(fileIngests)
      .values({
        id,
        source: 'import',
        kind: input.owner.kind,
        status: 'receiving',
        ownerUserId: input.owner.kind === 'account' ? input.owner.userId : null,
        ownerApplicationId: input.owner.kind === 'application' ? input.owner.applicationId : null,
        creatorApplicationId: input.creatorApplicationId,
        mime: input.mime,
        ext,
        originalName: normalizeInlineText(input.originalName),
        visibility: input.visibility,
        metadata: input.metadata,
        reference: input.reference ?? null,
        stagingKey: this.stagingKeyFor(id, ext),
        maxBytes: LARGE_UPLOAD_MAX_BYTES,
        sourceUrlSha256: input.source.sha256,
        sourceHost: input.source.host,
        sourceUrlCiphertext: sealSecret(input.source.url, sourceContext(id)),
        etag: input.etag,
        lastModified: input.lastModified,
        attempts: 1,
        leaseOwner: LEASE_OWNER,
        leaseExpiresAt: new Date(Date.now() + LARGE_IMPORT_TOTAL_TIMEOUT_MS + 5 * 60_000),
        expiresAt: new Date(Date.now() + LARGE_IMPORT_TTL_MS),
      })
      .returning();
    logger.info('Large import started', {
      ingestId: row.id,
      sourceHost: row.sourceHost,
      creatorApplicationId: row.creatorApplicationId,
    });
    void this.receiveImport(row, response, controller, input.declaredLength);
    return row;
  }

  /**
   * Stream an import's body into its staging object (S3 multipart, never
   * buffered), hashing it on the way, under the total and idle timeouts and
   * the size cap; then finalize. Never throws: the outcome is on the row.
   */
  async receiveImport(
    row: FileIngestRow,
    response: IncomingMessage,
    controller: AbortController,
    declaredLength: number | null,
  ): Promise<void> {
    const total = setTimeout(() => controller.abort(), LARGE_IMPORT_TOTAL_TIMEOUT_MS);
    total.unref?.();
    let idle: ReturnType<typeof setTimeout> | null = null;
    const touch = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), LARGE_IMPORT_IDLE_TIMEOUT_MS);
      idle.unref?.();
    };
    const stagingKey = row.stagingKey as string;
    const hash = crypto.createHash('sha256');
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        touch();
        size += chunk.length;
        if (size > row.maxBytes) {
          callback(
            new ApiError(413, 'The source exceeds the maximum file size', 'PAYLOAD_TOO_LARGE'),
          );
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    touch();
    try {
      response.on('error', (error) => meter.destroy(error));
      await this.s3.uploadStream(stagingKey, response.pipe(meter), {
        contentType: row.mime ?? 'application/octet-stream',
        cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
        abortSignal: controller.signal,
      });
      if (size === 0) throw new ApiError(502, 'The source sent no bytes', 'SOURCE_FETCH_FAILED');
      if (declaredLength !== null && size !== declaredLength) {
        // A body cut short (or longer than announced): never stored as the file.
        throw new ApiError(
          502,
          `The source sent ${size} bytes, not the ${declaredLength} it announced`,
          'SOURCE_FETCH_FAILED',
        );
      }
    } catch (error) {
      response.destroy();
      const cause =
        controller.signal.aborted && !(error instanceof ApiError)
          ? new ApiError(504, 'The source did not finish in time', 'SOURCE_FETCH_TIMEOUT')
          : error;
      await this.s3.deleteFile(stagingKey).catch(() => undefined);
      if (cause instanceof ApiError && cause.code === 'PAYLOAD_TOO_LARGE') {
        await this.fail(row, errorFields(cause));
      } else {
        await this.retryLater(row, cause);
      }
      return;
    } finally {
      clearTimeout(total);
      if (idle) clearTimeout(idle);
    }

    const [verifying] = await getDb()
      .update(fileIngests)
      .set({
        status: 'verifying',
        size,
        sha256: hash.digest('hex'),
        leaseOwner: LEASE_OWNER,
        leaseExpiresAt: sql`now() + interval '10 minutes'`,
      })
      .where(and(eq(fileIngests.id, row.id), eq(fileIngests.status, 'receiving')))
      .returning();
    if (!verifying) return;
    await this.finalize(verifying);
  }

  /**
   * The worker's retry of an import whose fetcher died or failed transiently:
   * fetch the source again (the same SSRF-safe fetcher) and receive it.
   */
  async resumeImport(row: FileIngestRow, refetch: ImportRefetch): Promise<void> {
    const [leased] = await getDb()
      .update(fileIngests)
      .set({
        leaseOwner: LEASE_OWNER,
        leaseExpiresAt: new Date(Date.now() + LARGE_IMPORT_TOTAL_TIMEOUT_MS + 5 * 60_000),
        attempts: sql`${fileIngests.attempts} + 1`,
      })
      .where(
        and(
          eq(fileIngests.id, row.id),
          eq(fileIngests.status, 'receiving'),
          or(isNull(fileIngests.leaseExpiresAt), lt(fileIngests.leaseExpiresAt, sql`now()`)),
        ),
      )
      .returning();
    if (!leased) return;
    if (leased.attempts > INGEST_MAX_ATTEMPTS) {
      await this.fail(leased, {
        code: leased.errorCode ?? 'SOURCE_FETCH_FAILED',
        message: leased.errorMessage ?? 'The source could not be fetched',
      });
      return;
    }
    const controller = new AbortController();
    let fetched: Awaited<ReturnType<ImportRefetch>>;
    try {
      const url = openSecret(leased.sourceUrlCiphertext as string, sourceContext(leased.id));
      fetched = await refetch(leased, url, controller.signal);
    } catch (error) {
      if (error instanceof ApiError && (error.statusCode === 415 || error.statusCode === 422)) {
        await this.fail(leased, errorFields(error));
      } else {
        await this.retryLater(leased, error);
      }
      return;
    }
    const [updated] = await getDb()
      .update(fileIngests)
      .set({ mime: fetched.mime, etag: fetched.etag, lastModified: fetched.lastModified })
      .where(eq(fileIngests.id, leased.id))
      .returning();
    await this.receiveImport(
      updated ?? leased,
      fetched.response,
      controller,
      fetched.declaredLength,
    );
  }

  // -------------------------------------------------------------------------
  // Recording targets
  // -------------------------------------------------------------------------

  /** Create a recording target; the S3 secret exists only in this answer. */
  async createRecordingTarget(
    input: RecordingTargetInput,
  ): Promise<{ row: FileIngestRow; secret: string }> {
    const maxBytes = input.maxBytes ?? LARGE_UPLOAD_MAX_BYTES;
    if (maxBytes > LARGE_UPLOAD_MAX_BYTES) {
      throw new BadRequestError('maxBytes can be at most 8 GiB');
    }
    const ttl = input.expiresInSeconds ?? RECORDING_DEFAULT_TTL_SECONDS;
    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(30).toString('base64url');
    const [row] = await getDb()
      .insert(fileIngests)
      .values({
        id,
        source: 'recording',
        kind: input.owner.kind,
        status: 'awaiting_upload',
        ownerUserId: input.owner.kind === 'account' ? input.owner.userId : null,
        ownerApplicationId: input.owner.kind === 'application' ? input.owner.applicationId : null,
        creatorApplicationId: input.creatorApplicationId,
        originalName: input.filename ? normalizeInlineText(input.filename) : null,
        visibility: input.visibility,
        metadata: input.metadata ?? null,
        reference: input.reference ?? null,
        maxBytes,
        secretCiphertext: sealSecret(secret, secretContext(id)),
        expiresAt: sql`now() + make_interval(secs => ${ttl})`,
      })
      .returning();
    logger.info('Recording target created', {
      targetId: row.id,
      owner: row.kind,
      creatorApplicationId: row.creatorApplicationId,
    });
    return { row, secret };
  }

  /** The object name a target hands out (an egress appends its file extension). */
  recordingFilepath(row: Pick<FileIngestRow, 'id'>): string {
    return `${row.id}/${RECORDING_OBJECT_BASENAME}`;
  }

  /**
   * The recording target an S3 access key names, with its secret — or `null`
   * (unknown, failed, aborted, expired): the ingest answers
   * `InvalidAccessKeyId` alike for all of them.
   */
  async recordingCredentials(
    accessKeyId: string,
  ): Promise<{ row: FileIngestRow; secret: string } | null> {
    if (!/^[0-9a-f-]{36}$/.test(accessKeyId)) return null;
    const [found] = await getDb()
      .select({ row: fileIngests })
      .from(fileIngests)
      // Only an active application's target takes bytes.
      .innerJoin(
        applications,
        and(
          eq(applications.id, fileIngests.creatorApplicationId),
          eq(applications.status, 'active'),
        ),
      )
      .where(
        and(
          eq(fileIngests.id, accessKeyId),
          eq(fileIngests.source, 'recording'),
          // A recording already received still accepts SIDE objects: an egress
          // uploads its manifest after the file. The main object is refused
          // once received (`beginReceiving`).
          inArray(fileIngests.status, ['awaiting_upload', 'receiving', 'verifying', 'completed']),
          sql`${fileIngests.expiresAt} > now()`,
        ),
      )
      .limit(1);
    const row = found?.row;
    if (!row?.secretCiphertext) return null;
    return { row, secret: openSecret(row.secretCiphertext, secretContext(row.id)) };
  }

  /** Whether `objectName` is the target's main object (anything else under its prefix is a side object). */
  private classifyObject(
    row: FileIngestRow,
    objectName: string,
  ): { kind: 'main'; ext: string } | { kind: 'side' } {
    const prefix = `${row.id}/`;
    if (!objectName.startsWith(prefix) || objectName.includes('..') || objectName.length > 512) {
      throw new ApiError(403, 'This key is outside the recording target', 'AccessDenied');
    }
    const rest = objectName.slice(prefix.length);
    const dot = rest.lastIndexOf('.');
    const ext = dot > 0 ? rest.slice(dot + 1).toLowerCase() : '';
    if (ext === 'json' || ext === 'txt') return { kind: 'side' };
    if (row.objectName && row.objectName !== objectName) {
      throw new ApiError(403, 'This target accepts one recording', 'AccessDenied');
    }
    return { kind: 'main', ext };
  }

  /** The recording's media type: the client's, else from its extension; audio or video only. */
  private recordingType(contentType: string | undefined, ext: string): string {
    const declared = (contentType ?? '').split(';')[0].trim().toLowerCase();
    const type =
      declared.startsWith('audio/') || declared.startsWith('video/')
        ? declared
        : RECORDING_EXTENSION_TYPES[ext];
    if (!type) {
      throw new ApiError(415, 'A recording must be audio or video', 'UNSUPPORTED_MEDIA_TYPE');
    }
    return type;
  }

  /** Consume a side object (a manifest): bounded, discarded. Returns its MD5 ETag. */
  private async discardSideObject(body: Readable): Promise<string> {
    const md5 = crypto.createHash('md5');
    let size = 0;
    for await (const chunk of body as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > RECORDING_SIDE_OBJECT_MAX_BYTES) {
        throw new ApiError(400, 'Side objects are limited to 1 MiB', 'EntityTooLarge');
      }
      md5.update(chunk);
    }
    return `"${md5.digest('hex')}"`;
  }

  /** Move a target to `receiving` for `objectName`, fixing its staging key and type. */
  private async beginReceiving(
    row: FileIngestRow,
    objectName: string,
    mime: string,
    ext: string,
  ): Promise<FileIngestRow> {
    const storedExt = storedExtensionFor(mime, ext ? `recording.${ext}` : null);
    const [updated] = await getDb()
      .update(fileIngests)
      .set({
        status: 'receiving',
        objectName,
        mime,
        ext: storedExt,
        stagingKey: row.stagingKey ?? this.stagingKeyFor(row.id, storedExt),
      })
      .where(
        and(
          eq(fileIngests.id, row.id),
          inArray(fileIngests.status, ['awaiting_upload', 'receiving']),
          or(isNull(fileIngests.objectName), eq(fileIngests.objectName, objectName)),
        ),
      )
      .returning();
    if (!updated)
      throw new ApiError(409, 'The recording target is no longer open', 'InvalidRequest');
    return updated;
  }

  /**
   * `PutObject`: the main object streamed to staging and hashed on the way,
   * then verified; a side object is discarded. Returns the ETag to answer.
   */
  async putRecordingObject(row: FileIngestRow, write: RecordingObjectWrite): Promise<string> {
    const object = this.classifyObject(row, write.objectName);
    if (object.kind === 'side') return this.discardSideObject(write.body);
    if (write.contentLength !== undefined && write.contentLength > row.maxBytes) {
      throw new ApiError(400, "The recording exceeds the target's maximum size", 'EntityTooLarge');
    }
    const mime = this.recordingType(write.contentType, object.ext);
    const receiving = await this.beginReceiving(row, write.objectName, mime, object.ext);
    if (receiving.s3UploadId) {
      await this.s3
        .abortMultipartUpload(receiving.stagingKey as string, receiving.s3UploadId)
        .catch(() => undefined);
      await getDb().update(fileIngests).set({ s3UploadId: null }).where(eq(fileIngests.id, row.id));
    }
    const sha = crypto.createHash('sha256');
    const md5 = crypto.createHash('md5');
    let size = 0;
    const maxBytes = row.maxBytes;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) {
          callback(
            new ApiError(400, "The recording exceeds the target's maximum size", 'EntityTooLarge'),
          );
          return;
        }
        sha.update(chunk);
        md5.update(chunk);
        callback(null, chunk);
      },
    });
    write.body.on('error', (error) => meter.destroy(error));
    await this.s3.uploadStream(receiving.stagingKey as string, write.body.pipe(meter), {
      contentType: mime,
      cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
    });
    if (size === 0) {
      await this.s3.deleteFile(receiving.stagingKey as string).catch(() => undefined);
      throw new ApiError(400, 'A recording cannot be empty', 'InvalidRequest');
    }
    await this.markVerifying(receiving, { size, sha256: sha.digest('hex') });
    return `"${md5.digest('hex')}"`;
  }

  /** `CreateMultipartUpload` for the main object; a retry replaces an earlier one. */
  async createRecordingMultipart(
    row: FileIngestRow,
    objectName: string,
    contentType: string | undefined,
  ): Promise<string> {
    const object = this.classifyObject(row, objectName);
    if (object.kind === 'side') {
      throw new ApiError(400, 'Side objects must be uploaded whole', 'InvalidRequest');
    }
    const mime = this.recordingType(contentType, object.ext);
    const receiving = await this.beginReceiving(row, objectName, mime, object.ext);
    const stagingKey = receiving.stagingKey as string;
    const uploadId = await this.s3.createMultipartUpload(stagingKey, {
      contentType: mime,
      cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
    });
    const [updated] = await getDb()
      .update(fileIngests)
      .set({ s3UploadId: uploadId })
      .where(and(eq(fileIngests.id, row.id), eq(fileIngests.status, 'receiving')))
      .returning({ id: fileIngests.id });
    if (!updated) {
      await this.s3.abortMultipartUpload(stagingKey, uploadId).catch(() => undefined);
      throw new ApiError(409, 'The recording target is no longer open', 'InvalidRequest');
    }
    if (receiving.s3UploadId && receiving.s3UploadId !== uploadId) {
      await this.s3.abortMultipartUpload(stagingKey, receiving.s3UploadId).catch(() => undefined);
    }
    return uploadId;
  }

  private requireUpload(row: FileIngestRow, objectName: string, uploadId: string): string {
    if (row.status !== 'receiving' || !row.s3UploadId || row.s3UploadId !== uploadId) {
      throw new ApiError(404, 'The specified multipart upload does not exist', 'NoSuchUpload');
    }
    if (row.objectName !== objectName) {
      throw new ApiError(404, 'The specified multipart upload does not exist', 'NoSuchUpload');
    }
    return row.stagingKey as string;
  }

  /** `UploadPart`: the part streamed straight to the backing multipart upload. */
  async uploadRecordingPart(
    row: FileIngestRow,
    objectName: string,
    uploadId: string,
    partNumber: number,
    body: Readable,
    contentLength: number,
  ): Promise<string> {
    const stagingKey = this.requireUpload(row, objectName, uploadId);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
      throw new ApiError(
        400,
        'Part number must be an integer between 1 and 10000',
        'InvalidArgument',
      );
    }
    if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > row.maxBytes) {
      throw new ApiError(400, 'The part is too large', 'EntityTooLarge');
    }
    let seen = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        seen += chunk.length;
        if (seen > contentLength) {
          callback(new ApiError(400, 'The part is longer than declared', 'IncompleteBody'));
          return;
        }
        callback(null, chunk);
      },
    });
    body.on('error', (error) => meter.destroy(error));
    const { etag } = await this.s3.uploadPart(
      stagingKey,
      uploadId,
      partNumber,
      body.pipe(meter),
      contentLength,
    );
    return etag;
  }

  /**
   * `CompleteMultipartUpload`: the parts the client lists must be the parts
   * storage holds (same ETags), within the target's size; then the object is
   * assembled and verified (hashed by reading it back) in the background.
   */
  async completeRecordingMultipart(
    row: FileIngestRow,
    objectName: string,
    uploadId: string,
    listed: { partNumber: number; etag: string }[],
  ): Promise<string> {
    const stagingKey = this.requireUpload(row, objectName, uploadId);
    const held = await this.s3.listParts(stagingKey, uploadId);
    if (!held)
      throw new ApiError(404, 'The specified multipart upload does not exist', 'NoSuchUpload');
    const byNumber = new Map(held.map((part) => [part.partNumber, part]));
    const unquote = (etag: string) => etag.replace(/^"|"$/g, '');
    let previous = 0;
    let size = 0;
    const parts: { partNumber: number; etag: string }[] = [];
    for (const part of listed) {
      const stored = byNumber.get(part.partNumber);
      if (part.partNumber <= previous) {
        throw new ApiError(400, 'Parts must be listed in ascending order', 'InvalidPartOrder');
      }
      if (!stored || unquote(stored.etag) !== unquote(part.etag)) {
        throw new ApiError(400, 'A listed part was not uploaded', 'InvalidPart');
      }
      previous = part.partNumber;
      size += stored.size;
      parts.push({ partNumber: stored.partNumber, etag: stored.etag });
    }
    if (parts.length === 0) throw new ApiError(400, 'No parts were listed', 'MalformedXML');
    if (size > row.maxBytes) {
      await this.s3.abortMultipartUpload(stagingKey, uploadId).catch(() => undefined);
      await this.fail(row, {
        code: 'PAYLOAD_TOO_LARGE',
        message: "The recording exceeds the target's maximum size",
      });
      throw new ApiError(400, "The recording exceeds the target's maximum size", 'EntityTooLarge');
    }
    await this.s3.completeMultipartUpload(stagingKey, uploadId, parts);
    await this.markVerifying(row, { size, sha256: null });
    const md5 = crypto.createHash('md5');
    for (const part of parts) md5.update(Buffer.from(unquote(part.etag), 'hex'));
    return `"${md5.digest('hex')}-${parts.length}"`;
  }

  /** `AbortMultipartUpload`: the target goes back to waiting for its recording. */
  async abortRecordingMultipart(
    row: FileIngestRow,
    objectName: string,
    uploadId: string,
  ): Promise<void> {
    const stagingKey = this.requireUpload(row, objectName, uploadId);
    await this.s3.abortMultipartUpload(stagingKey, uploadId);
    await getDb()
      .update(fileIngests)
      .set({ s3UploadId: null })
      .where(and(eq(fileIngests.id, row.id), eq(fileIngests.s3UploadId, uploadId)));
  }

  /** The object is complete: verify (and finalize) in the background. */
  private async markVerifying(
    row: FileIngestRow,
    received: { size: number; sha256: string | null },
  ): Promise<void> {
    const [verifying] = await getDb()
      .update(fileIngests)
      .set({
        status: 'verifying',
        size: received.size,
        sha256: received.sha256,
        s3UploadId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(and(eq(fileIngests.id, row.id), eq(fileIngests.status, 'receiving')))
      .returning();
    if (!verifying) return;
    logger.info('Recording received', { targetId: row.id, size: received.size });
    void this.verify(verifying.id).catch((error) => {
      logger.error('Recording verification failed unexpectedly', {
        targetId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * The creator's `complete`: idempotent. Not yet received → 409
   * `RECORDING_NOT_RECEIVED`; verifying → waits up to
   * {@link RECORDING_COMPLETE_WAIT_MS}; the outcome as it stands.
   */
  async completeRecording(row: FileIngestRow): Promise<FileIngestRow> {
    if (row.status === 'awaiting_upload' || row.status === 'receiving') {
      throw new ApiError(
        409,
        'Nothing has been recorded into this target yet',
        'RECORDING_NOT_RECEIVED',
      );
    }
    // Verify here unless another verifier holds it, and wait for whichever
    // does, up to the bound; then the outcome as it stands.
    const deadline = Date.now() + RECORDING_COMPLETE_WAIT_MS;
    let current = row;
    while (current.status === 'verifying' && Date.now() < deadline) {
      await Promise.race([
        this.verify(current.id).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())).unref?.()),
      ]);
      current = await this.reload(row.id);
      if (current.status === 'verifying') {
        await new Promise((resolve) => setTimeout(resolve, 200).unref?.());
      }
    }
    return this.reload(row.id);
  }

  /** Abort an open ingest: its multipart upload and staging object go. Verifying is too late (409). */
  async abort(row: FileIngestRow): Promise<FileIngestRow> {
    if (row.status === 'verifying') throw new ConflictError('This recording is being verified');
    if (row.status === 'awaiting_upload' || row.status === 'receiving') {
      await this.discardStaging(row);
      await this.finish(row, 'aborted', { code: 'ABORTED', message: 'Aborted by its creator' });
    }
    return this.reload(row.id);
  }

  // -------------------------------------------------------------------------
  // Verification and finalization
  // -------------------------------------------------------------------------

  /**
   * Verify one `verifying` ingest under a lease: hash the staging object when
   * its hash is not known yet (a recording assembled from parts), then
   * finalize. Returns without doing anything when another task holds it.
   */
  async verify(id: string): Promise<void> {
    const [row] = await getDb()
      .update(fileIngests)
      .set({
        leaseOwner: LEASE_OWNER,
        leaseExpiresAt: sql`now() + make_interval(secs => greatest(600, coalesce(${fileIngests.size}, 0) / ${VERIFY_BYTES_PER_SECOND}))`,
        attempts: sql`${fileIngests.attempts} + 1`,
      })
      .where(
        and(
          eq(fileIngests.id, id),
          eq(fileIngests.status, 'verifying'),
          // One verifier at a time, this task's own concurrent attempts
          // included: a second would finalize the same bytes twice.
          or(isNull(fileIngests.leaseExpiresAt), lt(fileIngests.leaseExpiresAt, sql`now()`)),
        ),
      )
      .returning();
    if (!row) return;
    let current = row;
    if (!current.sha256) {
      try {
        const { body } = await this.s3.getObjectStreamRange(current.stagingKey as string);
        const hash = crypto.createHash('sha256');
        let size = 0;
        for await (const chunk of body as AsyncIterable<Buffer>) {
          size += chunk.length;
          hash.update(chunk);
        }
        if (size === 0) {
          await this.fail(current, { code: 'EMPTY_RECORDING', message: 'The recording is empty' });
          return;
        }
        const [hashed] = await getDb()
          .update(fileIngests)
          .set({ sha256: hash.digest('hex'), size })
          .where(eq(fileIngests.id, current.id))
          .returning();
        current = hashed ?? current;
      } catch (error) {
        await this.retryLater(current, error);
        return;
      }
    }
    await this.finalize(current);
  }

  /** Make a received, hashed ingest its owner's file, then its reference, grant and provenance. */
  private async finalize(row: FileIngestRow): Promise<void> {
    let stored: { file: FileRecord; deduplicated: boolean };
    try {
      stored = await this.assets.finalizeLargeUpload({
        owner: ingestOwnerColumns(row),
        sha256: row.sha256 as string,
        size: row.size as number,
        mime: row.mime as string,
        ext: row.ext ?? '',
        originalName: row.originalName,
        visibility: row.visibility,
        metadata: {
          ...(row.metadata ?? {}),
          serviceAppId: row.creatorApplicationId,
          upload: row.source,
          ...(row.source === 'import' ? { source: 'import', sourceHost: row.sourceHost } : {}),
        },
        stagingKey: row.stagingKey as string,
        reservationId: null,
      });
    } catch (error) {
      if (isTerminalFinalizeError(error)) {
        const fields = errorFields(error);
        await this.discardStaging(row);
        await this.finish(row, 'failed', {
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

    // A person's file: the creator stored it for them, and may read it back.
    if (row.kind === 'account') await grantUploadAccess(stored.file.id, row.creatorApplicationId);
    if (row.source === 'import') await this.recordSource(row, stored.file);
    const reference = await this.addReference(row, stored.file.id);
    await getDb()
      .update(fileIngests)
      .set({
        status: 'completed',
        fileId: stored.file.id,
        deduplicated: stored.deduplicated,
        referenceResult: reference ?? null,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      })
      .where(and(eq(fileIngests.id, row.id), eq(fileIngests.status, 'verifying')));
    logger.info('Ingest stored', {
      ingestId: row.id,
      source: row.source,
      fileId: stored.file.id,
      deduplicated: stored.deduplicated,
      size: row.size,
    });
  }

  /** The import's once-per-URL memory (ADR 0042 D7), as the synchronous import records it. */
  private async recordSource(row: FileIngestRow, file: FileRecord): Promise<void> {
    const url = openSecret(row.sourceUrlCiphertext as string, sourceContext(row.id));
    const owner =
      row.kind === 'application' ? `app:${row.ownerApplicationId}` : `user:${row.ownerUserId}`;
    const values = {
      ownerUserId: row.ownerUserId,
      ownerApplicationId: row.ownerApplicationId,
      sourceUrlSha256: row.sourceUrlSha256 as string,
      sourceHost: row.sourceHost as string,
      sourceUrlCiphertext: sealSecret(url, `file-source|${owner}|${row.sourceUrlSha256}`),
      fileId: file.id,
      etag: row.etag,
      lastModified: row.lastModified,
      contentSha256: file.sha256,
      fetchedAt: row.createdAt,
      lastStatus: 200,
    };
    const ownerColumn =
      row.kind === 'application' ? fileSources.ownerApplicationId : fileSources.ownerUserId;
    await getDb()
      .insert(fileSources)
      .values(values)
      .onConflictDoUpdate({
        target: [ownerColumn, fileSources.sourceUrlSha256],
        targetWhere:
          row.kind === 'application'
            ? sql`${fileSources.ownerApplicationId} is not null`
            : sql`${fileSources.ownerUserId} is not null`,
        set: {
          sourceHost: values.sourceHost,
          sourceUrlCiphertext: values.sourceUrlCiphertext,
          fileId: values.fileId,
          etag: values.etag,
          lastModified: values.lastModified,
          contentSha256: values.contentSha256,
          fetchedAt: values.fetchedAt,
          lastStatus: values.lastStatus,
        },
      });
  }

  /** `POST /assets/service/references`' rule, for the ingest's own reference. */
  private async addReference(
    row: FileIngestRow,
    fileId: string,
  ): Promise<'created' | 'exists' | 'not_found' | undefined> {
    if (!row.reference) return undefined;
    const file = await this.assets.getFile(fileId);
    if (!file || !mayApplicationReference(file, row.creatorApplicationId)) return 'not_found';
    const { created } = await this.assets.linkFile(file.id, {
      applicationId: row.creatorApplicationId,
      entityType: row.reference.entityType,
      entityId: row.reference.entityId,
      createdByUserId: null,
    });
    return created ? 'created' : 'exists';
  }

  /**
   * The worker's pass: verify what is due (a dead verifier's included),
   * re-fetch imports whose fetcher died, abort what expired. Bounded.
   */
  async sweep(
    refetch: ImportRefetch,
    limit = 20,
  ): Promise<{ verified: number; resumed: number; expired: number }> {
    const db = getDb();
    const leaseFree = or(
      isNull(fileIngests.leaseExpiresAt),
      lt(fileIngests.leaseExpiresAt, sql`now()`),
    );
    const verifying = await db
      .select({ id: fileIngests.id })
      .from(fileIngests)
      .where(and(eq(fileIngests.status, 'verifying'), leaseFree))
      .limit(limit);
    for (const { id } of verifying) await this.verify(id);

    const stalled = await db
      .select()
      .from(fileIngests)
      .where(
        and(
          eq(fileIngests.source, 'import'),
          eq(fileIngests.status, 'receiving'),
          leaseFree,
          sql`${fileIngests.expiresAt} > now()`,
        ),
      )
      .limit(limit);
    for (const row of stalled) await this.resumeImport(row, refetch);

    const stale = await db
      .select()
      .from(fileIngests)
      .where(
        and(
          inArray(fileIngests.status, ['awaiting_upload', 'receiving']),
          lt(fileIngests.expiresAt, sql`now()`),
          leaseFree,
        ),
      )
      .limit(limit);
    let expired = 0;
    for (const row of stale) {
      try {
        await this.discardStaging(row);
        if (await this.finish(row, 'aborted', { code: 'EXPIRED', message: 'The ingest expired' })) {
          expired++;
        }
      } catch (error) {
        logger.warn('Ingest: could not abort an expired ingest; will retry', {
          ingestId: row.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { verified: verifying.length, resumed: stalled.length, expired };
  }

  /** Delete what an unfinished ingest stored, but never an object a live row names. */
  private async discardStaging(row: FileIngestRow): Promise<void> {
    if (!row.stagingKey) return;
    if (row.s3UploadId) {
      await this.s3.abortMultipartUpload(row.stagingKey, row.s3UploadId).catch(() => undefined);
    }
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
        logger.warn('Ingest: could not delete a staging object', {
          ingestId: row.id,
          key,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    }
  }

  private async fail(row: FileIngestRow, error: { code: string; message: string }): Promise<void> {
    await this.discardStaging(row);
    await this.finish(row, 'failed', error);
    logger.warn('Ingest failed', { ingestId: row.id, source: row.source, code: error.code });
  }

  private async finish(
    row: FileIngestRow,
    status: 'failed' | 'aborted',
    error: { code: string; message: string },
  ): Promise<boolean> {
    const [done] = await getDb()
      .update(fileIngests)
      .set({
        status,
        errorCode: error.code,
        errorMessage: error.message.slice(0, 1000),
        s3UploadId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(fileIngests.id, row.id),
          inArray(fileIngests.status, [...OPEN_FILE_INGEST_STATUSES]),
        ),
      )
      .returning({ id: fileIngests.id });
    return done !== undefined;
  }

  /** A transient failure: free the lease for a later attempt (backing off), or fail after the last. */
  private async retryLater(row: FileIngestRow, error: unknown): Promise<void> {
    const fields = errorFields(error);
    if (row.attempts >= INGEST_MAX_ATTEMPTS) {
      await this.fail(row, fields);
      return;
    }
    logger.warn('Ingest will be retried', {
      ingestId: row.id,
      attempt: row.attempts,
      error: fields.message,
    });
    await getDb()
      .update(fileIngests)
      .set({
        leaseOwner: null,
        errorCode: fields.code,
        errorMessage: fields.message.slice(0, 1000),
        leaseExpiresAt: sql`now() + make_interval(mins => ${Math.max(row.attempts, 1)})`,
      })
      .where(
        and(eq(fileIngests.id, row.id), inArray(fileIngests.status, ['receiving', 'verifying'])),
      );
  }
}
