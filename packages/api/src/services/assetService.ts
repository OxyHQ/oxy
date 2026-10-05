import { assertPhysicalStoragePathSupported } from './storageQuota.service';
import { reserveStorageBytes, assertStorageReservationWritable } from './storageByteReservation.service';
import { createWriteStream, createReadStream } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipeline } from 'stream/promises';
import { loadProductBillingCatalogue } from './productBillingCatalogue.service';
import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import { Readable, Transform } from 'stream';
import { eq } from 'drizzle-orm';
import { normalizeInlineText } from '@oxy.so/core';
import { safeFetch, SsrfRejection, type SafeFetchResult } from '@oxy.so/core/server';
import type { S3Service } from './s3Service';
import {
  FEDERATION_MEDIA_CACHE_PURPOSE,
  isAllowedCacheMime,
} from '../constants/federationCache';
import { VariantService } from './variantService';
import { getDb, type Transaction } from '../config/postgres';
import { files as filesTable } from '../db/schema/files';
import { recordFileStorageDeletion, recordFileStorageRelocation } from './accountStorageDeletion.service';
import { runStorageDeletionBatch } from './accountStorageDeletion.worker';
import { withContentHashLock } from './contentHashLock';
import { enqueueAssetVariantGeneration } from '../queue/assetVariants.queue';
import {
  buildCdnUrl,
  cdnUrlForStorageKey,
  applyPublicPrefix,
  stripPublicPrefix,
  isPublicKey,
  storageKeyForVisibility,
  IMMUTABLE_ASSET_CACHE_CONTROL,
} from '../config/cdn';
import { logger } from '../utils/logger';
import { ApiError, ForbiddenError } from '../utils/error';
import type {
  AssetInitResponse,
  AssetCompleteRequest,
  AssetLinkRequest,
  AssetDeleteSummary,
} from '../types/asset.types';
import type {
  FileOwner,
  FilePurpose,
  FileRecord,
  FileVariantRecord,
  FileVisibility,
} from '../types/file.types';

import { mediaPrivacyService } from './mediaPrivacyService';
import type { MediaAccessContext } from '../types/mediaPrivacy.types';
import fileCache from '../utils/fileCache';
import { BadRequestError } from '../utils/error';
import { isDeclaredImageContentValid } from '../utils/imageContentSignature';
import {
  deleteFileLink,
  deleteVariant,
  findFileById,
  findFilesByIds,
  findLiveFileBySha256ForOwner,
  findLiveFilesBySha256,
  findLiveStorageSourceBySha256,
  insertFile,
  isStorageKeyUsedByOtherLiveRow,
  insertFileLink,
  isUniqueViolation,
  listFilesByOwner,
  classifyFederatedDeleteRefusal,
  tombstoneFederatedFileForApp,
  tombstoneFile,
  updateFile,
  updateVariantKey,
} from './fileRepository';

/**
 * A readable stream that may also emit the HTTP `'aborted'` event. Express
 * requests (`IncomingMessage`) are `Readable` AND emit `'aborted'` when the
 * client disconnects; `Readable`'s own typings do not declare that event, so
 * we widen the listener overloads here instead of casting.
 */
type AbortableReadable = Readable & {
  on(event: 'aborted', listener: () => void): AbortableReadable;
  removeListener(event: 'aborted', listener: () => void): AbortableReadable;
};

interface StreamedMediaOptions {
  owner: FileOwner;
  purpose: FilePurpose;
  visibility: FileVisibility;
  metadata: Record<string, unknown>;
  tempPrefix: string;
  logLabel: string;
  /**
   * `federated`: the owner's existing row for these bytes is reused only when it
   * is ALREADY this owner's federated media from this app (idempotent re-upload);
   * any other row of the same owner is refused. Otherwise the owner's existing
   * row is simply reused.
   */
  dedupeScope?: 'federated';
  /** `federated` scope only: the application uploading. */
  uploaderAppId?: string;
}

/** A streamed upload's stored row, and whether an EXISTING row was reused. */
export interface StreamedMediaResult {
  file: FileRecord;
  /**
   * True when no new row was created: THIS owner already held a live row for
   * these bytes and it was returned. Rows are per owner, so a reused row is
   * always the uploader's own — never another owner's — but it may already be
   * referenced elsewhere, so a caller must reference-check it before deleting.
   */
  deduplicated: boolean;
}

/**
 * The existing row is already this owner's federated media, uploaded by this
 * application — the only shape a federated re-upload may reuse. Every term is
 * one the federated delete route also requires, so a reused id is exactly one
 * the same caller could already delete.
 */
function isSameFederatedUpload(file: FileRecord, options: StreamedMediaOptions): boolean {
  const appId = options.uploaderAppId;
  return (
    typeof appId === 'string' &&
    appId.length > 0 &&
    file.purpose === 'user' &&
    file.ownerUserId !== null &&
    file.ownerUserId === options.owner.ownerUserId &&
    file.metadata?.source === 'federation' &&
    file.metadata?.serviceAppId === appId
  );
}

/** Outcome of {@link AssetService.deleteFederatedMediaForApp} for one id. */
export type FederatedMediaDeleteOutcome = 'deleted' | 'not_found' | 'in_use' | 'forbidden';

