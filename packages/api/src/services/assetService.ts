import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import { type Readable, Transform } from 'stream';
import { normalizeInlineText } from '@oxyhq/core';
import { safeFetch, SsrfRejection, type SafeFetchResult } from '@oxyhq/core/server';
import type { S3Service } from './s3Service';
import {
  FEDERATION_MEDIA_CACHE_PURPOSE,
  isAllowedCacheMime,
} from '../constants/federationCache';
import { VariantService } from './variantService';
import { enqueueAssetVariantGeneration } from '../queue/assetVariants.queue';
import {
  buildCdnUrl,
  cdnUrlForStorageKey,
  applyPublicPrefix,
  stripPublicPrefix,
  isPublicKey,
  storageKeyForVisibility,
} from '../config/cdn';
import { logger } from '../utils/logger';
import { ConflictError } from '../utils/error';
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
  findLiveFileBySha256,
  findLiveFilesBySha256,
  insertFile,
  insertFileLink,
  isUniqueViolation,
  listFilesByOwner,
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
  dedupeScope?: 'any' | 'federation-cache' | 'owner';
}

const FEDERATION_REPAIR_MAX_BYTES = 10 * 1024 * 1024;
const FEDERATION_REPAIR_MAX_REDIRECTS = 3;
const FEDERATION_REPAIR_USER_AGENT = 'OxyHQ/1.0 (Federation Asset Repair)';

export class AssetService {
  private variantService: VariantService;

  constructor(private s3Service: S3Service) {
    this.variantService = new VariantService(s3Service);
  }

  /**
   * Content-addressed dedup lookup. Deliberately excludes `deleted` tombstones:
   * a deleted record is a deletion intent, not a reusable asset. Matching a
   * tombstone and reassigning its ownership to the next uploader was a
   * cross-tenant ownership-takeover vector (any user who can produce content
   * whose SHA-256 collides with a victim's deleted file could revive that
   * record under their own ownership). The `files_sha256_live_key` partial
   * unique is scoped to live rows, so a fresh upload whose content matches only
   * a tombstone can insert a brand-new row owned by the uploader.
   */
  private async findActiveFileBySha(sha256: string): Promise<FileRecord | null> {
    return findLiveFileBySha256(sha256);
  }

