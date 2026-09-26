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
 *
 * The service-token asset routes (metadata by id / by hash, linked download
 * URLs) are `OxyServer`'s `assets` (`@oxy.so/core/server`).
 */
import { isReactNative } from '@oxy.so/protocol/random';
import type { OxyContext } from '../client/context';
import { logger } from '../logger';
import type {
  AccountStorageUsageResponse,
  Asset,
  AssetDeleteSummary,
  AssetLink,
  AssetMetadata,
  AssetUploadInput,
  BatchFileAccessResponse,
  FileVisibility,
  RNFileDescriptor,
} from '../models/interfaces';
import { AssetUrlResolutionError } from '../OxyServices.errors';
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
export type UploadedAsset = Pick<Asset, 'id' | 'sha256' | 'size' | 'mime' | 'ext' | 'visibility' | 'links' | 'variants'> & {
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
}

export interface AssetLinkTarget {
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

  // ── Upload ───────────────────────────────────────────────────────────────

  /**
   * Upload a file. Accepts a web `File`/`Blob` or a React Native
   * `{ uri, type?, name?, size? }` descriptor.
   *
   * On React Native the descriptor goes into the multipart body as-is (RN's
   * FormData reads the file from disk). On the web a plain `{ uri }` cannot be
   * read by FormData (it would upload `[object Object]` — a 0-byte asset), so
   * the uri is materialised into a Blob first; an empty result throws.
   */
  async upload(file: AssetUploadInput, options: AssetUploadOptions = {}): Promise<{ file: UploadedAsset }> {
    const fileName = 'name' in file && file.name ? file.name : 'unknown';
    const fileSize = 'size' in file && file.size ? file.size : 0;

    const formData = new FormData();
    if ((typeof File !== 'undefined' && file instanceof File) || (typeof Blob !== 'undefined' && file instanceof Blob)) {
      formData.append('file', file, fileName);
    } else if ('uri' in file && typeof (file as RNFileDescriptor).uri === 'string') {
      const descriptor = file as RNFileDescriptor;
      if (isReactNative()) {
        // No in-JS Blob on RN: that fails on Hermes for ArrayBuffer-backed Blobs.
        formData.append('file', descriptor as unknown as Blob, fileName);
      } else {
        // `fetch` resolves blob:, data: and http(s): uris on the web.
        const res = await fetch(descriptor.uri);
        if (!res.ok) {
          throw new Error(`Failed to read file from uri (status ${res.status})`);
        }
        const fetched = await res.blob();
        const blob = fetched.type === '' && descriptor.type ? new Blob([fetched], { type: descriptor.type }) : fetched;
        if (blob.size === 0) {
          throw new Error('Cannot upload an empty file');
        }
        formData.append('file', blob, fileName);
      }
    } else {
      throw new Error('Unsupported file input: expected File, Blob, or { uri, type?, name?, size? } descriptor');
    }
    if (options.visibility) formData.append('visibility', options.visibility);
    if (options.metadata) formData.append('metadata', JSON.stringify(options.metadata));

    try {
      const response = await this.ctx.request<{ file: UploadedAsset }>('POST', '/assets/upload', formData, { cache: false });
      options.onProgress?.(100);
      return response;
    } catch (error) {
      logger.error('File upload error', error, { component: 'oxy.assets' });
      (error as Error & { fileContext?: Record<string, unknown> }).fileContext = { fileName, fileSize };
      throw error;
    }
  }

  /**
   * Upload a public avatar and link it to `userId`'s profile. Does not change
   * the profile's `avatar` field — set it with `users.updateMe`.
   */
  async uploadAvatar(file: AssetUploadInput, userId: string, app = 'profiles'): Promise<{ file: UploadedAsset }> {
    const asset = await this.upload(file, { visibility: 'public' });
    await this.link(asset.file.id, { app, entityType: 'avatar', entityId: userId }, { visibility: 'public' });
    return asset;
  }

  // ── Links ────────────────────────────────────────────────────────────────

  /** Link an asset to an entity (what keeps it alive). */
  async link(
    fileId: string,
    target: AssetLinkTarget,
    options: { visibility?: FileVisibility; webhookUrl?: string } = {},
  ): Promise<{ assetId: string; file: AssetLinkState }> {
    const body: AssetLinkTarget & { visibility?: FileVisibility; webhookUrl?: string } = { ...target };
    if (options.visibility) body.visibility = options.visibility;
    if (options.webhookUrl) body.webhookUrl = options.webhookUrl;
    const res = await this.ctx.request<{ assetId: string; file: AssetLinkState }>('POST', `/assets/${enc(fileId)}/links`, body, {
      cache: false,
    });
    this.ctx.oxy.cache.delete(`GET:/assets/${enc(fileId)}`);
    return res;
  }