/** Lease owner for ledger rows a delete drains inline (the worker has its own). */
const STORAGE_DELETION_DRAIN_OWNER = `asset-delete:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

const FEDERATION_REPAIR_MAX_BYTES = 10 * 1024 * 1024;
const FEDERATION_REPAIR_MAX_REDIRECTS = 3;
const FEDERATION_REPAIR_USER_AGENT = 'OxyHQ/1.0 (Federation Asset Repair)';

/**
 * How long a repair whose remote bytes did not hash to the record's `sha256` is
 * refused without downloading again. The repair runs on public stream reads, so
 * without this every read of such an asset would re-download and re-hash a
 * source already known to be wrong. Bounded in time AND size: a mismatch is
 * never remembered as a success, and it expires so a remote that reverts to the
 * original bytes is repaired on a later read.
 */
const FEDERATION_REPAIR_MISMATCH_TTL_MS = 15 * 60 * 1000;
const FEDERATION_REPAIR_MISMATCH_MAX_ENTRIES = 1000;

/** fileId → the repair attempt in progress, shared by concurrent reads. */
const federationRepairsInFlight = new Map<string, Promise<boolean>>();

/** fileId → epoch ms until which a repair of that file is not re-attempted. */
const federationRepairMismatches = new Map<string, number>();

function isRecentFederationRepairMismatch(fileId: string): boolean {
  const until = federationRepairMismatches.get(fileId);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  federationRepairMismatches.delete(fileId);
  return false;
}

function recordFederationRepairMismatch(fileId: string): void {
  federationRepairMismatches.delete(fileId);
  if (federationRepairMismatches.size >= FEDERATION_REPAIR_MISMATCH_MAX_ENTRIES) {
    // Map iteration is insertion order, so the first key is the oldest entry.
    const oldest = federationRepairMismatches.keys().next().value;
    if (oldest !== undefined) federationRepairMismatches.delete(oldest);
  }
  federationRepairMismatches.set(fileId, Date.now() + FEDERATION_REPAIR_MISMATCH_TTL_MS);
}

/** Test seam: forget every remembered repair mismatch. */
export function clearFederationRepairMismatches(): void {
  federationRepairMismatches.clear();
}

/** The host of a repair URL, for logs: the full URL may carry credentials. */
function repairUrlHost(remoteUrl: string): string | null {
  try {
    return new URL(remoteUrl).host;
  } catch {
    return null;
  }
}

export class AssetService {
  private variantService: VariantService;

  constructor(private s3Service: S3Service) {
    this.variantService = new VariantService(s3Service);
  }

  /**
   * Batch reverse content-address lookup: resolve many content hashes to live
   * file records in a single query, used by the service-token
   * `POST /assets/service/by-sha256` route.
   *
   * With `ownerUserId`, only that account's own rows answer (at most one per
   * hash). Without it — the legacy form — the oldest live row of ANY owner
   * answers, which is a statement about the content, not a row the caller may
   * treat as its own. The result is unordered and may be shorter than the
   * input; unresolvable hashes are simply absent.
   */
  async findActiveFilesBySha256(sha256s: string[], options: { ownerUserId?: string } = {}): Promise<FileRecord[]> {
    return findLiveFilesBySha256(sha256s, options);
  }

  /**
   * Where a NEW row for these bytes keeps them, decided under the content-hash
   * lock: the key of a live row (of any owner) already holding the bytes in the
   * spelling `visibility` needs, else such a row's key re-spelled, else a fresh
   * content-addressed key. Rows are per owner; storage is shared.
   *
   * The returned key may not hold the object yet (a re-spelled key, or a source
   * row whose object is missing): the caller has the verified bytes and writes
   * them when absent — identical bytes, so a write to a shared key is harmless.
   */
  private async sharedStorageKeyFor(
    tx: Transaction,
    sha256: string,
    mime: string,
    visibility: FileVisibility,
  ): Promise<string> {
    const source = await findLiveStorageSourceBySha256(sha256, visibility, tx);
    return source
      ? this.targetKeyForVisibility(source.storageKey, visibility)
      : this.generateStorageKey(sha256, mime, visibility);
  }

  /**
   * The remote URL a missing federation asset may be re-fetched from, or `null`
   * when this asset is not a federation asset and must not be repaired from the
   * network.
   *
   * The first two branches used to compare `ownerUserId` against a sentinel
   * STRING stored in the same column that holds user ids; the sentinel now lives
   * in `files.system_owner`, so the namespace check is a real column comparison
   * against a closed set instead of a string convention.
   */
  private getFederationRepairRemoteUrl(file: FileRecord): string | null {
    const metadata = file.metadata ?? {};
    const remoteUrl = metadata.remoteUrl;
    if (typeof remoteUrl !== 'string' || remoteUrl.length === 0) {
      return null;
    }

    const isFederationAvatar = file.systemOwner === '__federation__'
      && metadata.source === 'federation'
      && metadata.role === 'avatar';
    const isFederationCache = file.systemOwner === '__federation_media_cache__'
      && file.purpose === FEDERATION_MEDIA_CACHE_PURPOSE;
    const isFederationMedia = metadata.source === 'federation'
      && file.visibility === 'public';

    return isFederationAvatar || isFederationCache || isFederationMedia ? remoteUrl : null;
  }

  /**
   * Read an {@link IncomingMessage} body into a Buffer, aborting (and destroying
   * the stream) the moment it would exceed `maxBytes`. Returns `null` when the
   * cap is exceeded. The caller short-circuits on the advertised
   * `content-length` before calling this; this is the streaming backstop for a
   * server that understated (or omitted) its length.
   */
  private readBodyLimited(response: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
    return new Promise<Buffer | null>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;

      const finish = (value: Buffer | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      response.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy();
          finish(null);
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(Buffer.concat(chunks, total)));
      response.on('error', (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      response.on('close', () => finish(null));
    });
  }

  /**
   * Fetch a remote federation image for storage repair through the shared,
   * DNS-pinned {@link safeFetch} (`@oxy.so/core/server`). safeFetch resolves the
   * host once, connects to the validated IP, re-validates every redirect hop,
   * and denies private/loopback/link-local/metadata IPs — closing the
   * DNS-rebinding TOCTOU window that a separate validate-then-`fetch` left open.
   * safeFetch does NOT bound the body, so we enforce the byte cap here.
   */
  private async fetchFederationRepairImage(remoteUrl: string): Promise<{ buffer: Buffer; mime: string } | null> {
    let url: URL;
    try {
      url = new URL(remoteUrl);
    } catch {
      return null;
    }
    // Logs carry the host only: the full URL may hold credentials.
    const remoteHost = url.host;
    if (url.protocol !== 'https:') {
      logger.warn('Federation repair URL rejected: non-https protocol', { remoteHost });
      return null;
    }

    let result: SafeFetchResult;
    try {
      result = await safeFetch(remoteUrl, {
        method: 'GET',
        maxRedirects: FEDERATION_REPAIR_MAX_REDIRECTS,
        headersTimeoutMs: 15_000,
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8',
          'User-Agent': FEDERATION_REPAIR_USER_AGENT,
        },
      });
    } catch (error) {
      if (error instanceof SsrfRejection) {
        logger.warn('Blocked unsafe federation repair URL', {
          remoteHost,
          reason: error.message,
        });
        return null;
      }
      logger.warn('Federation repair download failed', {
        remoteHost,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    const finalHost = repairUrlHost(result.finalUrl);
    try {
      if (result.status < 200 || result.status >= 300) {
        result.response.destroy();
        logger.warn('Federation repair download failed', {
          remoteHost: finalHost,
          status: result.status,
        });
        return null;
      }

      const rawContentTypeHeader = result.headers['content-type'];
      const rawContentType = Array.isArray(rawContentTypeHeader)
        ? rawContentTypeHeader[0] ?? ''
        : rawContentTypeHeader ?? '';
      const mime = rawContentType.split(';')[0].trim().toLowerCase();
      if (!mime.startsWith('image/') || !isAllowedCacheMime(mime)) {
        result.response.destroy();
        logger.warn('Federation repair rejected non-image content', {
          remoteHost: finalHost,
          contentType: rawContentType,
        });
        return null;
      }

      const declaredLengthHeader = result.headers['content-length'];
      const declaredLength = Number(
        Array.isArray(declaredLengthHeader) ? declaredLengthHeader[0] : declaredLengthHeader
      );
      if (Number.isFinite(declaredLength) && declaredLength > FEDERATION_REPAIR_MAX_BYTES) {
        result.response.destroy();
        logger.warn('Federation repair image is too large', {
          remoteHost: finalHost,
          declaredLength,
        });
        return null;
      }

      const buffer = await this.readBodyLimited(result.response, FEDERATION_REPAIR_MAX_BYTES);
      if (!buffer || buffer.length === 0) {
        logger.warn('Federation repair image has invalid size', {
          remoteHost: finalHost,
          size: buffer?.length ?? 0,
        });
        return null;
      }

      return { buffer, mime };
    } catch (error) {
      result.response.destroy();
      logger.warn('Federation repair download failed while reading body', {
        remoteHost: finalHost,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Publish a freshly-read record to the shared cache and hand it back. */
  private cacheFile(file: FileRecord): FileRecord {
    fileCache.invalidate(file.id);
    fileCache.set(file.id, file);
    return file;
  }

  private async restoreMissingDirectUploadContent(
    file: FileRecord,
    fileBuffer: Buffer,
    mimeType: string,
    logLabel: string,
  ): Promise<{ file: FileRecord; restored: boolean }> {
    if (await this.s3Service.fileExists(file.storageKey)) {
      return { file, restored: false };
    }

    logger.warn('Active file metadata points to a missing storage object; restoring from direct upload bytes', {
      fileId: file.id,
      sha256: file.sha256,
      storageKey: file.storageKey,
      logLabel,
    });

    if (file.ownerUserId && (await loadProductBillingCatalogue()).storageAdapter) {
      await reserveStorageBytes({ accountId: file.ownerUserId, sha256: file.sha256,
        objectKey: file.storageKey, size: fileBuffer.length, kind: 'server' });
    }
    await this.s3Service.uploadBuffer(file.storageKey, fileBuffer, {
      contentType: file.mime || mimeType,
      cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
    });

    if (file.size !== fileBuffer.length) {
      const updated = await updateFile(file.id, { size: fileBuffer.length });
      if (updated) {
        return { file: this.cacheFile(updated), restored: true };
      }
    }

    return { file: this.cacheFile(file), restored: true };
  }

  private async restoreMissingStreamedMediaContent(
    file: FileRecord,
    sourceKey: string,
    logLabel: string,
  ): Promise<boolean> {
    if (await this.s3Service.fileExists(file.storageKey)) {
      return false;
    }

    logger.warn('Active file metadata points to a missing storage object; restoring from streamed upload bytes', {
      fileId: file.id,
      sha256: file.sha256,
      storageKey: file.storageKey,
      sourceKey,
      logLabel,
    });

    await assertPhysicalStoragePathSupported(file.ownerUserId, 'stream key-spelling repair copy');
    await this.s3Service.copyFile(sourceKey, file.storageKey);
    this.cacheFile(file);
    return true;
  }

  /**
   * The uploader already holds a live row for these bytes (`existing` is always
   * the SAME owner's row — lookups are owner-scoped). Every scope reuses it,
   * except the federated one, which reuses only this owner's federated media
   * from this application: the per-owner unique leaves no second row to create,
   * and that id is not one this app may treat as its own (the federated delete
   * route would refuse it).
   */
  private assertStreamedDedupeAllowed(file: FileRecord, options: StreamedMediaOptions): void {
    if (options.dedupeScope === 'federated' && !isSameFederatedUpload(file, options)) {
      throw new ApiError(
        409,
        'This owner already holds this content as media from another application or source',
        'FEDERATED_MEDIA_OWNED_ELSEWHERE',
      );
    }
  }

  /** A reused federated row that had fallen to `trash` (unlinked) is in use again. */
  private async prepareExistingStreamedMediaFile(
    file: FileRecord,
    options: StreamedMediaOptions
  ): Promise<FileRecord> {
    if (file.status === 'trash' && isSameFederatedUpload(file, options)) {
      const reactivated = await updateFile(file.id, { status: 'active' });
      return reactivated ? this.cacheFile(reactivated) : file;
    }
    return file;
  }

  async ensureVariant(
    fileId: string,
    variantType: string,
    file?: FileRecord
  ): Promise<FileVariantRecord> {
    const fileObj = file ?? await this.getFile(fileId);
    if (!fileObj) {
      throw new Error('File not found');
    }

    const existing = fileObj.variants.find(v => v.type === variantType && v.readyAt);
    if (existing) {
      if (await this.s3Service.fileExists(existing.key)) {
        return existing;
      }

      logger.warn('Ready variant metadata points to a missing storage object; regenerating', {
        fileId: fileObj.id,
        variantType,
        key: existing.key,
      });
      await deleteVariant(fileObj.id, existing.type, existing.key);
      fileObj.variants = fileObj.variants.filter(v => v.id !== existing.id);
      fileCache.invalidate(fileObj.id);
    }

    if (fileObj.mime.startsWith('image/')) {
      return this.variantService.ensureImageVariant(fileObj, variantType);
    }

    if (fileObj.mime.startsWith('video/')) {
      if (variantType === 'poster') {
        const variant = await this.variantService.ensureVideoPoster(fileObj);
        return variant;
      }
      if (this.variantService.isVideoMp4Rendition(variantType)) {
        // MP4 renditions are generated during the trusted upload pipeline. Do
        // not generate a missing rendition here: ensureVariant is also reached
        // from unauthenticated public media routes, where transcoding on demand
        // would let arbitrary callers consume unbounded FFmpeg CPU and memory.
        throw new Error(`Video rendition ${variantType} is not available`);
      }
      // A SIZE name (`thumb`, `w320`, …) asked of a video means "an image of
      // this asset at that size", which for a video is a render of its poster
      // frame. Callers hold a bare file id and cannot know the mime — the URL
      // builder they use is synchronous and lexical — so refusing a size name
      // here is what turned every video thumbnail into a 404. A name that is
      // not a real size still throws, preserving the 404 for a bogus variant.
      const variant = await this.variantService.ensureVideoImageVariant(fileObj, variantType);
      return variant;
    }

    throw new Error(`Variant ${variantType} not supported for mime ${fileObj.mime}`);
  }

  /**
   * List files owned by a user (excluding deleted)
   */
  async listFilesByUser(
    userId: string,
    limit = 50,
    offset = 0
  ): Promise<{ files: FileRecord[]; total: number }> {
    try {
      return await listFilesByOwner(userId, limit, offset);
    } catch (error) {
      logger.error('Error listing files by user:', error);
      throw error;
    }
  }

  /**
   * Initialize a two-step upload: the caller's OWN row for these bytes and,
   * when the bytes still have to be written, a presigned PUT URL.
   *
   * - The caller already holds a live row for the hash → that row. A repair PUT
   *   URL is returned only when its object is missing AND no other live row
   *   stores its original at that key: a presigned PUT carries no content
   *   check, so signing a key other owners serve would let this caller replace
   *   their bytes.
   * - Another owner holds the bytes and the object exists → a NEW row for the
   *   caller pointing at the same object, and no upload URL: nothing to upload.
   * - Nobody holds them → a new row on a fresh content-addressed key and a PUT
   *   URL for it. When another owner's row holds the hash but its object is
   *   missing (e.g. its own PUT is still in flight), the caller gets a key of
   *   its own (`…/<sha>-<random>.<ext>`) rather than a PUT URL onto theirs.
   *
   * Never another owner's id: that handed their row, links and delete authority
   * to whoever uploaded the same bytes.
   */
  async initUpload(
    userId: string,
    expectedSha256: string,
    expectedSize: number,
    expectedMime: string
  ): Promise<AssetInitResponse> {
    const owner: FileOwner = { ownerUserId: userId, systemOwner: null };
    try {
      const own = await findLiveFileBySha256ForOwner(expectedSha256, owner);
      if (own) {
        return await this.initUploadForExistingOwnRow(own, userId, expectedMime);
      }

      const ext = this.getExtensionFromMime(expectedMime);
      let created: { file: FileRecord; needsUpload: boolean };
      try {
        // Under the content-hash lock: the choice of key, the copy that
        // re-spells a shared object, and the insert are one step against a
        // purge of the same bytes (`contentHashLock.ts`).
        created = await withContentHashLock(expectedSha256, async (tx) => {
          const source = await findLiveStorageSourceBySha256(expectedSha256, 'private', tx);
          let storageKey = this.generateStorageKey(expectedSha256, expectedMime);
          let needsUpload = true;
          if (source) {
            const shared = this.targetKeyForVisibility(source.storageKey, 'private');
            if (await this.s3Service.fileExists(shared)) {
              storageKey = shared;
              needsUpload = false;
            } else if (!(await loadProductBillingCatalogue()).storageAdapter && shared !== source.storageKey && await this.s3Service.fileExists(source.storageKey)) {
              await this.s3Service.copyFile(source.storageKey, shared);
              storageKey = shared;
              needsUpload = false;
            } else {
              storageKey = this.generateStorageKey(expectedSha256, expectedMime, 'private', crypto.randomBytes(8).toString('hex'));
            }
          }
          const file = await insertFile({
            sha256: expectedSha256,
            size: expectedSize,
            mime: expectedMime,
            ext,
            ...owner,
            status: 'active',
            storageKey,
          }, tx);
          return { file, needsUpload };
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // The same caller raced itself; its other request created the row.
        const raced = await findLiveFileBySha256ForOwner(expectedSha256, owner);
        if (!raced) throw error;
        return await this.initUploadForExistingOwnRow(raced, userId, expectedMime);
      }

      const upload = created.needsUpload
        ? await this.presignAdmittedUpload(created.file, expectedMime)
        : {uploadUrl: ''};

      logger.info('Asset upload initialized', {
        fileId: created.file.id,
        sha256: expectedSha256,
        storageKey: created.file.storageKey,
        sharedStorage: !created.needsUpload,
      });

      return {
        ...upload,
        fileId: created.file.id,
        sha256: expectedSha256
      };
    } catch (error) {
      logger.error('Error initializing asset upload:', error);
      throw new Error('Failed to initialize asset upload');
    }
  }

  private async presignAdmittedUpload(file: FileRecord, contentType: string): Promise<Pick<AssetInitResponse, 'uploadUrl' | 'requiredHeaders'>> {
    const configured = (await loadProductBillingCatalogue()).storageAdapter !== null;
    if (configured && (!Number.isSafeInteger(file.size) || file.size <= 0 || !/^[a-f0-9]{64}$/i.test(file.sha256)))
      throw new BadRequestError('Exact size and SHA-256 are required for admitted uploads');
    if (configured && file.ownerUserId) await reserveStorageBytes({ accountId: file.ownerUserId,
      sha256: file.sha256, objectKey: file.storageKey, size: file.size, kind: 'presigned',
      recoverAfter: new Date(Date.now() + 60_000) });
    const uploadUrl = await this.s3Service.getPresignedUploadUrl(file.storageKey, {
      contentType, expiresIn: configured ? 60 : 3600,
      ...(configured ? {contentLength:file.size, ifNoneMatch:'*' as const,
        checksumSHA256:Buffer.from(file.sha256,'hex').toString('base64')} : {}),
    });
    return {uploadUrl, ...(configured ? {requiredHeaders:{'If-None-Match':'*'}} : {})};
  }

  private async initUploadForExistingOwnRow(
    own: FileRecord,
    userId: string,
    expectedMime: string,
  ): Promise<AssetInitResponse> {
    let upload: Pick<AssetInitResponse, 'uploadUrl' | 'requiredHeaders'> = {uploadUrl: ''};
    if (!(await this.s3Service.fileExists(own.storageKey))) {
      if (await isStorageKeyUsedByOtherLiveRow(own.sha256, own.storageKey, own.id)) {
        logger.warn('Own asset row has no storage object, but its key is shared; not returning a repair URL', {
          fileId: own.id,
          sha256: own.sha256,
          storageKey: own.storageKey,
          requesterUserId: userId,
        });
      } else {
        logger.warn('Existing asset record has no storage object; returning upload URL for the existing key', {
          fileId: own.id,
          sha256: own.sha256,
          storageKey: own.storageKey,
        });
        upload = await this.presignAdmittedUpload(own, expectedMime);
      }
    }

    logger.info('File already exists for this owner, returning it', {
      sha256: own.sha256,
      fileId: own.id
    });

    return { ...upload, fileId: own.id, sha256: own.sha256 };
  }

  /**
   * Upload file directly - calculates SHA256 on backend.
   *
   * Returns the caller's OWN row: the existing one when it already holds these
   * bytes, otherwise a new one. A new row shares the stored object of any other
   * owner's row for the same bytes instead of storing them again; the bytes
   * were hashed here, so writing them to a shared key when it is missing
   * restores it for everyone.
   */
  async uploadFileDirect(
    userId: string,
    fileBuffer: Buffer,
    mimeType: string,
    originalName: string,
    visibility?: FileVisibility,
    metadata?: Record<string, unknown>
  ): Promise<FileRecord> {
    try {
      // Calculate SHA256 hash on backend
      const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      const size = fileBuffer.length;

      // Defense-in-depth: never persist a 0-byte asset. Protects every caller of
      // uploadFileDirect, not just the route. Mirrors the federation stream
      // path's empty-buffer guard.
      if (size === 0) {
        throw new BadRequestError('Cannot store an empty file');
      }

      // Defense-in-depth: reject content declared as an image whose bytes are
      // not actually an image (e.g. a serialized {uri} descriptor from a broken
      // web client). Non-zero garbage slips past the 0-byte guard otherwise.
      if (!isDeclaredImageContentValid(fileBuffer, mimeType)) {
        throw new BadRequestError('Uploaded file content does not match the declared image type');
      }

      const owner: FileOwner = { ownerUserId: userId, systemOwner: null };
      const own = await findLiveFileBySha256ForOwner(sha256, owner);
      if (own) {
        return await this.returnExistingDirectUpload(own, fileBuffer, mimeType, 'direct upload');
      }

      const ext = this.getExtensionFromMime(mimeType);
      const resolvedVisibility: FileVisibility = visibility || 'private';

      let file: FileRecord;
      try {
        // Under the content-hash lock: the key is chosen and the row inserted
        // as one step; the object is written after the row, so a purge either
        // saw this row (and kept the key) or finished first.
        file = await withContentHashLock(sha256, async (tx) => insertFile({
          sha256,
          size,
          mime: mimeType,
          ext,
          ...owner,
          status: 'active',
          storageKey: await this.sharedStorageKeyFor(tx, sha256, mimeType, resolvedVisibility),
          originalName: normalizeInlineText(originalName),
          visibility: resolvedVisibility,
          metadata: metadata ?? {},
        }, tx));
      } catch (error) {
        if (isUniqueViolation(error)) {
          // The same caller raced itself; its other request created the row.
          const raced = await findLiveFileBySha256ForOwner(sha256, owner);
          if (raced) {
            return await this.returnExistingDirectUpload(raced, fileBuffer, mimeType, 'direct upload duplicate race');
          }
        }
        throw error;
      }

      if (!(await this.s3Service.fileExists(file.storageKey))) {
        if ((await loadProductBillingCatalogue()).storageAdapter) await reserveStorageBytes({
          accountId: userId, sha256: file.sha256, objectKey: file.storageKey, size: fileBuffer.length, kind: 'server' });
        await this.s3Service.uploadBuffer(file.storageKey, fileBuffer, {
          contentType: mimeType,
          cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
        });
      }

      // Renditions: copied from a live twin of the same spelling when one has
      // them, generated otherwise (`variantService.generateVariants`).
      this.queueVariantGeneration(file);

      logger.info('File uploaded directly', {
        fileId: file.id,
        sha256,
        size,
        originalName
      });

      return file;
    } catch (error) {
      logger.error('Error uploading file directly:', error);
      throw error;
    }
  }

  /** The caller's own existing row, with its object restored from these (hashed) bytes if missing. */
  private async returnExistingDirectUpload(
    own: FileRecord,
    fileBuffer: Buffer,
    mimeType: string,
    logLabel: string,
  ): Promise<FileRecord> {
    const { file, restored } = await this.restoreMissingDirectUploadContent(own, fileBuffer, mimeType, logLabel);
    if (restored) {
      this.queueVariantGeneration(file);
    }
    logger.info('File already exists for this owner, returning it', { sha256: file.sha256, fileId: file.id, logLabel });
    return file;
  }

  /**
   * Stream a remote/federated media file into the reserved cache namespace.
   *
   * Unlike {@link uploadFileDirect}, the bytes are never buffered in memory:
   * the source stream is piped to S3 via the multipart `Upload` manager while
   * a parallel hash computes the SHA-256 for content addressing and dedup.
   *
   * Hardening: the asset is force-owned by the `__federation_media_cache__`
   * system namespace and stamped with {@link FEDERATION_MEDIA_CACHE_PURPOSE};
   * callers cannot override the owner or purpose. Visibility is `public` so the
   * existing public download/stream routes can serve cached media without auth.
   *
   * Abort handling: when the client disconnects or the request times out the
   * source emits `'aborted'`/`'close'` before completion. We abort the in-flight
   * S3 multipart upload and delete the partial temp object so a cancelled
   * upload never leaks orphaned parts.
   *
   * @throws if more than `maxBytes` are streamed (the partial S3 object is
   *         cleaned up before the error propagates).
   */
  async uploadCachedMediaStream(
    source: AbortableReadable,
    mimeType: string,
    originalName: string,
    maxBytes: number
  ): Promise<FileRecord> {
    return this.uploadStreamedMedia(source, mimeType, originalName, maxBytes, {
      owner: { ownerUserId: null, systemOwner: '__federation_media_cache__' },
      purpose: FEDERATION_MEDIA_CACHE_PURPOSE,
      visibility: 'public',
      metadata: {},
      tempPrefix: 'cache/incoming',
      logLabel: 'Cached media',
    });
  }

  /**
   * Stream a federated media file into normal, durable public asset storage owned
   * by the resolved federated Oxy user. This is intentionally NOT tagged as
   * federation-media-cache, so the cache eviction job can never delete post media
   * referenced by persisted Mention posts.
   */
  async uploadFederatedMediaStream(
    source: AbortableReadable,
    mimeType: string,
    originalName: string,
    maxBytes: number,
    ownerUserId: string,
    uploaderAppId: string,
    metadata?: Record<string, unknown>
  ): Promise<StreamedMediaResult> {
    return this.uploadStreamedMediaDetailed(source, mimeType, originalName, maxBytes, {
      owner: { ownerUserId, systemOwner: null },
      purpose: 'user',
      visibility: 'public',
      // `source` and `serviceAppId` come LAST so caller-supplied metadata cannot
      // replace them: they are what the idempotent re-upload and the federated
      // delete route both recognise this row by.
      metadata: {
        ...(metadata ?? {}),
        source: 'federation',
        serviceAppId: uploaderAppId,
      },
      tempPrefix: 'federation/incoming',
      logLabel: 'Federated media',
      dedupeScope: 'federated',
      uploaderAppId,
    });
  }

  /**
   * Stream-upload durable media owned by a local Oxy user. Used when a backend
   * service (e.g. Mention MCP intent-media) holds a service token but must
   * attribute the asset to the requesting user.
   */
  async uploadUserMediaStream(
    source: AbortableReadable,
    mimeType: string,
    originalName: string,
    maxBytes: number,
    ownerUserId: string,
    metadata?: Record<string, unknown>
  ): Promise<FileRecord> {
    return this.uploadStreamedMedia(source, mimeType, originalName, maxBytes, {
      owner: { ownerUserId, systemOwner: null },
      purpose: 'user',
      visibility: 'public',
      metadata: {
        source: 'mention-service',
        ...(metadata ?? {}),
      },
      tempPrefix: 'user/incoming',
      logLabel: 'User media',
    });
  }

  /**
   * Store one of a sticker's files — its Lottie animation or its static
   * fallback — in the `__stickers__` namespace. Public and content-addressed,
   * so the CDN serves it forever; the caller has already validated the bytes
   * (`stickerValidation.ts`), which is why this takes a buffer rather than a
   * stream.
   */
  async uploadStickerFile(buffer: Buffer, mimeType: string, originalName: string): Promise<FileRecord> {
    return this.uploadStreamedMedia(Readable.from(buffer), mimeType, originalName, buffer.length, {
      owner: { ownerUserId: null, systemOwner: '__stickers__' },
      purpose: 'sticker',
      visibility: 'public',
      metadata: {},
      tempPrefix: 'stickers/incoming',
      logLabel: 'Sticker file',
    });
  }

  private async uploadStreamedMedia(
    source: AbortableReadable,
    mimeType: string,
    originalName: string,
    maxBytes: number,
    options: StreamedMediaOptions
  ): Promise<FileRecord> {
    return (await this.uploadStreamedMediaDetailed(source, mimeType, originalName, maxBytes, options)).file;
  }

  /** Stage owner streams on local disk; no bucket multipart bytes precede quota admission. */
  private async uploadAdmittedOwnerStream(source: AbortableReadable, mimeType: string,
    originalName: string, maxBytes: number, options: StreamedMediaOptions): Promise<StreamedMediaResult> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)
      throw new BadRequestError('Stream size limit must be a positive safe integer');
    const directory = await mkdtemp(join(tmpdir(), 'oxy-admitted-media-'));
    const staged = join(directory, 'source');
    let size = 0;
    const hash = crypto.createHash('sha256');
    const meter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > maxBytes) return callback(new ApiError(413, 'Stream exceeds its size limit', 'STORAGE_STREAM_TOO_LARGE'));
      hash.update(chunk); callback(null, chunk);
    } });
    let writtenKey: string | undefined;
    let committed = false;
    try {
      await pipeline(source, meter, createWriteStream(staged, { flags: 'wx' }));
      if (!size) throw new BadRequestError('Cannot store an empty file');
      const sha256 = hash.digest('hex');
      const own = await findLiveFileBySha256ForOwner(sha256, options.owner);
      if (own) {
        this.assertStreamedDedupeAllowed(own, options);
        if (!(await this.s3Service.fileExists(own.storageKey)))
          throw new ApiError(409, 'Existing stream object needs repair before reuse', 'STORAGE_STREAM_REPAIR_REQUIRED');
        return { file: await this.prepareExistingStreamedMediaFile(own, options), deduplicated: true };
      }
      const ext = this.getExtensionFromMime(mimeType);
      const key = `${this.generateStorageKey(sha256, mimeType, options.visibility)}.${crypto.randomUUID()}`;
      const reservation = await reserveStorageBytes({ accountId: options.owner.ownerUserId!, sha256,
        objectKey: key, size, kind: 'server' });
      const file = await withContentHashLock(sha256, async tx => {
        await assertStorageReservationWritable(tx, reservation.id);
        // insertFile locks account quota, checks actual bytes, then returns.
        // Its lock remains held by this transaction throughout multipart PUT.
        const admitted = await insertFile({ sha256, size, mime: mimeType, ext,
          ...options.owner, purpose: options.purpose, status: 'active', storageKey: key,
          originalName: normalizeInlineText(originalName), visibility: options.visibility,
          metadata: options.metadata }, tx);
        writtenKey = key;
        await this.s3Service.uploadStream(key, createReadStream(staged), {
          contentType: mimeType, cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
        });
        return admitted;
      });
      committed = true;
      this.queueVariantGeneration(file);
      return { file, deduplicated: false };
    } catch (error) {
      if (writtenKey && !committed) await this.s3Service.deleteFile(writtenKey);
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async uploadStreamedMediaDetailed(
    source: AbortableReadable,
    mimeType: string,
    originalName: string,
    maxBytes: number,
    options: StreamedMediaOptions
  ): Promise<StreamedMediaResult> {
    if (options.owner.ownerUserId && (await loadProductBillingCatalogue()).storageAdapter)
      return this.uploadAdmittedOwnerStream(source, mimeType, originalName, maxBytes, options);
    const hash = crypto.createHash('sha256');
    let size = 0;

    // Insert a hashing + byte-cap stage directly into the pipeline. Because it
    // is part of the pipe chain, S3 backpressure naturally throttles the
    // source, every byte is hashed exactly once in order, and exceeding the
    // cap destroys the chain so the upload aborts instead of buffering.
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) {
          const error = new Error('Cached media exceeds the maximum allowed size');
          error.name = 'CacheMediaTooLargeError';
          callback(error);
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    source.on('error', (err) => {
      meter.destroy(err instanceof Error ? err : new Error(String(err)));
    });
    const body = source.pipe(meter);

    // Stream first into a temporary key — the content-addressed key is only
    // known once the full SHA-256 is computed.
    const tempKey = `${options.tempPrefix}/${crypto.randomUUID()}`;

    // Wire client/timeout abort: cancel the S3 upload and drop the temp object
    // if the request is torn down before the upload finishes. `completed`
    // guards against the handlers firing cleanup after a successful upload.
    const abortController = new AbortController();
    let completed = false;
    const onSourceAbort = (): void => {
      // 'close' also fires on normal completion (after the body is fully read);
      // only treat it as a client/timeout abort if the stream did NOT end cleanly.
      if (!completed && !source.readableEnded) {
        abortController.abort();
      }
    };
    source.on('aborted', onSourceAbort);
    source.on('close', onSourceAbort);

    const deleteTempKey = async (reason: string): Promise<void> => {
      try {
        await this.s3Service.deleteFile(tempKey);
      } catch (cleanupError) {
        logger.warn(reason, {
          tempKey,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
    };

    try {
      // The temp key itself is a uuid and is deleted moments later, but the
      // promotion below is a server-side `CopyObject` with the default
      // `MetadataDirective: COPY` — so the content-addressed object inherits
      // whatever `Cache-Control` this PUT stored. Setting it here is what makes
      // the promoted object immutable to caches.
      await this.s3Service.uploadStream(tempKey, body, {
        contentType: mimeType,
        cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
        abortSignal: abortController.signal,
      });
      completed = true;
    } catch (error) {
      // Best-effort cleanup of any partial multipart object (thrown error,
      // size-cap breach, or client/timeout abort all land here).
      await deleteTempKey('Failed to clean up partial cache upload');
      source.removeListener('aborted', onSourceAbort);
      source.removeListener('close', onSourceAbort);
      throw error;
    }

    source.removeListener('aborted', onSourceAbort);
    source.removeListener('close', onSourceAbort);

    const sha256 = hash.digest('hex');

    // Dedup, per OWNER: the uploader's own live row for these bytes is reused
    // and the temp object dropped. Another owner's row is never returned — the
    // uploader gets its own row below, sharing that row's stored object.
    const own = await findLiveFileBySha256ForOwner(sha256, options.owner);
    if (own) {
      return this.reuseOwnStreamedMedia(own, tempKey, options, deleteTempKey, '');
    }

    // Promote the temp object to the content-addressed key (server-side copy,
    // no RAM) unless a live row of another owner already stores these bytes in
    // the spelling this row needs — then the new row shares that object. The
    // key's spelling follows visibility (`generateStorageKey` /
    // `targetKeyForVisibility`): federation and cache media is `public`, so it
    // lands under the CDN-reachable `public/` prefix.
    const ext = this.getExtensionFromMime(mimeType);

    // `visibility: 'public'` is an app-level ACL meaning "served without a user
    // session via the presigned-redirect stream route (GET /:id/stream)". It is
    // NOT an S3 ACL: the underlying object stays bucket-private and is only
    // reachable through short-lived presigned URLs, exactly like every other
    // public asset. We deliberately do not set `publicRead` on the upload —
    // making the raw S3 object public would let it be fetched/listed directly,
    // bypassing the stream route's access checks.
    //
    // The key choice, the promotion and the insert run under the content-hash
    // lock, TOGETHER: this path writes the object BEFORE its row exists, so a
    // purge of a tombstone with the same bytes must not be able to check "no
    // live row", then delete the key this copy just wrote (`contentHashLock.ts`).
    let file: FileRecord;
    try {
      file = await withContentHashLock(sha256, async (tx) => {
        const storageKey = await this.sharedStorageKeyFor(tx, sha256, mimeType, options.visibility);
        if (!(await this.s3Service.fileExists(storageKey))) {
          await this.s3Service.copyFile(tempKey, storageKey);
        }
        return insertFile({
          sha256,
          size,
          mime: mimeType,
          ext,
          ...options.owner,
          purpose: options.purpose,
          status: 'active',
          storageKey,
          originalName: normalizeInlineText(originalName),
          visibility: options.visibility,
          metadata: options.metadata,
        }, tx);
      });
      await deleteTempKey('Failed to delete temp key after cache promotion');
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The same owner raced itself; its other request created the row. The
        // object this attempt may have written is at a content-addressed key
        // that row (or a sharing one) also uses, so it is kept — never
        // deleted from under them.
        const raced = await findLiveFileBySha256ForOwner(sha256, options.owner);
        if (raced) {
          return this.reuseOwnStreamedMedia(raced, tempKey, options, deleteTempKey, ' duplicate race');
        }
      }
      await deleteTempKey('Failed to delete temp key after cache promotion');
      throw error;
    }

    logger.info(`${options.logLabel} uploaded via stream`, {
      fileId: file.id,
      sha256,
      size,
      mime: mimeType,
    });

    this.queueVariantGeneration(file);

    return { file, deduplicated: false };
  }

  /**
   * The uploader already holds these bytes: check the scope allows reusing its
   * row, restore the row's object from the temp upload if it is missing, drop
   * the temp object, and hand the row back as deduplicated.
   */
  private async reuseOwnStreamedMedia(
    own: FileRecord,
    tempKey: string,
    options: StreamedMediaOptions,
    deleteTempKey: (reason: string) => Promise<void>,
    logSuffix: string,
  ): Promise<StreamedMediaResult> {
    try {
      this.assertStreamedDedupeAllowed(own, options);
    } catch (error) {
      await deleteTempKey(`Failed to clean up rejected ${options.logLabel.toLowerCase()} upload`);
      throw error;
    }
    let restored = false;
    try {
      restored = await this.restoreMissingStreamedMediaContent(own, tempKey, `${options.logLabel}${logSuffix}`);
    } finally {
      await deleteTempKey(`Failed to clean up deduplicated ${options.logLabel.toLowerCase()} upload`);
    }
    const prepared = await this.prepareExistingStreamedMediaFile(own, options);
    if (restored) {
      this.queueVariantGeneration(prepared);
    }
    logger.info(`${options.logLabel} already exists for this owner, returning it${logSuffix}`, {
      sha256: prepared.sha256,
      fileId: prepared.id,
    });
    return { file: prepared, deduplicated: true };
  }

  /**
   * Evict a cached-media asset created via {@link uploadCachedMediaStream}.
   *
   * Hard scoping: the asset MUST sit in the `__federation_media_cache__` system
   * namespace AND carry the cache purpose, otherwise the call is rejected so a
   * service token can never delete user-owned media. The boolean return
   * distinguishes "not found" from "found but out of scope".
   *
   * The storage goes through the same durable, shared-content-guarded purge as
   * every other delete ({@link tombstoneAndOwePurge}), so a cached video's HLS
   * segments (in its variant directory) go too.
   */
  async deleteCachedMedia(fileId: string): Promise<{ deleted: boolean; outOfScope: boolean }> {
    const file = await findFileById(fileId);
    if (!file || file.status === 'deleted') {
      return { deleted: false, outOfScope: false };
    }

    const inCacheNamespace =
      file.purpose === FEDERATION_MEDIA_CACHE_PURPOSE &&
      file.systemOwner === '__federation_media_cache__';

    if (!inCacheNamespace) {
      logger.warn('Refusing to delete non-cache asset via cache endpoint', {
        fileId,
        purpose: file.purpose,
        ownerUserId: file.ownerUserId,
        systemOwner: file.systemOwner,
      });
      return { deleted: false, outOfScope: true };
    }

    const tombstoned = await this.tombstoneAndOwePurge((tx) => tombstoneFile(tx, fileId), { awaitPurge: true });
    if (!tombstoned) {
      return { deleted: false, outOfScope: false };
    }

    logger.info('Cached media deleted', { fileId });

    return { deleted: true, outOfScope: false };
  }

  /**
   * Complete file upload - commit metadata and trigger variant generation
   */
  async completeUpload(request: AssetCompleteRequest, requestingUserId: string): Promise<FileRecord> {
    try {
      const existing = await findFileById(request.fileId);
      if (!existing || existing.status === 'deleted') {
        throw new Error('File not found');
      }
      // Only the row's owner commits its metadata and visibility. Before rows
      // were per owner this was unchecked, and any account could rename,
      // re-describe or re-publish anyone's upload by id.
      if (existing.ownerUserId !== requestingUserId) {
        throw new ForbiddenError('You do not own this file');
      }

      // Verify file exists in storage
      const exists = await this.s3Service.fileExists(existing.storageKey);
      if (!exists) {
        throw new Error('File not found in storage');
      }

      const catalogue = await loadProductBillingCatalogue();
      let admittedSize = request.size;
      if (catalogue.storageAdapter) {
        const object = await this.s3Service.headObject(existing.storageKey);
        if (!object || !Number.isSafeInteger(object.size) || object.size <= 0)
          throw new BadRequestError('Uploaded object size could not be verified');
        admittedSize = object.size;
      }
      const file = await updateFile(request.fileId, {
        originalName: normalizeInlineText(request.originalName),
        size: admittedSize,
        mime: request.mime,
        metadata: request.metadata ?? {},
        ...(request.visibility ? { visibility: request.visibility } : {}),
      });
      if (!file) {
        throw new Error('File not found');
      }
      this.cacheFile(file);

      // Align the object's S3 prefix with its (now-known) visibility so public
      // uploads are immediately CDN-reachable. `initUpload` generated a private
      // key before visibility was known, so a public asset's bytes start under
      // the non-public prefix; relocate them under `public/` here.
      const relocated = await this.relocateAllForVisibility(file);

      // Variant generation reads `file.storageKey` (now relocated) and writes
      // variant keys under the prefix matching `file.visibility`.
      this.queueVariantGeneration(relocated);

      logger.info('Asset upload completed', {
        fileId: relocated.id,
        originalName: request.originalName,
        visibility: relocated.visibility
      });

      return relocated;
    } catch (error) {
      logger.error('Error completing asset upload:', error);
      throw error;
    }
  }

  /**
   * Link file to an entity
   */
  async linkFile(fileId: string, linkRequest: AssetLinkRequest): Promise<FileRecord> {
    try {
      const file = await findFileById(fileId);
      if (!file) {
        throw new Error('File not found');
      }

      if (file.status === 'deleted') {
        throw new Error('Cannot link to deleted file');
      }

      // `(file_id, app, entity_type, entity_id)` is UNIQUE, so a duplicate is
      // refused by the database rather than by a read-then-write two concurrent
      // requests could both pass — which mattered because a duplicate would
      // inflate the link count that decides `trash` vs `active`.
      const created = await insertFileLink(fileId, {
        app: linkRequest.app,
        entityType: linkRequest.entityType,
        entityId: linkRequest.entityId,
        createdBy: linkRequest.createdBy,
        webhookUrl: linkRequest.webhookUrl,
      });

      if (!created) {
        logger.warn('Link already exists', { fileId, linkRequest });
        return file;
      }

      // Auto-set visibility based on entity type
      const previousVisibility = file.visibility;
      const visibility = linkRequest.visibility
        ?? this.inferVisibilityFromEntityType(linkRequest.app, linkRequest.entityType);

      const updated = await updateFile(fileId, {
        visibility,
        ...(file.status === 'trash' ? { status: 'active' } : {}),
      });
      if (!updated) {
        throw new Error('File not found');
      }
      this.cacheFile(updated);

      // Linking an asset to a public entity (e.g. an avatar) flips its
      // visibility to `public`; relocate its bytes under the CDN-reachable
      // `public/` prefix so the new public asset serves from the CDN.
      const relocated = visibility !== previousVisibility
        ? await this.relocateAllForVisibility(updated)
        : updated;

      logger.info('File linked successfully', {
        fileId,
        linkRequest,
        totalLinks: relocated.links.length
      });

      return relocated;
    } catch (error) {
      logger.error('Error linking file:', error);
      throw error;
    }
  }

  /**
   * Send webhook notifications to links that have webhookUrl set.
   * Non-blocking: failures are logged but do not throw.
   */
  private async notifyLinks(
    file: FileRecord,
    event: 'visibility_changed' | 'deleted',
    details: Record<string, unknown>
  ): Promise<void> {
    try {
      const notifyPromises = file.links
        .flatMap((link) => (link.webhookUrl ? [{ link, url: link.webhookUrl }] : []))
        .map(async ({ link, url }) => {
          const payload = {
            event,
            fileId: file.id,
            visibility: file.visibility,
            status: file.status,
            link: {
              app: link.app,
              entityType: link.entityType,
              entityId: link.entityId
            },
            details,
            timestamp: new Date().toISOString()
          };

          try {
            const result = await safeFetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
              headersTimeoutMs: 5000,
              maxRedirects: 0,
            });
            result.response.resume();
            logger.info('Webhook delivered', { url, fileId: file.id, event, status: result.status });
          } catch (err) {
            if (err instanceof SsrfRejection) {
              logger.warn('Blocked SSRF webhook target', { url, fileId: file.id, event, reason: err.message });
              return;
            }
            logger.warn('Failed to deliver webhook', { url, fileId: file.id, event, error: err instanceof Error ? err.message : String(err) });
          }
        });

      await Promise.allSettled(notifyPromises);
    } catch (err) {
      logger.error('Error in notifyLinks helper:', err);
    }
  }

  /**
   * Unlink file from an entity
   */
  async unlinkFile(
    fileId: string,
    app: string,
    entityType: string,
    entityId: string
  ): Promise<FileRecord> {
    try {
      const file = await findFileById(fileId);
      if (!file) {
        throw new Error('File not found');
      }

      await deleteFileLink(fileId, app, entityType, entityId);

      const remaining = await findFileById(fileId);
      if (!remaining) {
        throw new Error('File not found');
      }

      // If no links remain, move to trash
      const updated = remaining.links.length === 0 && remaining.status === 'active'
        ? await updateFile(fileId, { status: 'trash' })
        : remaining;
      if (!updated) {
        throw new Error('File not found');
      }
      this.cacheFile(updated);

      logger.info('File unlinked successfully', {
        fileId,
        app,
        entityType,
        entityId,
        remainingLinks: updated.links.length
      });

      return updated;
    } catch (error) {
      logger.error('Error unlinking file:', error);
      throw error;
    }
  }

  /**
   * Get multiple files by ID.
   *
   * The result is unordered and may be shorter than the input — batch resolvers
   * are lenient and simply omit ids they cannot resolve.
   */
  async getFilesByIds(fileIds: string[]): Promise<FileRecord[]> {
    return findFilesByIds(fileIds);
  }

  /**
   * Get file by ID with full metadata
   */
  async getFile(fileId: string): Promise<FileRecord | null> {
    try {
      // A `temp-` id is a client-side placeholder for an upload that has not
      // been committed yet; it is never a stored row.
      if (fileId.startsWith('temp-')) {
        return null;
      }

      const cached = fileCache.get(fileId);
      if (cached) {
        return cached;
      }

      const file = await findFileById(fileId);
      if (file) {
        fileCache.set(fileId, file);
        return file;
      }
      return null;
    } catch (error) {
      logger.error('Error getting file', error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Fetch the raw bytes of a file from the storage backend.
   * Returns null if the file does not exist or is not in active state.
   * Used by the outbound email transporter to attach blobs to RFC822 messages.
   */
  async getFileBuffer(fileId: string): Promise<Buffer | null> {
    const file = await this.getFile(fileId);
    if (!file || file.status === 'deleted') return null;
    return this.s3Service.downloadBuffer(file.storageKey);
  }

  async fileContentExists(fileId: string, file?: FileRecord): Promise<boolean> {
    const fileObj = file ?? await this.getFile(fileId);
    if (!fileObj || fileObj.status === 'deleted') return false;
    return this.s3Service.fileExists(fileObj.storageKey);
  }

  /**
   * Re-fetch a federated asset's missing original from `metadata.remoteUrl`.
   * The remote may now serve different bytes, so they are stored only when
   * `sha256(downloaded) === file.sha256`; otherwise nothing is written (#1285).
   * Concurrent reads of one missing file share a single attempt.
   */
  repairMissingFederationFileContent(file: FileRecord): Promise<boolean> {
    if (!file || file.status === 'deleted') {
      return Promise.resolve(false);
    }
    const inFlight = federationRepairsInFlight.get(file.id);
    if (inFlight) return inFlight;
    const attempt = this.repairFederationFileContentOnce(file).finally(() => {
      federationRepairsInFlight.delete(file.id);
    });
    federationRepairsInFlight.set(file.id, attempt);
    return attempt;
  }

  private async repairFederationFileContentOnce(file: FileRecord): Promise<boolean> {
    if (await this.s3Service.fileExists(file.storageKey)) {
      return true;
    }

    const remoteUrl = this.getFederationRepairRemoteUrl(file);
    if (!remoteUrl) {
      return false;
    }
    if (isRecentFederationRepairMismatch(file.id)) {
      return false;
    }

    try {
      const repaired = await this.fetchFederationRepairImage(remoteUrl);
      if (!repaired) {
        return false;
      }

      const downloadedSha256 = AssetService.calculateSHA256(repaired.buffer);
      if (downloadedSha256 !== file.sha256) {
        recordFederationRepairMismatch(file.id);
        logger.warn('Federation repair refused: remote bytes do not match the stored digest', {
          fileId: file.id,
          expectedSha256: file.sha256,
          downloadedSha256,
          remoteHost: repairUrlHost(remoteUrl),
          size: repaired.buffer.length,
        });
        return false;
      }

      if (file.ownerUserId && (await loadProductBillingCatalogue()).storageAdapter) await reserveStorageBytes({
        accountId: file.ownerUserId, sha256: file.sha256, objectKey: file.storageKey, size: repaired.buffer.length, kind: 'server' });
      await this.s3Service.uploadBuffer(file.storageKey, repaired.buffer, {
        contentType: repaired.mime,
        cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
      });

      const updated = await updateFile(file.id, {
        size: repaired.buffer.length,
        mime: repaired.mime,
        ext: this.getExtensionFromMime(repaired.mime),
      });
      if (!updated) {
        return false;
      }

      // The caller holds this record; keep its in-hand copy consistent with the
      // row that was just written.
      file.size = updated.size;
      file.mime = updated.mime;
      file.ext = updated.ext;
      this.cacheFile(updated);
      this.queueVariantGeneration(updated);

      logger.info('Repaired missing federation asset storage from remote URL', {
        fileId: file.id,
        storageKey: file.storageKey,
        mime: repaired.mime,
        size: repaired.buffer.length,
      });
      return true;
    } catch (error) {
      logger.warn('Failed to repair missing federation asset storage', {
        fileId: file.id,
        storageKey: file.storageKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Compute the visibility-aligned target for an S3 key: under the `public/`
   * prefix for public visibility, without it otherwise.
   */
  private targetKeyForVisibility(key: string, visibility: FileVisibility): string {
    return visibility === 'public' ? applyPublicPrefix(key) : stripPublicPrefix(key);
  }

  /**
   * Make every key of the file (original and renditions) the spelling its
   * visibility needs — under `public/` for public, bare otherwise — so a
   * now-private asset leaves the CDN and a now-public one becomes reachable.
   *
   * Storage is SHARED between owners' rows for the same bytes, so this never
   * moves an object out from under anyone: it COPIES to the new spelling and
   * repoints this row, under the content-hash lock (a purge cannot delete the
   * fresh copy before the row references it), and then owes the OLD spelling a
   * delete through `storage_object_deletions` (reason `file.relocated`). The
   * storage-deletion worker deletes each spelling no live row uses — so a key
   * another owner's row still uses stays, and a public copy nobody uses any
   * more goes (with its CloudFront invalidation) — and retries a failure.
   *
   * A legacy public object kept at a bare key may have a backfilled `public/`
   * copy; on a downgrade that copy is owed the same guarded delete even though
   * the row's key itself does not change.
   */
  private async relocateAllForVisibility(file: FileRecord): Promise<FileRecord> {
    const wantPublic = file.visibility === 'public';
    const keys = [
      { variantId: null as string | null, key: file.storageKey },
      ...file.variants.map((variant) => ({ variantId: variant.id as string | null, key: variant.key })),
    ];
    const moves = keys
      .map((entry) => ({ ...entry, target: this.targetKeyForVisibility(entry.key, file.visibility) }))
      .filter((entry) => entry.target !== entry.key);

    // A downgrade also owes any legacy backfilled `public/` copy of a bare key.
    const staleCopies: string[] = [];
    if (!wantPublic) {
      for (const { key } of keys) {
        if (!isPublicKey(key) && await this.s3Service.fileExists(applyPublicPrefix(key))) {
          staleCopies.push(key);
        }
      }
    }

    if (moves.length === 0 && staleCopies.length === 0) {
      return file;
    }

    const ledgerIds = await withContentHashLock(file.sha256, async (tx) => {
      for (const move of moves) {
        if (await this.s3Service.fileExists(move.target)) continue;
        if (!(await this.s3Service.fileExists(move.key))) {
          logger.warn('Cannot copy object for visibility change; source missing', {
            fileId: file.id,
            sourceKey: move.key,
            targetKey: move.target,
            visibility: file.visibility,
          });
          continue;
        }
        await assertPhysicalStoragePathSupported(file.ownerUserId, 'visibility relocation copy');
        await this.s3Service.copyFile(move.key, move.target);
      }
      for (const move of moves) {
        if (move.variantId === null) {
          await tx.update(filesTable).set({ storageKey: move.target }).where(eq(filesTable.id, file.id));
        } else {
          await updateVariantKey(move.variantId, move.target, tx);
        }
      }
      return recordFileStorageRelocation(tx, file, [...moves.map((move) => move.key), ...staleCopies]);
    });

    await this.drainStorageDeletion(file.id, ledgerIds);

    const updated = await findFileById(file.id);
    if (!updated) {
      return file;
    }
    this.cacheFile(updated);
    logger.info('Relocated asset objects to match visibility', {
      fileId: updated.id,
      visibility: updated.visibility,
      storageKey: updated.storageKey,
      variantCount: updated.variants.length,
      moved: moves.length,
    });
    return updated;
  }

  /**
   * Resolve the public CDN URL for a file (or one of its variants), or `null`
   * when the asset is NOT servable via the public CDN.
   *
   * Returns a `cloud.oxy.so` URL only when BOTH hold:
   *   1. the file's lifecycle status is `active`,
   *   2. the file's visibility is `public`, AND
   *   3. the servable object physically lives under the CDN-reachable `public/`
   *      prefix in S3.
   *
   * Trashed/deleted/private/unlisted assets always return `null` so they can never leak through
   * the public CDN. A public asset whose bytes are not yet under `public/`
   * (legacy objects awaiting the S3 backfill) also returns `null`, so the caller
   * falls back to streaming through our own origin — never to a raw S3 URL.
   *
   * No client URL produced here is ever an `amazonaws.com` URL.
   */
  async getPublicCdnUrl(file: FileRecord, variant?: string): Promise<string | null> {
    // A trashed/deleted asset must never be reachable via the public CDN, even
    // if its visibility is still `public`. Gate on active status first so a
    // soft-deleted or trashed object can't continue serving from cloud.oxy.so.
    if (file.status !== 'active' || file.visibility !== 'public') {
      return null;
    }

    let storageKey = file.storageKey;
    if (variant) {
      const ensured = await this.ensureVariant(file.id, variant, file);
      storageKey = ensured.key;
    }

    // The variant/original key already encodes visibility (public objects are
    // written under `public/`). When it is, verify the object is present and
    // serve it via the CDN.
    if (isPublicKey(storageKey)) {
      if (await this.s3Service.fileExists(storageKey)) {
        return cdnUrlForStorageKey(storageKey);
      }
      return null;
    }

    // Legacy public object stored at a non-public key. It becomes CDN-reachable
    // only once copied under the `public/` prefix (one-shot S3 backfill). Probe
    // for the backfilled object; serve via CDN if present, otherwise signal the
    // caller to stream through our origin.
    const publicKey = applyPublicPrefix(storageKey);
    if (await this.s3Service.fileExists(publicKey)) {
      return buildCdnUrl(stripPublicPrefix(publicKey));
    }

    return null;
  }

  /**
   * Resolve the client-facing URL for an asset (or one of its variants).
   *
   * Returns a public CDN (`cloud.oxy.so`) URL when the asset is public AND its
   * bytes are CDN-reachable. Returns `null` when the asset must instead be
   * served through our own origin — private/unlisted assets, or a public object
   * not yet copied under the `public/` prefix. Callers MUST treat `null` as
   * "stream through `/assets/:id/stream`" and never as an error condition.
   *
   * This method NEVER returns a raw S3 (`amazonaws.com`) URL — public goes to
   * the CDN, everything else goes through our origin.
   */
  async getFileUrl(
    fileId: string,
    variant?: string,
    _expiresIn = 3600,
    file?: FileRecord
  ): Promise<string | null> {
    const fileObj = file ?? await this.getFile(fileId);
    if (!fileObj) {
      return null;
    }

    return this.getPublicCdnUrl(fileObj, variant);
  }

  /**
   * Get deletion impact summary
   */
  async getDeletionSummary(fileId: string): Promise<AssetDeleteSummary> {
    try {
      const file = await findFileById(fileId);
      if (!file) {
        throw new Error('File not found');
      }

      const affectedApps = [...new Set(file.links.map(link => link.app))];
      const wouldDelete = file.links.length === 0;
      const variants = file.variants.map(v => v.type);

      return {
        fileId,
        wouldDelete,
        affectedApps,
        remainingLinks: file.links.length,
        variants
      };
    } catch (error) {
      logger.error('Error getting deletion summary:', error);
      throw error;
    }
  }

  /**
   * Delete file permanently
   */
  async deleteFile(fileId: string, force = false, requestingUserId?: string): Promise<void> {
    try {
      const file = await findFileById(fileId);
      if (!file) {
        throw new Error('File not found');
      }

      // Already deleted: nothing is owed. Purging a tombstone's keys again could
      // remove the bytes of a NEWER live row that has since taken the same
      // content hash (and therefore the same keys).
      if (file.status === 'deleted') {
        return;
      }

      // Authorization Check
      if (requestingUserId && file.ownerUserId !== requestingUserId) {
        throw new Error('Unauthorized: You do not own this file');
      }

      if (!force && file.links.length > 0) {
        // Verify if links are actually active (optional enhancement)
        // For now, strict check
        throw new Error('Cannot delete file with active links. Use force=true to override.');
      }

      const tombstoned = await this.tombstoneAndOwePurge((tx) => tombstoneFile(tx, fileId), { awaitPurge: true });
      if (!tombstoned) {
        // A concurrent delete got there first; it owns the purge.
        return;
      }

      // Notify linked apps that file was deleted
      await this.notifyLinks(tombstoned, 'deleted', { force });

      logger.info('File deleted permanently', {
        fileId,
        force,
        linksRemoved: file.links.length
      });
    } catch (error) {
      logger.error('Error deleting file:', error);
      throw error;
    }
  }

  /**
   * Tombstone a row and record the storage it is owed IN THE SAME TRANSACTION
   * (`storage_object_deletions`, reason `file.deleted`), then work those ledger
   * rows off. Every per-asset delete goes through here.
   *
   * - **Durable.** A tombstone never exists without its purge being owed; an S3
   *   or network failure leaves the ledger rows pending and the storage-deletion
   *   worker retries them with backoff until the objects are gone.
   * - **Race-free.** The purge re-checks for a live row holding the same content
   *   hash and deletes only under the content-hash lock, which every new live
   *   row's insert also takes (`contentHashLock.ts`). A fresh upload of the same
   *   bytes landing after the tombstone keeps its objects (`retained_shared`).
   * - **Invalidated.** The purge deletes through `S3Service.deleteFile`, which
   *   queues a CloudFront invalidation for every deleted public key.
   *
   * `awaitPurge: false` returns once the tombstone commits and drains in the
   * background — for a caller whose request must not wait on hundreds of HLS
   * segment deletes. Either way a failed drain is only logged: the worker owns it.
   */
  private async tombstoneAndOwePurge(
    tombstone: (tx: Transaction) => Promise<FileRecord | null>,
    options: { awaitPurge: boolean },
  ): Promise<FileRecord | null> {
    const recorded = await getDb().transaction(async (tx) => {
      const row = await tombstone(tx);
      if (!row) return null;
      const ledgerIds = await recordFileStorageDeletion(tx, row, row.variants.map((variant) => variant.key));
      return { row, ledgerIds };
    });
    if (!recorded) return null;

    fileCache.invalidate(recorded.row.id);

    const drain = this.drainStorageDeletion(recorded.row.id, recorded.ledgerIds);
    if (options.awaitPurge) {
      await drain;
    } else {
      this.backgroundPurges.add(drain);
      void drain.finally(() => this.backgroundPurges.delete(drain));
    }
    return recorded.row;
  }

  /** Purges started with `awaitPurge: false` and not yet finished. */
  private readonly backgroundPurges = new Set<Promise<void>>();

  /** Wait for every background purge started so far (tests; graceful shutdown). */
  async settleStoragePurges(): Promise<void> {
    while (this.backgroundPurges.size > 0) {
      await Promise.allSettled([...this.backgroundPurges]);
    }
  }

  /** Work off the ledger rows a delete just recorded. Never throws: the worker owns what is left. */
  private async drainStorageDeletion(fileId: string, ledgerIds: string[]): Promise<void> {
    try {
      const result = await runStorageDeletionBatch({
        ownerId: STORAGE_DELETION_DRAIN_OWNER,
        ids: ledgerIds,
        store: {
          deleteObject: (key) => this.s3Service.deleteFile(key),
          listKeys: async (prefix, maxKeys) =>
            (await this.s3Service.listFiles(prefix, maxKeys)).map((item) => item.key),
        },
      });
      if (result.failed > 0) {
        logger.warn('Asset storage purge incomplete; the storage-deletion worker will retry', {
          fileId,
          ...result,
        });
      }
    } catch (error) {
      logger.error('Asset storage purge failed to run; the storage-deletion worker will retry', {
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Delete federation-owned media on behalf of the application that uploaded it
   * (`POST /assets/service/federation`), e.g. when the federated source deleted
   * the post the media belonged to.
   *
   * Authorization is ONE conditional write ({@link tombstoneFederatedFileForApp}):
   * the row is tombstoned only if it is live, this application's federated
   * media, and not held by anyone else (a link by another account, a mail
   * attachment, a listing screenshot). The storage is then owed and purged
   * through {@link tombstoneAndOwePurge} — never before the tombstone commits, so
   * a row that fails any condition never has its bytes touched.
   *
   * Outcomes: `deleted` (tombstoned; purge owed and started), `not_found`
   * (unknown or already deleted — done), `in_use` (somebody else holds it — kept;
   * nothing to retry), `forbidden` (not this application's federated media).
   */
  async deleteFederatedMediaForApp(
    fileId: string,
    appId: string,
    options: { awaitPurge?: boolean } = {},
  ): Promise<FederatedMediaDeleteOutcome> {
    const tombstoned = await this.tombstoneAndOwePurge(
      (tx) => tombstoneFederatedFileForApp(tx, fileId, appId),
      { awaitPurge: options.awaitPurge ?? false },
    );

    if (!tombstoned) {
      const refusal = await classifyFederatedDeleteRefusal(fileId, appId);
      if (refusal === 'forbidden') {
        logger.warn('Refusing to delete asset via federated media delete: out of scope', { fileId, appId });
      } else if (refusal === 'in_use') {
        logger.info('Keeping federated media: another account still uses it', { fileId, appId });
      }
      return refusal;
    }

    await this.notifyLinks(tombstoned, 'deleted', { reason: 'federated_source_deleted' });

    return 'deleted';
  }

  /**
   * Restore file from trash
   */
  async restoreFile(fileId: string): Promise<FileRecord> {
    try {
      const file = await findFileById(fileId);
      if (!file) {
        throw new Error('File not found');
      }

      if (file.status !== 'trash') {
        throw new Error('File is not in trash');
      }

      const restored = await updateFile(fileId, { status: 'active' });
      if (!restored) {
        throw new Error('File not found');
      }
      this.cacheFile(restored);

      logger.info('File restored from trash', { fileId });

      return restored;
    } catch (error) {
      logger.error('Error restoring file:', error);
      throw error;
    }
  }

  /**
   * Calculate SHA256 hash for content addressing
   */
  static calculateSHA256(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Infer file visibility based on entity type
   * Automatically marks certain entity types as public (e.g., avatars, profile content)
   */
  private inferVisibilityFromEntityType(app: string, entityType: string): FileVisibility {
    // Public entity types that should be accessible without authentication
    const publicEntityTypes = [
      'avatar',
      'profile-avatar',
      'user-avatar',
      'profile-banner',
      'profile-cover',
      'public-profile-content'
    ];

    if (publicEntityTypes.includes(entityType.toLowerCase())) {
      return 'public';
    }

    // Default to private for all other types
    return 'private';
  }

  /**
   * Ensure an asset the user owns is public. Used when a file is set as a
   * public-facing profile media field (avatar/banner) — those must render
   * unauthenticated (an `<img>` can't send a bearer token, and private media is
   * denied to anonymous viewers). Owner-gated and best-effort: it never throws,
   * so a profile update is never blocked by a visibility flip.
   */
  async ensureOwnedAssetPublic(fileId: string, userId: string): Promise<void> {
    try {
      if (!fileId || fileId.startsWith('temp-')) return;
      const file = await this.getFile(fileId);
      if (!file) return;
      if (file.ownerUserId !== userId) return;
      if (file.visibility === 'public') return;
      await this.updateFileVisibility(fileId, 'public');
      logger.info('Profile media asset promoted to public', { fileId, userId });
    } catch (error) {
      logger.warn('Failed to promote profile media asset to public', {
        fileId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Update file visibility
   */
  async updateFileVisibility(fileId: string, visibility: FileVisibility): Promise<FileRecord> {
    try {
      const file = await findFileById(fileId);
      if (!file) {
        throw new Error('File not found');
      }

      // Only update if visibility is actually changing
      if (file.visibility === visibility) {
        return file;
      }

      if ((file.visibility === 'public') !== (visibility === 'public'))
        await assertPhysicalStoragePathSupported(file.ownerUserId, 'visibility relocation copy');

      const updated = await updateFile(fileId, { visibility });
      if (!updated) {
        throw new Error('File not found');
      }
      this.cacheFile(updated);

      // Relocate the object + variants so their S3 prefix matches the new
      // visibility: a now-private asset's bytes leave the CDN-reachable
      // `public/` prefix; a now-public asset's bytes move under it.
      const relocated = await this.relocateAllForVisibility(updated);

      // Notify linked apps about visibility change
      try {
        await this.notifyLinks(relocated, 'visibility_changed', { visibility });
      } catch (err) {
        logger.error('Failed to notify links after visibility change', err);
      }

      return relocated;
    } catch (error) {
      logger.error('Error updating file visibility:', error);
      throw error;
    }
  }

  /**
   * Check if a user can access a file
   */
  async canUserAccessFile(
    file: FileRecord,
    userId?: string,
    context?: MediaAccessContext
  ): Promise<boolean> {
    // Use the centralized MediaPrivacyService for comprehensive checks
    const result = await mediaPrivacyService.checkMediaAccess(file, userId, context);
    return result.allowed;
  }

  /**
   * Generate storage key using SHA256 for content addressing.
   *
   * Public assets are placed under the CDN-reachable `public/` prefix so they
   * can be served via CloudFront (`cloud.oxy.so`); private/unlisted assets stay
   * private to S3 and are only reachable through the access-gated origin stream
   * route. The public-vs-private placement decision lives in one place
   * (`storageKeyForVisibility` in `config/cdn.ts`).
   *
   * Several owners' rows share one key for the same bytes; see
   * `sharedStorageKeyFor`.
   *
   * `visibility` defaults to `private` for the two-phase upload flow
   * (`initUpload`), where the storage key (and its presigned PUT URL) must be
   * generated before the client declares visibility at `completeUpload`.
   */
  private generateStorageKey(
    sha256: string,
    mime: string,
    visibility: FileVisibility = 'private',
    uniqueSuffix?: string,
  ): string {
    const ext = this.getExtensionFromMime(mime);
    const year = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, '0');

    // Content-addressed path: content/{year}/{month}/{first2chars}/{sha256}.{ext}
    // A `uniqueSuffix` (`{sha256}-{suffix}.{ext}`) is for a presigned PUT that
    // must not target a key another owner's row already holds (`initUpload`).
    const prefix = sha256.substring(0, 2);
    const baseKey = `content/${year}/${month}/${prefix}/${sha256}${uniqueSuffix ? `-${uniqueSuffix}` : ''}${ext}`;
    return storageKeyForVisibility(baseKey, visibility);
  }

  /**
   * Get file extension from MIME type
   */
  private getExtensionFromMime(mime: string): string {
    const mimeToExt: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/jpg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'video/mp4': '.mp4',
      'video/mpeg': '.mpeg',
      'video/quicktime': '.mov',
      'audio/mpeg': '.mp3',
      'audio/wav': '.wav',
      'application/pdf': '.pdf',
      'text/plain': '.txt',
      'application/json': '.json',
      'application/zip': '.zip'
    };

    return mimeToExt[mime] || '';
  }

  /**
   * Schedule variant generation for a freshly stored (or relocated/replaced)
   * file.
   *
   * This HANDS THE WORK OFF and returns; it does not generate anything. The
   * previous implementation awaited `generateVariants` here, which meant every
   * upload started up to seven sharp encodes — or three x264 transcodes plus HLS
   * segmentation — in this process with nothing bounding how many ran at once.
   * None of the eight call sites await this method, so the response was never
   * blocked; the damage was CPU and memory contention on a fractional-vCPU task,
   * which starved the JS thread until the ELB's `/health` probe timed out and
   * the task was killed. See `queue/assetVariants.queue.ts`.
   *
   * Synchronous by design so a caller cannot accidentally await a transcode.
   */
  private queueVariantGeneration(file: FileRecord): void {
    logger.info('Queueing variant generation', {
      fileId: file.id,
      mime: file.mime,
    });
    enqueueAssetVariantGeneration(file.id);
  }
}