  /**
   * Batch reverse content-address lookup: resolve many content hashes to their
   * live (non-deleted) file records in a single query.
   *
   * This is the batched counterpart of {@link findActiveFileBySha}, used by the
   * service-token `POST /assets/service/by-sha256` route to resolve a record's
   * `blob.sha256` back to a servable asset without issuing one query per hash.
   * The result is unordered and may be shorter than the input — unresolvable
   * hashes are simply absent, and at most one record per hash is returned.
   */
  async findActiveFilesBySha256(sha256s: string[]): Promise<FileRecord[]> {
    return findLiveFilesBySha256(sha256s);
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
   * DNS-pinned {@link safeFetch} (`@oxyhq/core/server`). safeFetch resolves the
   * host once, connects to the validated IP, re-validates every redirect hop,
   * and denies private/loopback/link-local/metadata IPs — closing the
   * DNS-rebinding TOCTOU window that a separate validate-then-`fetch` left open.
   * safeFetch does NOT bound the body, so we enforce the byte cap here.
   */
  private async fetchFederationRepairImage(remoteUrl: string): Promise<{ buffer: Buffer; mime: string } | null> {
    let protocol: string;
    try {
      protocol = new URL(remoteUrl).protocol;
    } catch {
      return null;
    }
    if (protocol !== 'https:') {
      logger.warn('Federation repair URL rejected: non-https protocol', { url: remoteUrl });
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
          url: remoteUrl,
          reason: error.message,
        });
        return null;
      }
      logger.warn('Federation repair download failed', {
        url: remoteUrl,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    try {
      if (result.status < 200 || result.status >= 300) {
        result.response.destroy();
        logger.warn('Federation repair download failed', {
          url: result.finalUrl,
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
          url: result.finalUrl,
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
          url: result.finalUrl,
          declaredLength,
        });
        return null;
      }

      const buffer = await this.readBodyLimited(result.response, FEDERATION_REPAIR_MAX_BYTES);
      if (!buffer || buffer.length === 0) {
        logger.warn('Federation repair image has invalid size', {
          url: result.finalUrl,
          size: buffer?.length ?? 0,
        });
        return null;
      }

      return { buffer, mime };
    } catch (error) {
      result.response.destroy();
      logger.warn('Federation repair download failed while reading body', {
        url: result.finalUrl,
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

    await this.s3Service.uploadBuffer(file.storageKey, fileBuffer, {
      contentType: file.mime || mimeType,
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

    await this.s3Service.copyFile(sourceKey, file.storageKey);
    this.cacheFile(file);
    return true;
  }

  private async prepareExistingDirectUploadFile(
    file: FileRecord,
    userId: string,
    visibility?: FileVisibility,
    metadata?: Record<string, unknown>
  ): Promise<FileRecord> {
    const wasCacheFile = file.purpose === FEDERATION_MEDIA_CACHE_PURPOSE;
    if (!wasCacheFile) {
      return file;
    }

    const updated = await updateFile(file.id, {
      ownerUserId: userId,
      systemOwner: null,
      purpose: 'user',
      ...(visibility ? { visibility } : {}),
      metadata: {
        ...(file.metadata ?? {}),
        ...(metadata ?? {}),
        promotedFromFederationCache: true,
      },
    });

    return updated ? this.cacheFile(updated) : file;
  }

  private assertStreamedDedupeAllowed(file: FileRecord, options: StreamedMediaOptions): void {
    if (options.dedupeScope === 'federation-cache') {
      if (file.purpose === FEDERATION_MEDIA_CACHE_PURPOSE) {
        return;
      }

      throw new ConflictError('Federated media content already exists outside the federation cache');
    }

    if (options.dedupeScope === 'owner') {
      if (file.purpose === FEDERATION_MEDIA_CACHE_PURPOSE) {
        return;
      }

      if (file.ownerUserId !== options.owner.ownerUserId) {
        throw new ConflictError('Media content already exists for another user');
      }

      return;
    }
  }

  private async prepareExistingStreamedMediaFile(
    file: FileRecord,
    options: StreamedMediaOptions
  ): Promise<FileRecord> {
    if (options.purpose === FEDERATION_MEDIA_CACHE_PURPOSE) {
      return file;
    }

    const wasCacheFile = file.purpose === FEDERATION_MEDIA_CACHE_PURPOSE;
    if (!wasCacheFile) {
      return file;
    }

    const updated = await updateFile(file.id, {
      ...options.owner,
      purpose: options.purpose,
      visibility: options.visibility,
      metadata: {
        ...(file.metadata ?? {}),
        ...options.metadata,
        promotedFromFederationCache: true,
      },
    });

    return updated ? this.cacheFile(updated) : file;
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
        return this.variantService.ensureVideoMp4Rendition(fileObj, variantType);
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
   * Initialize file upload - returns pre-signed URL and file ID
   */
  async initUpload(
    userId: string,
    expectedSha256: string,
    expectedSize: number,
    expectedMime: string
  ): Promise<AssetInitResponse> {
    try {
      // Check if file already exists by SHA256 (active records only — deleted
      // tombstones are never deduplicated/revived, so a fresh upload matching a
      // tombstone falls through to a brand-new record below).
      const existingFile = await this.findActiveFileBySha(expectedSha256);

      if (existingFile) {
        const storageKey = existingFile.storageKey || this.generateStorageKey(expectedSha256, expectedMime);
        let uploadUrl = '';
        const objectExists = await this.s3Service.fileExists(storageKey);
        const requesterOwnsExisting = existingFile.ownerUserId === userId;
        if (!objectExists && requesterOwnsExisting) {
          logger.warn('Existing asset record has no storage object; returning upload URL for the existing key', {
            fileId: existingFile.id,
            sha256: expectedSha256,
            storageKey,
          });
          // Only the file owner may receive a repair PUT URL for an existing
          // record, and only when the object is missing. Signing a live
          // deduplicated object's key would let any authenticated user who
          // knows the SHA-256 overwrite another user's asset bytes.
          uploadUrl = await this.s3Service.getPresignedUploadUrl(storageKey, {
            contentType: expectedMime,
            expiresIn: 3600
          });
        } else if (!objectExists) {
          logger.warn('Existing asset record has no storage object; not returning repair URL to non-owner', {
            fileId: existingFile.id,
            sha256: expectedSha256,
            storageKey,
            requesterUserId: userId,
            ownerUserId: existingFile.ownerUserId,
          });
        }

        logger.info('File already exists, returning existing', {
          sha256: expectedSha256,
          fileId: existingFile.id
        });

        return {
          uploadUrl,
          fileId: existingFile.id,
          sha256: expectedSha256
        };
      }

      // Create new file record
      const ext = this.getExtensionFromMime(expectedMime);
      const storageKey = this.generateStorageKey(expectedSha256, expectedMime);

      const file = await insertFile({
        sha256: expectedSha256,
        size: expectedSize,
        mime: expectedMime,
        ext,
        ownerUserId: userId,
        status: 'active',
        storageKey,
      });

      // Generate pre-signed upload URL
      // Do not include metadata in the presigned URL signature; clients aren't required to send it
      const uploadUrl = await this.s3Service.getPresignedUploadUrl(storageKey, {
        contentType: expectedMime,
        expiresIn: 3600
      });

      logger.info('Asset upload initialized', {
        fileId: file.id,
        sha256: expectedSha256,
        storageKey
      });

      return {
        uploadUrl,
        fileId: file.id,
        sha256: expectedSha256
      };
    } catch (error) {
      logger.error('Error initializing asset upload:', error);
      throw new Error('Failed to initialize asset upload');
    }
  }

  /**
   * Upload file directly - calculates SHA256 on backend
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

      // Check if file already exists by SHA256 (active records only).
      const existingFile = await this.findActiveFileBySha(sha256);

      if (existingFile) {
        const { file: restoredFile, restored } = await this.restoreMissingDirectUploadContent(
          existingFile,
          fileBuffer,
          mimeType,
          'direct upload',
        );
        const preparedFile = await this.prepareExistingDirectUploadFile(
          restoredFile,
          userId,
          visibility,
          metadata,
        );
        if (restored) {
          this.queueVariantGeneration(preparedFile);
        }
        logger.info('File already exists, returning existing', {
          sha256,
          fileId: preparedFile.id
        });

        // File already exists, return existing file
        return preparedFile;
      }

      // Create new file record
      const ext = this.getExtensionFromMime(mimeType);
      const resolvedVisibility: FileVisibility = visibility || 'private';
      const storageKey = this.generateStorageKey(sha256, mimeType, resolvedVisibility);

      let file: FileRecord;
      try {
        file = await insertFile({
          sha256,
          size,
          mime: mimeType,
          ext,
          ownerUserId: userId,
          status: 'active',
          storageKey,
          originalName: normalizeInlineText(originalName),
          visibility: resolvedVisibility,
          metadata: metadata ?? {},
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          const racedFile = await this.findActiveFileBySha(sha256);
          if (racedFile) {
            const { file: restoredFile, restored } = await this.restoreMissingDirectUploadContent(
              racedFile,
              fileBuffer,
              mimeType,
              'direct upload duplicate race',
            );
            const preparedFile = await this.prepareExistingDirectUploadFile(
              restoredFile,
              userId,
              visibility,
              metadata,
            );
            if (restored) {
              this.queueVariantGeneration(preparedFile);
            }
            logger.info('File already exists after concurrent upload, returning existing', {
              sha256,
              fileId: preparedFile.id,
            });
            return preparedFile;
          }
        }
        throw error;
      }

      // Upload to S3
      await this.s3Service.uploadBuffer(storageKey, fileBuffer, {
        contentType: mimeType
      });

      // Queue variant generation
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
    metadata?: Record<string, unknown>
  ): Promise<FileRecord> {
    return this.uploadStreamedMedia(source, mimeType, originalName, maxBytes, {
      owner: { ownerUserId, systemOwner: null },
      purpose: 'user',
      visibility: 'public',
      metadata: {
        source: 'federation',
        ...(metadata ?? {}),
      },
      tempPrefix: 'federation/incoming',
      logLabel: 'Federated media',
      dedupeScope: 'federation-cache',
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
      dedupeScope: 'owner',
    });
  }

  /**
   * Stream a remote OG / oEmbed image into PUBLIC, CDN-served asset storage for
   * the link-preview service, in its own reserved namespace
   * (`__link_preview_cache__` + `purpose: 'link-preview'`) so these assets are
   * kept distinct from user media and from the federation media cache.
   *
   * The bytes are content-addressed and CDN-reachable (`public/` prefix) exactly
   * like any other public asset, so the resulting file id resolves via
   * `GET /cdn/:id` → `cloud.oxy.so/<id>`. Variants (resized webp, etc.) are
   * generated by the shared variant pipeline. This is the ONLY place a remote
   * link-preview image is persisted — the caller never returns the origin URL.
   */
  async uploadLinkPreviewImageStream(
    source: AbortableReadable,
    mimeType: string,
    originalName: string,
    maxBytes: number
  ): Promise<FileRecord> {
    return this.uploadStreamedMedia(source, mimeType, originalName, maxBytes, {
      owner: { ownerUserId: null, systemOwner: '__link_preview_cache__' },
      purpose: 'link-preview',
      visibility: 'public',
      metadata: { source: 'link-preview' },
      tempPrefix: 'link-preview/incoming',
      logLabel: 'Link preview image',
    });
  }

  private async uploadStreamedMedia(
    source: AbortableReadable,
    mimeType: string,
    originalName: string,
    maxBytes: number,
    options: StreamedMediaOptions
  ): Promise<FileRecord> {
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
      await this.s3Service.uploadStream(tempKey, body, {
        contentType: mimeType,
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

    // Dedup: if this exact content already exists (cache or otherwise), reuse
    // it and drop the temp object. Active records only — deleted tombstones are
    // never revived.
    const existingFile = await this.findActiveFileBySha(sha256);
    if (existingFile) {
      try {
        this.assertStreamedDedupeAllowed(existingFile, options);
      } catch (error) {
        await deleteTempKey(`Failed to clean up rejected ${options.logLabel.toLowerCase()} upload`);
        throw error;
      }
      let restored = false;
      try {
        restored = await this.restoreMissingStreamedMediaContent(
          existingFile,
          tempKey,
          options.logLabel,
        );
      } finally {
        await deleteTempKey(`Failed to clean up deduplicated ${options.logLabel.toLowerCase()} upload`);
      }
      const preparedFile = await this.prepareExistingStreamedMediaFile(existingFile, options);
      if (restored) {
        this.queueVariantGeneration(preparedFile);
      }
      logger.info(`${options.logLabel} already exists, returning existing`, {
        sha256,
        fileId: preparedFile.id,
      });
      return preparedFile;
    }

    // Promote the temp object to its content-addressed key (server-side copy,
    // no RAM), then drop the temp object. Federation/cache media is always
    // `public`, so its content-addressed key lands under the CDN-reachable
    // `public/` prefix (decided centrally by `generateStorageKey`).
    const ext = this.getExtensionFromMime(mimeType);
    const storageKey = this.generateStorageKey(sha256, mimeType, options.visibility);
    await this.s3Service.copyFile(tempKey, storageKey);
    await deleteTempKey('Failed to delete temp key after cache promotion');

    // `visibility: 'public'` is an app-level ACL meaning "served without a user
    // session via the presigned-redirect stream route (GET /:id/stream)". It is
    // NOT an S3 ACL: the underlying object stays bucket-private and is only
    // reachable through short-lived presigned URLs, exactly like every other
    // public asset. We deliberately do not set `publicRead` on the upload —
    // making the raw S3 object public would let it be fetched/listed directly,
    // bypassing the stream route's access checks.
    let file: FileRecord;
    try {
      file = await insertFile({
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
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        const racedFile = await this.findActiveFileBySha(sha256);
        if (racedFile) {
          try {
            this.assertStreamedDedupeAllowed(racedFile, options);
          } catch (dedupeError) {
            if (racedFile.storageKey !== storageKey) {
              try {
                await this.s3Service.deleteFile(storageKey);
              } catch (cleanupError) {
                logger.warn(`Failed to clean up rejected duplicate ${options.logLabel.toLowerCase()} storage object`, {
                  storageKey,
                  error: cleanupError,
                });
              }
            }
            throw dedupeError;
          }
          let restored = false;
          try {
            restored = await this.restoreMissingStreamedMediaContent(
              racedFile,
              storageKey,
              `${options.logLabel} duplicate race`,
            );
          } finally {
            if (racedFile.storageKey !== storageKey) {
              try {
                await this.s3Service.deleteFile(storageKey);
              } catch (cleanupError) {
                logger.warn(`Failed to clean up duplicate ${options.logLabel.toLowerCase()} storage object`, {
                  storageKey,
                  error: cleanupError,
                });
              }
            }
          }
          const preparedFile = await this.prepareExistingStreamedMediaFile(racedFile, options);
          if (restored) {
            this.queueVariantGeneration(preparedFile);
          }
          logger.info(`${options.logLabel} already exists after concurrent upload, returning existing`, {
            sha256,
            fileId: preparedFile.id,
          });
          return preparedFile;
        }
      }
      throw error;
    }

    logger.info(`${options.logLabel} uploaded via stream`, {
      fileId: file.id,
      sha256,
      size,
      mime: mimeType,
    });

    this.queueVariantGeneration(file);

    return file;
  }

  /**
   * Delete a cached-media asset created via {@link uploadCachedMediaStream}.
   *
   * Hard scoping: the asset MUST sit in the `__federation_media_cache__` system
   * namespace AND carry the cache purpose, otherwise the call is rejected so a
   * service token can never delete user-owned media. The boolean return
   * distinguishes "not found" from "found but out of scope".
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

    await this.s3Service.deleteFile(file.storageKey);
    for (const variant of file.variants) {
      try {
        await this.s3Service.deleteFile(variant.key);
      } catch (error) {
        logger.warn('Failed to delete cache variant', { variant: variant.key, error });
      }
    }

    await updateFile(fileId, { status: 'deleted' });
    fileCache.invalidate(fileId);

    logger.info('Cached media deleted', { fileId });

    return { deleted: true, outOfScope: false };
  }

  /**
   * Complete file upload - commit metadata and trigger variant generation
   */
  async completeUpload(request: AssetCompleteRequest): Promise<FileRecord> {
    try {
      const existing = await findFileById(request.fileId);
      if (!existing) {
        throw new Error('File not found');
      }

      // Verify file exists in storage
      const exists = await this.s3Service.fileExists(existing.storageKey);
      if (!exists) {
        throw new Error('File not found in storage');
      }

      const file = await updateFile(request.fileId, {
        originalName: normalizeInlineText(request.originalName),
        size: request.size,
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

  async repairMissingFederationFileContent(file: FileRecord): Promise<boolean> {
    if (!file || file.status === 'deleted') {
      return false;
    }
    if (await this.s3Service.fileExists(file.storageKey)) {
      return true;
    }

    const remoteUrl = this.getFederationRepairRemoteUrl(file);
    if (!remoteUrl) {
      return false;
    }

    try {
      const repaired = await this.fetchFederationRepairImage(remoteUrl);
      if (!repaired) {
        return false;
      }

      await this.s3Service.uploadBuffer(file.storageKey, repaired.buffer, {
        contentType: repaired.mime,
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
   * Delete a legacy backfilled CDN copy for a non-public object key. Older
   * public files may have DB keys outside `public/` while a backfill-created
   * `public/<key>` copy exists for CDN serving; visibility downgrades and
   * deletes must remove that deterministic public copy even when the stored key
   * itself does not need relocation. Best-effort: a failure is logged, not
   * thrown.
   */
  private async deleteBackfilledPublicCopy(key: string): Promise<void> {
    if (isPublicKey(key)) {
      return;
    }

    const publicKey = applyPublicPrefix(key);
    if (!(await this.s3Service.fileExists(publicKey))) {
      return;
    }

    try {
      await this.s3Service.deleteFile(publicKey);
    } catch (cleanupError) {
      logger.warn('Failed to delete legacy public CDN copy after visibility downgrade', {
        sourceKey: key,
        publicKey,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }

  /**
   * Relocate a single S3 object so its key prefix matches `visibility`. Returns
   * the (possibly unchanged) key. Idempotent and best-effort: a missing source
   * object is logged and the original key is returned unchanged.
   */
  private async relocateObjectForVisibility(key: string, visibility: FileVisibility): Promise<string> {
    const targetKey = this.targetKeyForVisibility(key, visibility);
    if (visibility !== 'public') {
      await this.deleteBackfilledPublicCopy(key);
    }

    if (targetKey === key) {
      return key;
    }

    if (!(await this.s3Service.fileExists(key))) {
      logger.warn('Cannot relocate object for visibility change; source missing', {
        sourceKey: key,
        targetKey,
        visibility,
      });
      return key;
    }

    await this.s3Service.copyFile(key, targetKey);
    try {
      await this.s3Service.deleteFile(key);
    } catch (cleanupError) {
      logger.warn('Failed to delete source object after visibility relocation', {
        sourceKey: key,
        targetKey,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    return targetKey;
  }

  /**
   * Relocate the original object and every variant so all keys match the file's
   * current visibility, persisting the rewritten keys. Used when visibility
   * actually flips (`public` ↔ `private`/`unlisted`) so existing CDN-served
   * objects stop being reachable when made private, and become reachable when
   * made public.
   */
  private async relocateAllForVisibility(file: FileRecord): Promise<FileRecord> {
    const newOriginalKey = await this.relocateObjectForVisibility(file.storageKey, file.visibility);
    let changed = newOriginalKey !== file.storageKey;

    for (const variant of file.variants) {
      const newVariantKey = await this.relocateObjectForVisibility(variant.key, file.visibility);
      if (newVariantKey !== variant.key) {
        await updateVariantKey(variant.id, newVariantKey);
        variant.key = newVariantKey;
        changed = true;
      }
    }

    if (!changed) {
      return file;
    }

    const updated = await updateFile(file.id, { storageKey: newOriginalKey });
    if (!updated) {
      return file;
    }
    this.cacheFile(updated);
    logger.info('Relocated asset objects to match visibility', {
      fileId: updated.id,
      visibility: updated.visibility,
      storageKey: updated.storageKey,
      variantCount: updated.variants.length,
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

      // Authorization Check
      if (requestingUserId && file.ownerUserId !== requestingUserId) {
        throw new Error('Unauthorized: You do not own this file');
      }

      if (!force && file.links.length > 0) {
        // Verify if links are actually active (optional enhancement)
        // For now, strict check
        throw new Error('Cannot delete file with active links. Use force=true to override.');
      }

      // Delete from storage, including any legacy CDN copy produced by the
      // public-asset backfill while the DB key stayed non-public.
      await this.s3Service.deleteFile(file.storageKey);
      await this.deleteBackfilledPublicCopy(file.storageKey);

      // Delete variants from storage
      for (const variant of file.variants) {
        try {
          await this.s3Service.deleteFile(variant.key);
          await this.deleteBackfilledPublicCopy(variant.key);
        } catch (error) {
          logger.warn('Failed to delete variant', { variant: variant.key, error });
        }
      }

      await updateFile(fileId, { status: 'deleted' });
      fileCache.invalidate(fileId);

      // Notify linked apps that file was deleted
      await this.notifyLinks({ ...file, status: 'deleted' }, 'deleted', { force });

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
   * `visibility` defaults to `private` for the two-phase upload flow
   * (`initUpload`), where the storage key (and its presigned PUT URL) must be
   * generated before the client declares visibility at `completeUpload`.
   */
  private generateStorageKey(sha256: string, mime: string, visibility: FileVisibility = 'private'): string {
    const ext = this.getExtensionFromMime(mime);
    const year = new Date().getFullYear();
    const month = String(new Date().getMonth() + 1).padStart(2, '0');

    // Content-addressed path: content/{year}/{month}/{first2chars}/{sha256}.{ext}
    const prefix = sha256.substring(0, 2);
    const baseKey = `content/${year}/${month}/${prefix}/${sha256}${ext}`;
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