  /** Remove an asset's link to an entity. */
  async unlink(fileId: string, target: AssetLinkTarget): Promise<{ file: AssetLinkState }> {
    const res = await this.ctx.request<{ file: AssetLinkState }>('DELETE', `/assets/${enc(fileId)}/links`, target, { cache: false });
    this.ctx.oxy.cache.delete(`GET:/assets/${enc(fileId)}`);
    return res;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  /** An asset's record: size, mime, visibility, links, variants. */
  async get(fileId: string): Promise<{ assetId: string; file: AssetRecord }> {
    return this.ctx.request('GET', `/assets/${enc(fileId)}`, undefined, { cache: true, cacheTTL: ASSET_TTL });
  }

  /** The signed-in user's files, newest first. */
  async list(params: { limit?: number; offset?: number } = {}): Promise<{ files: AssetRecord[]; total: number; hasMore: boolean }> {
    const query: Record<string, number> = {};
    if (params.limit) query.limit = params.limit;
    if (params.offset) query.offset = params.offset;
    return this.ctx.request('GET', '/assets', query, { cache: false });
  }

  /** The account's storage usage, aggregated from its assets. */
  async usage(): Promise<AccountStorageUsageResponse> {
    return this.ctx.request<AccountStorageUsageResponse>('GET', '/storage/usage', undefined, { cache: false });
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
   */
  publicUrl(fileId: string, variant?: string, expiresIn?: number): string {
    if (!expiresIn) {
      const variantQs = variant ? `?variant=${encodeURIComponent(variant)}` : '';
      return `${this.ctx.oxy.cloudURL}/${enc(fileId)}${variantQs}`;
    }
    const params = new URLSearchParams();
    if (variant) params.set('variant', variant);
    params.set('expiresIn', String(expiresIn));
    params.set('fallback', 'placeholderVisible');
    return `${this.ctx.oxy.baseURL}/assets/${enc(fileId)}/stream?${params.toString()}`;
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
    return this.ctx.request<BatchFileAccessResponse>('POST', '/assets/batch-access', body, { cache: false });
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
    const res = await this.ctx.request<AssetDeleteResult>('DELETE', url, undefined, { cache: false });
    this.evict(fileId);
    return res;
  }

  /** Restore an asset from the trash. */
  async restore(fileId: string): Promise<{ file: { id: string; status: Asset['status']; usageCount: number } }> {
    const res = await this.ctx.request<{ file: { id: string; status: Asset['status']; usageCount: number } }>(
      'POST',
      `/assets/${enc(fileId)}/restore`,
      undefined,
      { cache: false },
    );
    this.ctx.oxy.cache.delete(`GET:/assets/${enc(fileId)}`);
    return res;
  }

  /** Change an asset's visibility. */
  async setVisibility(
    fileId: string,
    visibility: FileVisibility,
  ): Promise<{ file: { id: string; visibility: FileVisibility; updatedAt: string } }> {
    const res = await this.ctx.request<{ file: { id: string; visibility: FileVisibility; updatedAt: string } }>(
      'PATCH',
      `/assets/${enc(fileId)}/visibility`,
      { visibility },
      { cache: false },
    );
    // Visibility changes the record AND the resolved URL (CDN vs signed).
    this.evict(fileId);
    return res;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async resolveUrl(fileId: string, variant?: string, expiresIn?: number): Promise<string | undefined> {
    const params: Record<string, string | number> = {};
    if (variant) params.variant = variant;
    if (expiresIn) params.expiresIn = expiresIn;
    const res = await this.ctx.request<{ url?: string }>(
      'GET',
      `/assets/${enc(fileId)}/url`,
      Object.keys(params).length ? params : undefined,
      { cache: true, cacheTTL: assetUrlCacheTTL(expiresIn) },
    );
    return res?.url || undefined;
  }

  private async fetchContent(fileId: string, variant?: string): Promise<Response> {
    const url = await this.resolveUrl(fileId, variant);
    if (!url) throw new Error('No download URL returned for asset');
    const response = await fetch(url, {
      // Cookies only to the API's own origin — never to a caller-supplied host.
      credentials: isSameOrigin(url, this.ctx.oxy.baseURL) ? 'include' : 'omit',
    });
    if (!response?.ok) {
      throw new Error(`Failed to fetch asset content (status ${response?.status})`);
    }
    return response;
  }

  /** Drop the cached record and every cached URL variant of an asset, in one pass. */
  private evict(fileId: string): void {
    this.ctx.http.invalidateCache({ keys: [`GET:/assets/${enc(fileId)}`], prefixes: [`GET:/assets/${enc(fileId)}/url`] });
  }
}

const enc = encodeURIComponent;

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
    out.push(req.variant === undefined ? { fileId: req.fileId } : { fileId: req.fileId, variant: req.variant });
  }
  return out;
}

function isSameOrigin(url: string, baseURL: string): boolean {
  try {
    return new URL(url).origin === new URL(baseURL).origin;
  } catch {
    return false;
  }
}
