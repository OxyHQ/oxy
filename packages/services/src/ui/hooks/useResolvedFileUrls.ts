import { useMemo } from 'react';
import { skip, useEntities, useList } from '@oxy.so/bloom-data';
import type { FileMetadata } from '@oxy.so/core';
import { type AssetUrlBatchResolver, FileUrl, fileUrlId, fileUrls } from '../data/files';

/**
 * Private-safe grid/thumbnail URL resolution.
 *
 * The synchronous `oxyServices.assets.publicUrl(id, variant)` always yields
 * the public CDN origin (`cloud.oxy.so/<id>`), which 404s for PRIVATE assets —
 * and uploads default to private. Thumbnails and previews therefore have to be
 * resolved through the authenticated batch endpoint, which returns a working
 * `/assets/:id/stream?…&mt=<scoped media token>` URL for private files.
 *
 * This hook resolves an ENTIRE page of files in ONE (chunked) batch request
 * rather than N per-tile calls (`fileUrls` in `data/files.ts`), held per
 * account in memory only, and read again before the server media token
 * expires so a tile never renders a URL whose token has already died. A URL
 * already resolved stays on screen while a grown set (the next page) resolves.
 *
 * Optimistic (`temp-…` / `uploading`) entries are NEVER resolved here — an
 * asset URL must never be built from an id the server does not yet know. Their
 * preview comes from the locally-picked uri (see {@link fileThumbSource}).
 */

/**
 * The React Query root the URLs were once cached under. Nothing is cached
 * there any more (each account's store holds its own URLs); the constant stays
 * only until the infra step of the bloom-data move removes the two
 * `removeQueries` calls that name it (`OxyContext`, `OxyHostedContext`).
 */
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
  /** Active viewer account id: nothing is resolved without one. */
  viewerId?: string | null,
): ReadonlyMap<string, string> {
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

  useList(
    fileUrls,
    ...(requests.length > 0 && viewerId ? ([oxyServices, requests] as const) : ([skip] as const)),
  );
  const ids = useMemo(
    () => requests.map((request) => fileUrlId(request.fileId, request.variant)),
    [requests],
  );
  const resolved = useEntities(FileUrl, ids);

  return useMemo(() => {
    const map = new Map<string, string>();
    requests.forEach((request, index) => {
      const url = resolved[index]?.url;
      if (url) map.set(request.fileId, url);
    });
    return map;
  }, [requests, resolved]);
}
