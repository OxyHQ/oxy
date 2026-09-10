import { useEffect, useState } from 'react';
import type { OxyServices } from '@oxy.so/core';

export interface UseFileDownloadUrlOptions {
  variant?: string;
  expiresIn?: number;
}

export interface UseFileDownloadUrlResult {
  url: string | null;
  loading: boolean;
  error: Error | null;
}

/**
 * Hook to resolve a file's download URL asynchronously.
 *
 * Uses `getFileDownloadUrlAsync`, which returns a scoped media-token stream URL
 * for private assets. There is no sync CDN fallback — the synchronous
 * `getFileDownloadUrl` is public-CDN-only and 404s for private uploads.
 */
export const useFileDownloadUrl = (
  oxyServices: OxyServices | null | undefined,
  fileId: string | null | undefined,
  options?: UseFileDownloadUrlOptions,
): UseFileDownloadUrlResult => {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const variant = options?.variant;
  const expiresIn = options?.expiresIn;

  useEffect(() => {
    if (!fileId) {
      setUrl(null);
      setLoading(false);
      setError(null);
      return;
    }

    if (!oxyServices) {
      setUrl(null);
      setLoading(false);
      setError(new Error('OxyServices instance not configured for useFileDownloadUrl'));
      return;
    }

    let cancelled = false;
    const instance = oxyServices;
    const targetFileId = fileId;

    const load = async () => {
      setLoading(true);
      setError(null);

      try {
        if (typeof instance.getFileDownloadUrlAsync !== 'function') {
          throw new Error('getFileDownloadUrlAsync is not available on this OxyServices instance');
        }

        const resolvedUrl = await instance.getFileDownloadUrlAsync(targetFileId, variant, expiresIn);

        if (!cancelled) {
          setUrl(resolvedUrl || null);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setUrl(null);
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [fileId, oxyServices, variant, expiresIn]);

  return { url, loading, error };
};
