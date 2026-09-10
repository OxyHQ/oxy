import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FileMetadata } from '@oxy.so/core';

/**
 * The variant-aware batch resolver contract (`@oxy.so/core`).
 *
 * `getFileDownloadUrls` takes a per-file `{ fileId, variant }` list and returns
 * a map keyed by `fileId`; ids that are denied or missing are OMITTED (never an
 * empty string), and PRIVATE assets resolve to a working scoped-media-token
 * stream URL. Typed here rather than `Pick<OxyServices, …>` so this file states
 * the exact contract it depends on.
 */
export interface AssetUrlBatchResolver {
  getFileDownloadUrls(
    requests: Array<{ fileId: string; variant?: string }>,
    options?: { expiresIn?: number; context?: string },
  ): Promise<Record<string, string>>;
}

/**
 * Private-safe grid/thumbnail URL resolution.
 *
 * The synchronous `oxyServices.getFileDownloadUrl(id, variant)` always yields
 * the public CDN origin (`cloud.oxy.so/<id>`), which 404s for PRIVATE assets —
 * and uploads default to private. Thumbnails and previews therefore have to be
 * resolved through the authenticated batch endpoint, which returns a working
 * `/assets/:id/stream?…&mt=<scoped media token>` URL for private files.
 *
 * This hook resolves an ENTIRE page of files in ONE (chunked) batch request
 * rather than N per-tile calls, and caches the result in React Query keyed by
 * the (fileId, variant) set. `staleTime` is deliberately shorter than the
 * server media-token TTL so a tile never renders a URL whose token has already
 * expired.
 *
 * Optimistic (`temp-…` / `uploading`) entries are NEVER resolved here — an
 * asset URL must never be built from an id the server does not yet know. Their
 * preview comes from the locally-picked uri (see {@link fileThumbSource}).
 */

/** Server media-token lifetime we request for each resolved URL (seconds). */
const ASSET_URL_TTL_SECONDS = 600; // 10 minutes
/**
 * Refresh window. Kept below {@link ASSET_URL_TTL_SECONDS} so React Query
 * re-resolves in the background before a rendered URL's token can die.
 */
const ASSET_URL_STALE_MS = 5 * 60 * 1000; // 5 minutes
const ASSET_URL_GC_MS = 30 * 60 * 1000;
/** Server-side batch cap for `POST /assets/batch-access` — chunk beyond this. */
const BATCH_CAP = 100;

/** React Query prefix — scoped media URLs must never leak across accounts. */
export const ASSET_DOWNLOAD_URLS_QUERY_KEY = 'assetDownloadUrls' as const;

/**
 * True when a file is an optimistic placeholder that has not been persisted by
 * the server yet — either its id is still the client-minted `temp-…` id, or it
 * carries the `uploading` flag. Mirrors the `temp-` id guard precedent in
 * `@oxy.so/core`'s `avatarUtils.updateAvatarVisibility`.
 */
export function isOptimisticFile(file: Pick<FileMetadata, 'id' | 'metadata'>): boolean {
  if (typeof file.id === 'string' && file.id.startsWith('temp-')) return true;
  return file.metadata?.uploading === true;
}

/** Grid thumbnail variant for a file, or `undefined` when it needs no URL. */
function thumbVariantFor(file: FileMetadata): string | undefined {
  if (file.contentType.startsWith('video/')) return 'poster';
  if (file.contentType.startsWith('image/')) return 'thumb';
  return undefined;
}

/**
 * Locally-picked preview uri stashed on an optimistic entry's metadata by the
 * upload flow, if present.
 */
function localPreviewUri(file: FileMetadata): string | undefined {
  const uri = (file.metadata as Record<string, unknown> | undefined)?.localPreviewUri;
  return typeof uri === 'string' && uri.length > 0 ? uri : undefined;
}

/**
 * Resolve the image source for a grid tile.
 *
 * - Optimistic entry → its locally-picked preview uri (never an asset URL).
 * - Persisted entry → the private-safe URL from {@link useResolvedFileUrls},
 *   or `undefined` while it is still resolving / was denied (tile shows a
 *   placeholder instead of a guaranteed-404 CDN URL).
 */
export function fileThumbSource(
  file: FileMetadata,
  resolved: ReadonlyMap<string, string>,
): string | undefined {
  if (isOptimisticFile(file)) {
    return localPreviewUri(file);
  }
  return resolved.get(file.id);
}

/**
 * Batch-resolve private-safe thumbnail URLs for the given files.
 *
 * Only image/video, non-optimistic files are resolved (documents render an
 * icon, optimistic entries render their local preview). Returns a stable
 * `Map<fileId, url>`; missing entries mean "not resolved yet or access denied".
 */
export function useResolvedFileUrls(
  oxyServices: AssetUrlBatchResolver,
  files: FileMetadata[],
  /** Active viewer account id — media tokens are minted per user; must be in the query key. */
  viewerId?: string | null,
): ReadonlyMap<string, string> {
  const viewerKey = viewerId ?? '';
  const requests = useMemo(() => {
    const list: Array<{ fileId: string; variant?: string }> = [];
    for (const file of files) {
      if (isOptimisticFile(file)) continue;
      const variant = thumbVariantFor(file);
      if (!variant) continue;
      list.push({ fileId: file.id, variant });
    }
    return list;
  }, [files]);

  // A content signature so the query key is stable across renders while the
  // resolvable set is unchanged (the `files` array is a fresh reference every
  // render). Sorted so ordering churn does not force a refetch.
  const signature = useMemo(
    () => requests.map((r) => `${r.fileId}:${r.variant ?? ''}`).sort().join('|'),
    [requests],
  );

  const query = useQuery({
    queryKey: [ASSET_DOWNLOAD_URLS_QUERY_KEY, viewerKey, signature],
    enabled: requests.length > 0 && viewerKey.length > 0,
    staleTime: ASSET_URL_STALE_MS,
    gcTime: ASSET_URL_GC_MS,
    // Keep previously-resolved URLs on screen while the SAME viewer's file set
    // grows (pagination), but never carry another account's scoped media tokens
    // across a switch — `keepPreviousData` alone would do that.
    placeholderData: (previousData, previousQuery) => {
      if (!previousData || !previousQuery) return undefined;
      const prevViewer = previousQuery.queryKey[1];
      if (prevViewer !== viewerKey) return undefined;
      return previousData;
    },
    queryFn: async (): Promise<Record<string, string>> => {
      const merged: Record<string, string> = {};
      for (let i = 0; i < requests.length; i += BATCH_CAP) {
        const chunk = requests.slice(i, i + BATCH_CAP);
        const urls = await oxyServices.getFileDownloadUrls(chunk, {
          expiresIn: ASSET_URL_TTL_SECONDS,
        });
        Object.assign(merged, urls);
      }
      return merged;
    },
  });

  return useMemo(() => {
    const map = new Map<string, string>();
    const data = query.data;
    if (data) {
      for (const [id, url] of Object.entries(data)) {
        if (typeof url === 'string' && url.length > 0) map.set(id, url);
      }
    }
    return map;
  }, [query.data]);
}
