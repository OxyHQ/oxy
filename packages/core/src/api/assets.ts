/**
 * `oxy.assets` — files: upload, link to entities, resolve URLs, read content.
 *
 * ## Which URL to use
 *
 * - {@link AssetsApi.url} — asks the API for a URL valid for the CURRENT
 *   caller, whatever the asset's visibility. The right default.
 * - {@link AssetsApi.publicUrl} — a synchronous string builder for an asset
 *   KNOWN to be public (avatars). A private asset renders a hard 404 there.
 * - {@link AssetsApi.urls} — {@link AssetsApi.url} for a whole grid in one
 *   round trip.
 * - {@link AssetsApi.cachedUrl} — what {@link AssetsApi.url} already resolved
 *   for this caller, synchronously, or nothing; never a request.
 * - {@link AssetsApi.renderUrl} — the URL a render path shows without waiting:
 *   an absolute URL as-is, else the cached resolution, else
 *   {@link AssetsApi.publicUrl}.
 *
 * The service-token asset routes (metadata by id / by hash, linked download
 * URLs) are `OxyServer`'s `assets` (`@oxy.so/core/server`).
 */
import { isReactNative } from '@oxy.so/protocol/random';
import type { OxyContext } from '../client/context';
import { logger } from '../logger';
import type {
  AccountStorageUsageResponse,
  AssetCompleteRequest,
  AssetInitRequest,
  AssetInitResponse,
  Asset,
  AssetDeleteSummary,
  AssetLink,
  AssetMetadata,
  AssetPublicUrlOptions,
  AssetUploadInput,
  BatchFileAccessResponse,
  FileApplicationAccess,
  FileApplicationAccessRevocation,
  FileVisibility,
  RNFileDescriptor,
} from '../models/interfaces';
import { AssetUrlResolutionError } from '../OxyServices.errors';
import {
  type DirectUploadApi,
  type DirectUploadSession,
  type DirectUploadTuning,
  runDirectUpload,
} from './directUpload';
import { extractErrorStatus } from '../utils/errorUtils';

/**
 * Conservative lower bound (10 min) the SDK assumes for the lifetime of the
 * scoped media token (`mt`) the API embeds in a private asset's stream URL. The
 * API mints 900s (`MEDIA_TOKEN_TTL_SECONDS`); core assumes a shorter floor
 * because it cannot observe a server-side change at runtime, and
 * under-assuming only ever shortens the cache (more refetches, never a dead URL).
 */
const ASSET_MEDIA_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * Fraction of a resolved URL's lifetime it may stay cached: a URL dies with its
 * media token, so caching for the full lifetime guarantees a window that hands
 * out dead URLs (clock skew, render latency, queued image requests).
 */
const ASSET_URL_CACHE_LIFETIME_FRACTION = 0.5;

/** Assumed URL lifetime (seconds) when no `expiresIn` is asked for; the API default. */
const DEFAULT_ASSET_URL_EXPIRES_IN_SECONDS = 3600;

const ASSET_TTL = 5 * 60 * 1000;

/**
 * Default bound on one `POST /assets/upload`, in ms. The client's per-request
 * default (5s) is sized for JSON calls; a video sent over a phone connection
 * needs minutes, and timing it out at 5s failed every upload past a few MB.
 */
const ASSET_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The largest file {@link AssetsApi.upload} sends through the API in one
 * multipart request, in bytes; a larger one goes straight to storage by
 * presigned PUT (hash → `/assets/init` → PUT → `/assets/complete`).
 *
 * api.oxy.so sits behind a proxy that refuses any request body over 100 MB
 * with a 413 before Oxy sees it, and the API itself refuses a multipart file
 * over 90 MiB (413 `USE_PRESIGNED_UPLOAD`). 64 MiB leaves the multipart
 * envelope and its fields far below both, while every file small enough to
 * be an image, an avatar or a voice note keeps the one-request path, where
 * the API reads the bytes (an image's content check, an SVG's sanitizing).
 */
export const ASSET_MULTIPART_UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

/**
 * How long a resolved asset URL may stay in the SDK's GET cache, in ms: never
 * longer than the media token's lifetime, and discounted below it.
 */
export function assetUrlCacheTTL(expiresIn?: number): number {
  const requestedLifetimeMs = (expiresIn ?? DEFAULT_ASSET_URL_EXPIRES_IN_SECONDS) * 1000;
  const boundedLifetimeMs = Math.min(requestedLifetimeMs, ASSET_MEDIA_TOKEN_TTL_MS);
  return Math.floor(boundedLifetimeMs * ASSET_URL_CACHE_LIFETIME_FRACTION);
}

/** An asset as `GET /assets/:id` and `GET /assets` return it. */
export type AssetRecord = Omit<Asset, 'visibility'> & { visibility?: FileVisibility };

/** The asset `POST /assets/upload` returns. */
export type UploadedAsset = Pick<
  Asset,
  'id' | 'sha256' | 'size' | 'mime' | 'ext' | 'visibility' | 'links' | 'variants'
> & {
  originalName?: string;
  metadata?: AssetMetadata;
};

/** An asset's link state after a link or unlink. */
export interface AssetLinkState {
  id: string;
  usageCount: number;
  links: AssetLink[];
  status: Asset['status'];
}

export interface AssetUploadOptions {
  /** Server default: `private`. */
  visibility?: FileVisibility;
  metadata?: AssetMetadata;
  /** Called with `100` once the upload completes. */
  onProgress?: (progress: number) => void;
  /**
   * Bound on each request of the upload, in ms: the multipart POST, or a large
   * file's PUT to storage and its commit. Default {@link ASSET_UPLOAD_TIMEOUT_MS}.
   */
  timeout?: number;
}

