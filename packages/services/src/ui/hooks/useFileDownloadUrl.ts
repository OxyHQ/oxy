import { useEffect, useState } from 'react';
import type { OxyServices } from '@oxy.so/core';
import { useOptionalOxy } from '../context/oxyRuntimeContext';

export interface UseFileDownloadUrlOptions {
  variant?: string;
  expiresIn?: number;
}

export interface UseFileDownloadUrlResult {
  url: string | null;
  loading: boolean;
  error: Error | null;
}

interface Settled {
  request: string;
  url: string | null;
  error: Error | null;
}

function isAbsoluteUrl(ref: string): boolean {
  return ref.startsWith('http://') || ref.startsWith('https://');
}

/**
 * Resolve a file's download URL for the current caller.
 *
 * A URL `assets.url` already resolved is answered in the FIRST render from
 * core's identity-scoped cache (`assets.cachedUrl`): no request, no loading
 * frame. Only a miss resolves asynchronously, through `assets.url`, which
 * returns a scoped media-token stream URL for a private asset. There is no
 * public-CDN fallback: `assets.publicUrl` 404s for private uploads. A
 * reference that is already an absolute `http(s)` URL is returned unchanged.
 *
 * For a synchronous, render-only answer (an image resolver, a list row) use
 * `oxyServices.assets.renderUrl`, which reads the same cache.
 */
export const useFileDownloadUrl = (
  oxyServices: OxyServices | null | undefined,
  fileId: string | null | undefined,
  options?: UseFileDownloadUrlOptions,
): UseFileDownloadUrlResult => {
  const variant = options?.variant;
  const expiresIn = options?.expiresIn;
  // A resolved URL can carry the viewer's scoped media token, so the viewer is
  // part of what was asked: an account switch never shows the previous one's.
  const viewerId = useOptionalOxy()?.user?.id ?? '';
  const request = fileId ? `${viewerId}|${fileId}|${variant ?? ''}|${expiresIn ?? ''}` : null;
  const immediate = !fileId
    ? null
    : isAbsoluteUrl(fileId)
      ? fileId
      : (oxyServices?.assets.cachedUrl(fileId, variant, expiresIn) ?? null);
  const needsResolve = !!fileId && !!oxyServices && immediate === null;

  const [settled, setSettled] = useState<Settled | null>(null);

  useEffect(() => {
    if (!needsResolve || !fileId || !oxyServices || !request) return;
    let cancelled = false;
    oxyServices.assets.url(fileId, variant, expiresIn).then(
      (url) => {
        if (!cancelled) setSettled({ request, url: url || null, error: null });
      },
      (err: unknown) => {
        if (!cancelled) {
          setSettled({
            request,
            url: null,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [needsResolve, fileId, oxyServices, variant, expiresIn, request]);

  if (!fileId) return { url: null, loading: false, error: null };
  if (immediate !== null) return { url: immediate, loading: false, error: null };
  if (!oxyServices) {
    return {
      url: null,
      loading: false,
      error: new Error('OxyServices instance not configured for useFileDownloadUrl'),
    };
  }
  // A result settled for another file, variant or expiry is never shown.
  if (settled?.request !== request) return { url: null, loading: true, error: null };
  return { url: settled.url, loading: false, error: settled.error };
};