/** What `POST /assets/complete` answers: the committed asset. */
export interface CompletedAssetUpload {
  assetId: string;
  file: Pick<
    Asset,
    | 'id'
    | 'sha256'
    | 'size'
    | 'mime'
    | 'ext'
    | 'visibility'
    | 'status'
    | 'usageCount'
    | 'createdAt'
    | 'updatedAt'
    | 'links'
    | 'variants'
  > & { originalName?: string; metadata?: AssetMetadata };
}

/** One progress report from {@link AssetsApi.uploadLarge}. */
export interface LargeUploadProgress {
  /**
   * `hash` reads the bytes once to address them; `upload` sends them straight
   * to storage; `verify` waits while Oxy checks the assembled file's SHA-256.
   */
  phase: 'hash' | 'upload' | 'verify';
  /** Bytes done in this phase. */
  loaded: number;
  /** The file's size. */
  total: number;
}

export interface LargeUploadOptions
  extends Pick<
    DirectUploadTuning,
    'partConcurrency' | 'partAttempts' | 'partTimeoutMs' | 'verifyTimeoutMs' | 'signal'
  > {
  /** Defaults to the Blob's own `type`; one of the two is required. */
  mime?: string;
  /** Defaults to a `File`'s name, else `file`. */
  name?: string;
  /** Server default: `private`. */
  visibility?: FileVisibility;
  metadata?: AssetMetadata;
  onProgress?: (progress: LargeUploadProgress) => void;
}

/** The committed asset, and whether the bytes were already stored (no PUT). */
export type LargeUploadResult = CompletedAssetUpload & { deduplicated: boolean };

/** The largest file Oxy stores (the upload sessions' ceiling, 8 GiB). */
export const MAX_UPLOAD_BYTES = 8 * 1024 ** 3;

/**
 * How much of the file is held in memory at once while hashing, in bytes. The
 * whole point of the large-upload path is that the file never is.
 */
const LARGE_UPLOAD_HASH_CHUNK_BYTES = 8 * 1024 * 1024;

const PRESIGNED_UPLOAD_HEADERS = [
  'if-none-match',
  'content-type',
  'x-amz-checksum-sha256',
  'cache-control',
];

/**
 * The URL and headers of a presigned PUT, refused unless HTTPS and unless every
 * header the API asked for is one a bucket needs — so an Oxy bearer, a cookie or
 * anything else can never ride along to storage.
 */
function presignedUploadRequest(
  init: AssetInitResponse,
  mime: string,
): { target: URL; headers: Headers } {
  const target = new URL(init.uploadUrl);
  if (target.protocol !== 'https:') throw new Error('Presigned uploads require HTTPS');
  const headers = new Headers(init.requiredHeaders);
  headers.forEach((_value, name) => {
    if (!PRESIGNED_UPLOAD_HEADERS.includes(name.toLowerCase()))
      throw new Error('Unsupported required upload header');
  });
  // The URL is signed for the declared MIME, so the PUT names it explicitly
  // rather than trusting the transport to derive it from the body (React
  // Native's does not for every Blob).
  if (mime && !headers.has('Content-Type')) headers.set('Content-Type', mime);
  return { target, headers };
}

/**
 * A Blob's bytes. `Blob.arrayBuffer` where the platform has it (browsers, Node,
 * Bun); React Native's Blob has none, and is read through its `FileReader`,
 * which copies only this Blob's own range out of the native blob store.
 */
function readBlobBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  if (typeof FileReader === 'undefined') {
    return Promise.reject(new Error('This platform cannot read a Blob'));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error('Failed to read file'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * SHA-256 of a Blob, read a chunk at a time, as lowercase hex. The hasher loads
 * through the identity stack's one lazy root (`../crypto/index`), after its
 * polyfill, so it costs an app's startup nothing.
 */
async function sha256OfBlob(blob: Blob, onChunk?: (loaded: number) => void): Promise<string> {
  const { createContentHasher } = await import('../crypto/index');
  const hash = createContentHasher();
  for (let offset = 0; offset < blob.size; offset += LARGE_UPLOAD_HASH_CHUNK_BYTES) {
    const end = Math.min(offset + LARGE_UPLOAD_HASH_CHUNK_BYTES, blob.size);
    hash.update(new Uint8Array(await readBlobBytes(blob.slice(offset, end))));
    onChunk?.(end);
  }
  return hash.digestHex();
}

/**
 * A React Native file uri as a NATIVE Blob, through React Native's own
 * `XMLHttpRequest`: the bytes stay in the native blob store, never in the JS
 * heap. Not `fetch`: the `fetch` Expo installs reads the whole response into a
 * JS ArrayBuffer before it makes a Blob, which a video exhausts on Hermes.
 */
function readNativeFileBlob(uri: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', uri);
    xhr.responseType = 'blob';
    xhr.onload = () => {
      // A local file answers 200 (iOS) or 0 (some Android providers).
      if ((xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300)) && xhr.response) {
        resolve(xhr.response as Blob);
      } else {
        reject(new Error(`Failed to read file from uri (status ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new Error('Failed to read file from uri'));
    xhr.send();
  });
}

/** Release a React Native Blob's native bytes; nothing elsewhere. */
function releaseNativeBlob(blob: Blob): void {
  const close = (blob as Blob & { close?: () => void }).close;
  if (typeof close === 'function') close.call(blob);
}

export interface AssetLinkTarget {
  /**
   * The application that uses the file: its id, or a legacy name the Oxy API
   * maps (`goway`, `mercaria`, `nilo`, `oxy-mail`, `profiles`). Any other
   * string is refused (ADR 0043 D4). A session that belongs to one application
   * is always recorded as that application.
   */
  app: string;
  entityType: string;
  entityId: string;
}

export interface AssetDeleteResult {
  summary: AssetDeleteSummary;
  message: string;
  force?: boolean;
}

export class AssetsApi {
  constructor(protected readonly ctx: OxyContext) {}

  /** Upload already-admitted bytes. Sends required bucket headers, never an Oxy bearer. */
  async putPresignedUpload(init: AssetInitResponse, body: Blob): Promise<void> {
    if (!init.uploadUrl) return; // bytes already exist for this account
    const { target, headers } = presignedUploadRequest(init, body.type);
    const result = await fetch(target.toString(), {
      method: 'PUT',
      body,
      headers,
      credentials: 'omit',
      redirect: 'error',
    });
    if (!result.ok) throw new Error(`Presigned upload failed (${result.status})`);
  }

  // ── Upload ───────────────────────────────────────────────────────────────

  /**
   * Step one of the direct-to-storage upload (`POST /assets/init`): address the
   * bytes by their SHA-256 and get a presigned PUT URL for them.
   *
   * An EMPTY `uploadUrl` means the bytes are already stored for this account:
   * skip the PUT and go straight to {@link completeUpload}. The URL is short-lived
   * (a minute where storage is metered), so hash first and call this last.
   */
  async initUpload(input: AssetInitRequest): Promise<AssetInitResponse> {
    return this.ctx.request<AssetInitResponse>('POST', '/assets/init', input, { cache: false });
  }

  /**
   * Step two (`POST /assets/complete`), after the PUT or after an init that
   * needed none: commit the name, size, MIME, visibility and metadata. Bounded
   * like an upload, not a JSON call: a public file's bytes are moved under the
   * public prefix before it answers, a storage copy as long as the file.
   */
  async completeUpload(input: AssetCompleteRequest): Promise<CompletedAssetUpload> {
    return this.commitUpload(input, ASSET_UPLOAD_TIMEOUT_MS);
  }

  private commitUpload(
    input: AssetCompleteRequest,
    timeout: number,
  ): Promise<CompletedAssetUpload> {
    return this.ctx.request<CompletedAssetUpload>('POST', '/assets/complete', input, {
      cache: false,
      timeout,
    });
  }

  /**
   * Upload a file straight to storage, never through the API: a presigned,
   * parallel, resumable MULTIPART upload (ADR 0047, `./directUpload.ts`), up to
   * {@link MAX_UPLOAD_BYTES} (8 GiB).
   *
   *   hash → open (`POST /assets/uploads`) → PUT 8 MiB+ parts in parallel →
   *   complete → Oxy verifies the SHA-256 → the file
   *
   * The file is hashed {@link LARGE_UPLOAD_HASH_CHUNK_BYTES} at a time and sent
   * part by part, so it is never held in memory whole. A part that fails is
   * retried with backoff, with a fresh URL when storage refuses an expired one;
   * when one keeps failing (the connection is gone) this throws
   * `DirectUploadInterruptedError` and the session stays open: calling again
   * with the same file sends only the parts storage does not hold yet.
   * `options.signal` stops it the same way; {@link abortUpload} discards it.
   * When the bytes are already yours nothing is sent (`deduplicated: true`).
   * `onProgress` reports `hash`, then `upload` (bytes sent — through
   * `XMLHttpRequest` wherever it exists, React Native included), then `verify`.
   *
   * Takes any Blob that can be sliced: a browser's, Node's or Bun's, or React
   * Native's (read through its `FileReader`). {@link upload} calls this itself
   * for a file over {@link ASSET_MULTIPART_UPLOAD_MAX_BYTES}, so most callers
   * never need to.
   */
  async uploadLarge(blob: Blob, options: LargeUploadOptions = {}): Promise<LargeUploadResult> {
    const size = blob.size;
    if (size === 0) throw new Error('Cannot upload an empty file');
    if (size > MAX_UPLOAD_BYTES) throw new Error('A file can be at most 8 GiB');
    const mime = options.mime || blob.type;
    if (!mime) throw new Error('uploadLarge needs a MIME type');
    const name =
      options.name ||
      (typeof File !== 'undefined' && blob instanceof File && blob.name ? blob.name : 'file');
    if (isSvgType(mime)) return this.uploadSvgThroughApi(blob, mime, name, options);
    return this.uploadPresigned(blob, mime, name, options);
  }

  /**
   * The multipart pipeline behind {@link uploadLarge} and a large
   * {@link upload}. `timeout`, when given, bounds the whole upload.
   */
  private async uploadPresigned(
    blob: Blob,
    mime: string,
    name: string,
    options: Omit<LargeUploadOptions, 'mime' | 'name'>,
    timeout?: number,
  ): Promise<LargeUploadResult> {
    const size = blob.size;
    if (size > MAX_UPLOAD_BYTES) throw new Error('A file can be at most 8 GiB');
    const report = (phase: LargeUploadProgress['phase'], loaded: number) =>
      options.onProgress?.({ phase, loaded, total: size });

    // One signal for the caller's stop and the whole-upload bound.
    const controller = new AbortController();
    const stop = () => controller.abort();
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = timeout ? setTimeout(stop, timeout) : undefined;
    try {
      report('hash', 0);
      const sha256 = await sha256OfBlob(blob, (loaded) => report('hash', loaded));
      if (controller.signal.aborted) {
        const error = new Error('Upload aborted');
        error.name = 'AbortError';
        throw error;
      }

      const api = this.directUploadApi();
      const opened = await api.open({
        sha256,
        size,
        mime,
        filename: name,
        ...(options.visibility ? { visibility: options.visibility } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
      });
      const deduplicated = opened.uploadId === null;
      const session = deduplicated
        ? opened
        : await runDirectUpload(api, blob, opened, {
            partConcurrency: options.partConcurrency,
            partAttempts: options.partAttempts,
            partTimeoutMs: options.partTimeoutMs,
            verifyTimeoutMs: options.verifyTimeoutMs,
            signal: controller.signal,
            onProgress: options.onProgress,
          });
      if (deduplicated) report('upload', size);
      const fileId = session.file?.id;
      if (!fileId) throw new Error(`Upload ${session.status}`);
      this.ctx.oxy.cache.delete(`GET:/assets/${enc(fileId)}`);
      const { file } = await this.get(fileId);
      return {
        assetId: file.id,
        file: {
          id: file.id,
          sha256: file.sha256,
          size: file.size,
          mime: file.mime,
          ext: file.ext,
          visibility: file.visibility ?? options.visibility ?? 'private',
          status: file.status,
          usageCount: file.usageCount,
          createdAt: file.createdAt,
          updatedAt: file.updatedAt,
          links: file.links,
          variants: file.variants,
          ...(file.originalName ? { originalName: file.originalName } : {}),
          ...(file.metadata ? { metadata: file.metadata } : {}),
        },
        deduplicated: deduplicated || session.deduplicated === true,
      };
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
    }
  }

  /**
   * Discard an unfinished upload: storage drops its parts and any storage
   * reservation is released. The id is `DirectUploadInterruptedError.uploadId`.
   */
  async abortUpload(uploadId: string): Promise<void> {
    await this.ctx.request('DELETE', `/assets/uploads/${enc(uploadId)}`, undefined, {
      cache: false,
    });
  }

  /** The upload-session calls, as the signed-in person. */
  private directUploadApi(): DirectUploadApi {
    const call = <T>(method: 'GET' | 'POST', url: string, body?: unknown) =>
      this.ctx.request<T>(method, url, body, { cache: false, timeout: 60_000 });
    return {
      open: (request) => call<DirectUploadSession>('POST', '/assets/uploads', request),
      partUrls: (uploadId, partNumbers) =>
        call<DirectUploadSession>('POST', `/assets/uploads/${enc(uploadId)}/parts`, {
          partNumbers,
        }),
      complete: (uploadId) =>
        call<DirectUploadSession>('POST', `/assets/uploads/${enc(uploadId)}/complete`),
      describe: (uploadId) => call<DirectUploadSession>('GET', `/assets/uploads/${enc(uploadId)}`),
    };
  }

  /**
   * An SVG never takes the presigned path: those bytes reach storage without
   * passing through the API, and an SVG is stored only as the API sanitized it
   * (ADR 0043 stage 4c — `/assets/init` refuses it with 415
   * `SVG_UPLOAD_REQUIRES_SANITIZATION`). It goes through {@link upload}, and
   * the committed record is read back in `uploadLarge`'s shape. Its `sha256`
   * is the SANITIZED bytes', so `deduplicated` is always `false` here.
   */
  private async uploadSvgThroughApi(
    blob: Blob,
    mime: string,
    name: string,
    options: LargeUploadOptions,
  ): Promise<LargeUploadResult> {
    options.onProgress?.({ phase: 'upload', loaded: 0, total: blob.size });
    const body = blob.type === mime ? blob : blob.slice(0, blob.size, mime);
    const uploaded = await this.upload(
      typeof File !== 'undefined' ? new File([body], name, { type: mime }) : body,
      {
        ...(options.visibility ? { visibility: options.visibility } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
      },
    );
    options.onProgress?.({ phase: 'upload', loaded: blob.size, total: blob.size });
    const { file } = await this.get(uploaded.file.id);
    return {
      assetId: file.id,
      file: {
        id: file.id,
        sha256: file.sha256,
        size: file.size,
        mime: file.mime,
        ext: file.ext,
        visibility: file.visibility ?? uploaded.file.visibility,
        status: file.status,
        usageCount: file.usageCount,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        links: file.links,
        variants: file.variants,
        ...(file.originalName ? { originalName: file.originalName } : {}),
        ...(file.metadata ? { metadata: file.metadata } : {}),
      },
      deduplicated: false,
    };
  }

  /**
   * Upload a file. Accepts a web `File`/`Blob` or a React Native
   * `{ uri, type?, name?, size? }` descriptor, of any size.
   *
   * A file up to {@link ASSET_MULTIPART_UPLOAD_MAX_BYTES} is one multipart
   * `POST /assets/upload`. A larger one goes straight to storage
   * (hash → `/assets/init` → presigned PUT → `/assets/complete`, as
   * {@link uploadLarge}) and is answered in the same shape, because no request
   * through the API's proxy may carry it. An SVG always goes through the API,
   * which sanitizes it.
   *
   * On React Native a descriptor whose `size` says it is small goes into the
   * multipart body as-is (RN's FormData reads the file from disk). One with no
   * `size`, or a larger one, is read into a native Blob first to learn its
   * size, and a large one is hashed and PUT from it. On the web a plain
   * `{ uri }` cannot be read by FormData (it would upload `[object Object]` —
   * a 0-byte asset), so the uri is materialised into a Blob first. An empty
   * file throws.
   */
  async upload(
    file: AssetUploadInput,
    options: AssetUploadOptions = {},
  ): Promise<{ file: UploadedAsset }> {
    const fileName = 'name' in file && file.name ? file.name : 'unknown';
    const fileSize = 'size' in file && file.size ? file.size : 0;
    const timeout = options.timeout ?? ASSET_UPLOAD_TIMEOUT_MS;

    let part: Blob | RNFileDescriptor;
    let declaredMime = '';
    let nativeBlob: Blob | undefined;
    if (
      (typeof File !== 'undefined' && file instanceof File) ||
      (typeof Blob !== 'undefined' && file instanceof Blob)
    ) {
      part = file;
    } else if ('uri' in file && typeof (file as RNFileDescriptor).uri === 'string') {
      const descriptor = file as RNFileDescriptor;
      declaredMime = descriptor.type ?? '';
      if (isReactNative()) {
        part = descriptor;
        const knownSmall =
          typeof descriptor.size === 'number' &&
          descriptor.size > 0 &&
          descriptor.size <= ASSET_MULTIPART_UPLOAD_MAX_BYTES;
        if (!knownSmall && !isSvgType(declaredMime)) {
          let read: Blob | undefined;
          try {
            read = await readNativeFileBlob(descriptor.uri);
          } catch (error) {
            // A uri only RN's FormData can open: its size cannot be learned,
            // so it goes multipart as it always did.
            logger.warn(
              'Could not read the file to learn its size',
              { component: 'oxy.assets' },
              error,
            );
          }
          if (read && read.size === 0) {
            releaseNativeBlob(read);
            throw new Error('Cannot upload an empty file');
          }
          if (read && read.size > ASSET_MULTIPART_UPLOAD_MAX_BYTES) {
            nativeBlob = read;
            part = read;
          } else if (read) {
            // Small after all: RN's FormData reads it from disk, as ever.
            releaseNativeBlob(read);
          }
        }
      } else {
        // `fetch` resolves blob:, data: and http(s): uris on the web.
        const res = await fetch(descriptor.uri);
        if (!res.ok) {
          throw new Error(`Failed to read file from uri (status ${res.status})`);
        }
        const fetched = await res.blob();
        const blob =
          fetched.type === '' && descriptor.type
            ? new Blob([fetched], { type: descriptor.type })
            : fetched;
        if (blob.size === 0) {
          throw new Error('Cannot upload an empty file');
        }
        part = blob;
      }
    } else {
      throw new Error(
        'Unsupported file input: expected File, Blob, or { uri, type?, name?, size? } descriptor',
      );
    }

    try {
      let response: { file: UploadedAsset };
      // The type the multipart part would have carried, as multer records it:
      // RN's FormData sends a descriptor's `type`, a browser a Blob's own.
      const partType = isBlob(part) ? part.type : '';
      const mime =
        (nativeBlob ? declaredMime || partType : partType || declaredMime) ||
        'application/octet-stream';
      if (isBlob(part) && part.size > ASSET_MULTIPART_UPLOAD_MAX_BYTES && !isSvgType(mime)) {
        const completed = await this.uploadPresigned(
          part,
          mime,
          fileName,
          {
            ...(options.visibility ? { visibility: options.visibility } : {}),
            ...(options.metadata ? { metadata: options.metadata } : {}),
          },
          timeout,
        );
        response = { file: uploadedAssetFrom(completed.file) };
      } else {
        const formData = new FormData();
        formData.append('file', part as Blob, fileName);
        if (options.visibility) formData.append('visibility', options.visibility);
        if (options.metadata) formData.append('metadata', JSON.stringify(options.metadata));
        response = await this.ctx.request<{ file: UploadedAsset }>(
          'POST',
          '/assets/upload',
          formData,
          { cache: false, timeout },
        );
      }
      options.onProgress?.(100);
      return response;
    } catch (error) {
      logger.error('File upload error', error, { component: 'oxy.assets' });
      (error as Error & { fileContext?: Record<string, unknown> }).fileContext = {
        fileName,
        fileSize,
      };
      throw error;
    } finally {
      if (nativeBlob) releaseNativeBlob(nativeBlob);
    }
  }

  /**
   * Upload a public avatar and link it to `userId`'s profile. Does not change
   * the profile's `avatar` field — set it with `users.updateMe`.
   */
  async uploadAvatar(
    file: AssetUploadInput,
    userId: string,
    app = 'profiles',
  ): Promise<{ file: UploadedAsset }> {
    const asset = await this.upload(file, { visibility: 'public' });
    await this.link(
      asset.file.id,
      { app, entityType: 'avatar', entityId: userId },
      { visibility: 'public' },
    );
    return asset;
  }

  // ── Links ────────────────────────────────────────────────────────────────

  /**
   * Record that an application uses one of YOUR assets (what keeps it alive).
   * The reference itself never changes the asset's visibility;
   * `options.visibility` is an explicit change you, the owner, make with it.
   * A backend should use `OxyServer.assets.references.add` instead.
   */
  async link(
    fileId: string,
    target: AssetLinkTarget,
    options: { visibility?: FileVisibility; webhookUrl?: string } = {},
  ): Promise<{ assetId: string; file: AssetLinkState }> {
    const body: AssetLinkTarget & { visibility?: FileVisibility; webhookUrl?: string } = {
      ...target,
    };
    if (options.visibility) body.visibility = options.visibility;
    if (options.webhookUrl) body.webhookUrl = options.webhookUrl;
    const res = await this.ctx.request<{ assetId: string; file: AssetLinkState }>(
      'POST',
      `/assets/${enc(fileId)}/links`,
      body,
      {
        cache: false,
      },
    );
    this.ctx.oxy.cache.delete(`GET:/assets/${enc(fileId)}`);
    return res;
  }

  /**
   * Remove an application's use of an asset: any reference on your own asset,
   * or one you created on somebody else's (404 otherwise).
   */
  async unlink(fileId: string, target: AssetLinkTarget): Promise<{ file: AssetLinkState }> {
    const res = await this.ctx.request<{ file: AssetLinkState }>(
      'DELETE',
      `/assets/${enc(fileId)}/links`,
      target,
      { cache: false },
    );
    this.ctx.oxy.cache.delete(`GET:/assets/${enc(fileId)}`);
    return res;
  }

  // ── Applications with access ─────────────────────────────────────────────

  /**
   * The applications that can read one of YOUR files with their own service
   * token (ADR 0043 stage 4c): one that stored the file for you (`via:
   * 'upload'` — an upload, import or recording it made on your behalf) or one
   * you attached it to yourself (`'link'`). 404 for a file that is not yours.
   */
  async listAppAccess(fileId: string): Promise<FileApplicationAccess[]> {
    const res = await this.ctx.request<{ fileId: string; applications: FileApplicationAccess[] }>(
      'GET',
      `/assets/${enc(fileId)}/access`,
      undefined,
      { cache: false },
    );
    return Array.isArray(res?.applications) ? res.applications : [];
  }

  /**
   * Take an application's access to one of YOUR files away: it can no longer
   * read it, and every playback it started stops at once (`streamsRevoked`).
   * It stays revoked when the application stores the same bytes for you
   * again; attaching the file to that application yourself ({@link link})
   * gives it back. Revoking an application without access answers the same.
   */
  async revokeAppAccess(
    fileId: string,
    applicationId: string,
  ): Promise<FileApplicationAccessRevocation> {
    return this.ctx.request<FileApplicationAccessRevocation>(
      'DELETE',
      `/assets/${enc(fileId)}/access/${enc(applicationId)}`,
      undefined,
      { cache: false },
    );
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /** An asset's record: size, mime, visibility, links, variants. */
  async get(fileId: string): Promise<{ assetId: string; file: AssetRecord }> {
    return this.ctx.request('GET', `/assets/${enc(fileId)}`, undefined, {
      cache: true,
      cacheTTL: ASSET_TTL,
    });
  }

  /**
   * The signed-in user's files. Each says whether an application uses it
   * (`inUse`); `inUse: false` lists only the files no application uses — never
   * removed for you, shown so you can decide (ADR 0043 D5).
   *
   * By default the LIBRARY: `active` files and `blocked` ones (removed after a
   * legal claim), newest first — never a file in trash. `status: 'trash'`
   * lists the trash instead, most recently trashed first (`trashedAt`); each
   * can be {@link restore}d or {@link delete}d for good.
   */
  async list(
    params: { limit?: number; offset?: number; inUse?: boolean; status?: 'trash' } = {},
  ): Promise<{ files: AssetRecord[]; total: number; hasMore: boolean }> {
    const query: Record<string, number | string> = {};
    if (params.limit) query.limit = params.limit;
    if (params.offset) query.offset = params.offset;
    if (params.inUse !== undefined) query.inUse = String(params.inUse);
    if (params.status) query.status = params.status;
    return this.ctx.request('GET', '/assets', query, { cache: false });
  }

  /** The account's storage usage, aggregated from its assets. */
  async usage(): Promise<AccountStorageUsageResponse> {
    return this.ctx.request<AccountStorageUsageResponse>('GET', '/storage/usage', undefined, {
      cache: false,
    });
  }

  // ── URLs ─────────────────────────────────────────────────────────────────

  /**
   * A URL for `fileId` valid for the CURRENT caller, whatever its visibility
   * (`GET /assets/:id/url`): the CDN form for a public asset, an API-origin
   * stream URL with a scoped media token for a private one the caller may
   * read. Returned exactly as the API produced it.
   *
   * Throws {@link AssetUrlResolutionError} when the API returns no URL or the
   * request fails (401/403/404 included) — deliberately never falling back to
   * {@link publicUrl}, which would hand back a known-404 for a private asset and
   * hide the real failure.
   *
   * Cached per identity for well under the media token's lifetime.
   */
  async url(fileId: string, variant?: string, expiresIn?: number): Promise<string> {
    let url: string | undefined;
    try {
      url = await this.resolveUrl(fileId, variant, expiresIn);
    } catch (error) {
      throw new AssetUrlResolutionError(fileId, variant, extractErrorStatus(error), error);
    }
    if (!url) {
      throw new AssetUrlResolutionError(fileId, variant, undefined);
    }
    return url;
  }

  /**
   * A synchronous `<img src>` URL for an asset KNOWN to be **public** — a pure
   * string builder with no knowledge of visibility: `${cloudURL}/<id>[?variant]`.
   * A private or unlisted asset 404s there; use {@link url}.
   *
   * It never embeds the caller's bearer token (the string lands in DOM
   * attributes, network panels, caches and logs). With `expiresIn` it builds
   * the API-origin stream form, still credential-less: there is no synchronous
   * private-asset path.
   *
   * Pass `options.revision` from the rendition's ready timestamp (HLS:
   * `hlsReadyAt`) so a repaired generation has its own browser/cache identity.
   * This option is only available on public CDN variant URLs.
   */
  publicUrl(
    fileId: string,
    variant?: string,
    expiresIn?: number,
    options?: AssetPublicUrlOptions,
  ): string {
    let revision: string | undefined;
    if (options?.revision !== undefined) {
      if (!variant || expiresIn) {
        throw new TypeError('A rendition revision requires a public CDN variant URL');
      }
      const timestamp = new Date(options.revision);
      if (!Number.isFinite(timestamp.getTime())) {
        throw new TypeError('A rendition revision must be its ready timestamp');
      }
      revision = timestamp.toISOString();
      if (revision.length !== 24) {
        throw new TypeError('A rendition revision must use a four-digit UTC year');
      }
    }
    if (!expiresIn) {
      const variantQs = variant ? `?variant=${encodeURIComponent(variant)}` : '';
      const revisionQs = revision ? `&revision=${encodeURIComponent(revision)}` : '';
      return `${this.ctx.oxy.cloudURL}/${enc(fileId)}${variantQs}${revisionQs}`;
    }
    const params = new URLSearchParams();
    if (variant) params.set('variant', variant);
    params.set('expiresIn', String(expiresIn));
    params.set('fallback', 'placeholderVisible');
    return `${this.ctx.oxy.baseURL}/assets/${enc(fileId)}/stream?${params.toString()}`;
  }

  /**
   * The URL {@link url} resolved for `fileId` for the CURRENT caller, while it
   * is still cached, or `undefined`. Synchronous and never a request, so a
   * render can show an already-resolved URL in its first frame and call
   * {@link url} only on a miss. Same identity-scoped cache and TTL as
   * {@link url}: another account's scoped media URL is never returned, and a
   * trashed, restored, deleted or re-scoped asset is a miss.
   */
  cachedUrl(fileId: string, variant?: string, expiresIn?: number): string | undefined {
    const { path, params } = urlRequest(fileId, variant, expiresIn);
    return this.ctx.http.peekCachedGet<{ url?: string }>(path, params)?.url || undefined;
  }

  /**
   * The URL to render for an asset reference RIGHT NOW, without waiting:
   *
   * - a reference that is already an absolute `http(s)` URL (a media URL the
   *   server resolved) comes back unchanged;
   * - else the URL {@link url} already resolved for this caller
   *   ({@link cachedUrl});
   * - else {@link publicUrl}: right for a public asset, a 404 for a private one
   *   until {@link url} has resolved it.
   *
   * Resolve a private asset with {@link url} (services: `useFileDownloadUrl`);
   * from then on this answers the resolved URL.
   */
  renderUrl(ref: string, variant?: string): string {
    if (ref.startsWith('http://') || ref.startsWith('https://')) return ref;
    return this.cachedUrl(ref, variant) ?? this.publicUrl(ref, variant);
  }

  /**
   * {@link url} for many assets — each with its OWN variant — in one round
   * trip. Ids the caller cannot read (or that do not exist) are OMITTED from
   * the map: no CDN fallback, so a grid never renders a known-404. Keyed by
   * `fileId`.
   */
  async urls(
    requests: Array<{ fileId: string; variant?: string }>,
    options?: { expiresIn?: number; context?: string },
  ): Promise<Record<string, string>> {
    const response = await this.access(requests, options);
    const urls: Record<string, string> = {};
    for (const [id, result] of Object.entries(response.results ?? {})) {
      if (result.allowed && result.url) urls[id] = result.url;
    }
    return urls;
  }

  /**
   * The raw per-file access envelope behind {@link urls}
   * (`POST /assets/batch-access`): `allowed`, `url`, `visibility`, `mime` or
   * `error` per file. Blank ids are dropped and exact `(fileId, variant)`
   * duplicates collapsed; an empty list makes no call. The server caps a batch
   * at 100 entries.
   */
  async access(
    requests: Array<{ fileId: string; variant?: string }>,
    options?: { expiresIn?: number; context?: string },
  ): Promise<BatchFileAccessResponse> {
    const files = dedupeFileAccessRequests(requests);
    if (files.length === 0) return { results: {} };
    const body: { files: typeof files; expiresIn?: number; context?: string } = { files };
    if (typeof options?.expiresIn === 'number') body.expiresIn = options.expiresIn;
    if (typeof options?.context === 'string') body.context = options.context;
    return this.ctx.request<BatchFileAccessResponse>('POST', '/assets/batch-access', body, {
      cache: false,
    });
  }

  // ── Content ──────────────────────────────────────────────────────────────

  /** An asset's content as text. */
  async text(fileId: string, variant?: string): Promise<string> {
    const response = await this.fetchContent(fileId, variant);
    return response.text();
  }

  /** An asset's content as a Blob. */
  async blob(fileId: string, variant?: string): Promise<Blob> {
    const response = await this.fetchContent(fileId, variant);
    return response.blob();
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Delete an asset. With active links the server refuses and answers the
   * summary of what would break, unless `force`.
   */
  async delete(fileId: string, options: { force?: boolean } = {}): Promise<AssetDeleteResult> {
    const url = `/assets/${enc(fileId)}${options.force ? '?force=true' : ''}`;
    const res = await this.ctx.request<AssetDeleteResult>('DELETE', url, undefined, {
      cache: false,
    });
    this.evict(fileId);
    return res;
  }

  /**
   * Move your own asset to the trash (ADR 0043 D5): it stops being served at
   * once and is kept — an account's trash never expires — until you
   * {@link restore} or {@link delete} it. Applications using it are told
   * (`file.trashed`). Already in trash: answered as it is.
   */
  async trash(fileId: string): Promise<{
    file: { id: string; status: Asset['status']; trashedAt: string | null; usageCount: number };
  }> {
    const res = await this.ctx.request<{
      file: { id: string; status: Asset['status']; trashedAt: string | null; usageCount: number };
    }>('POST', `/assets/${enc(fileId)}/trash`, undefined, { cache: false });
    // Trash changes the record AND what may be served.
    this.evict(fileId);
    return res;
  }

  /**
   * Restore an asset from the trash. A file not in trash — restored or deleted
   * meanwhile, or `blocked` after a content claim — is refused with 409
   * `FILE_NOT_IN_TRASH`.
   */
  async restore(
    fileId: string,
  ): Promise<{ file: { id: string; status: Asset['status']; usageCount: number } }> {
    const res = await this.ctx.request<{
      file: { id: string; status: Asset['status']; usageCount: number };
    }>('POST', `/assets/${enc(fileId)}/restore`, undefined, { cache: false });
    // Restoring changes the record AND what may be served, like trash.
    this.evict(fileId);
    return res;
  }

  /** Change an asset's visibility. */
  async setVisibility(
    fileId: string,
    visibility: FileVisibility,
  ): Promise<{ file: { id: string; visibility: FileVisibility; updatedAt: string } }> {
    const res = await this.ctx.request<{
      file: { id: string; visibility: FileVisibility; updatedAt: string };
    }>('PATCH', `/assets/${enc(fileId)}/visibility`, { visibility }, { cache: false });
    // Visibility changes the record AND the resolved URL (CDN vs signed).
    this.evict(fileId);
    return res;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async resolveUrl(
    fileId: string,
    variant?: string,
    expiresIn?: number,
  ): Promise<string | undefined> {
    const { path, params } = urlRequest(fileId, variant, expiresIn);
    const res = await this.ctx.request<{ url?: string }>('GET', path, params, {
      cache: true,
      cacheTTL: assetUrlCacheTTL(expiresIn),
    });
    return res?.url || undefined;
  }

  private async fetchContent(fileId: string, variant?: string): Promise<Response> {
    const url = await this.resolveUrl(fileId, variant);
    if (!url) throw new Error('No download URL returned for asset');
    const response = await fetch(url, {
      // The resolved media URL carries its own bounded authority.
      credentials: 'omit',
    });
    if (!response?.ok) {
      throw new Error(`Failed to fetch asset content (status ${response?.status})`);
    }
    return response;
  }

  /** Drop the cached record and every cached URL variant of an asset, in one pass. */
  private evict(fileId: string): void {
    this.ctx.http.invalidateCache({
      keys: [`GET:/assets/${enc(fileId)}`],
      prefixes: [`GET:/assets/${enc(fileId)}/url`],
    });
  }
}

const enc = encodeURIComponent;

/**
 * The `GET /assets/:id/url` request {@link AssetsApi.url} sends and
 * {@link AssetsApi.cachedUrl} looks up: one builder, so the two can never key
 * the cache differently.
 */
function urlRequest(
  fileId: string,
  variant?: string,
  expiresIn?: number,
): { path: string; params: Record<string, string | number> | undefined } {
  const params: Record<string, string | number> = {};
  if (variant) params.variant = variant;
  if (expiresIn) params.expiresIn = expiresIn;
  return {
    path: `/assets/${enc(fileId)}/url`,
    params: Object.keys(params).length ? params : undefined,
  };
}

/** A Blob, from any runtime: a web, Node or Bun Blob, or React Native's own. */
function isBlob(value: Blob | RNFileDescriptor): value is Blob {
  return (
    (typeof Blob !== 'undefined' && value instanceof Blob) ||
    (typeof (value as Blob).slice === 'function' && typeof (value as Blob).size === 'number')
  );
}

/**
 * A committed presigned upload in `POST /assets/upload`'s answer shape, field
 * for field: what `upload` returns must not depend on which path the file took.
 */
function uploadedAssetFrom(file: CompletedAssetUpload['file']): UploadedAsset {
  return {
    id: file.id,
    sha256: file.sha256,
    size: file.size,
    mime: file.mime,
    ext: file.ext,
    visibility: file.visibility,
    links: file.links,
    variants: file.variants,
    ...(file.originalName !== undefined ? { originalName: file.originalName } : {}),
    ...(file.metadata !== undefined ? { metadata: file.metadata } : {}),
  };
}

/** Every spelling of the SVG type (`image/svg+xml`, with parameters or not). */
function isSvgType(mime: string): boolean {
  return mime.split(';')[0].trim().toLowerCase().startsWith('image/svg');
}

/**
 * Drop blank ids and collapse exact `(fileId, variant)` duplicates (first wins,
 * order kept). Two variants of one file are both kept — but the response is
 * keyed by `fileId`, so a caller needing both must issue separate calls.
 */
function dedupeFileAccessRequests(
  requests: Array<{ fileId: string; variant?: string }>,
): Array<{ fileId: string; variant?: string }> {
  const seen = new Set<string>();
  const out: Array<{ fileId: string; variant?: string }> = [];
  for (const req of requests) {
    if (typeof req?.fileId !== 'string' || req.fileId.trim().length === 0) continue;
    const key = `${req.fileId}\u0000${req.variant ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(
      req.variant === undefined
        ? { fileId: req.fileId }
        : { fileId: req.fileId, variant: req.variant },
    );
  }
  return out;
}
