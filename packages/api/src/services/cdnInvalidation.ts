/**
 * What a delete tells cloud.oxy.so (ADR 0047).
 *
 * Public media is served by the cloud.oxy.so Worker with the Cache-Control it
 * was stored with — for content-addressed media, a year. Deleting the object
 * from R2 removes nothing a viewer sees until the edge forgets it, so every
 * delete of a public object purges its URL, and a file that stops being served
 * purges its by-id answers (`cdnPurge.ts`). Every delete path in the API ends in
 * `S3Service.deleteFile`, so the purge hangs off that one call; the routes that
 * retire a file's `/<id>` redirect call `enqueuePath`.
 *
 * The CloudFront distribution this used to invalidate no longer serves
 * cloud.oxy.so.
 */

import { CloudflarePurgeQueue } from './cdnPurge';
import { logger } from '../utils/logger';

/** How long graceful shutdown waits for the final flush. */
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;

/** What a delete path tells the CDN, and what shutdown flushes. */
export interface CdnEdgeQueue {
  enqueueDeletedKey(key: string): void;
  enqueuePath(path: string): void;
  flush(): Promise<void>;
  pendingPaths(): string[];
}

let singleton: CloudflarePurgeQueue | null = null;

/** The process-wide purge queue, from `CLOUDFLARE_ZONE_ID` + `CLOUDFLARE_CACHE_PURGE_TOKEN`. */
export function getCdnInvalidationQueue(): CloudflarePurgeQueue {
  if (!singleton) {
    singleton = new CloudflarePurgeQueue({
      zoneId: process.env.CLOUDFLARE_ZONE_ID,
      token: process.env.CLOUDFLARE_CACHE_PURGE_TOKEN,
    });
  }
  return singleton;
}

/** Graceful-shutdown hook: send whatever is pending, for at most `timeoutMs`. Never throws. */
export async function flushCdnInvalidations(
  queue: CdnEdgeQueue | null = singleton,
  timeoutMs = SHUTDOWN_FLUSH_TIMEOUT_MS,
): Promise<void> {
  if (!queue) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([queue.flush().then(() => 'done' as const), timedOut]);
    if (result === 'timeout') {
      logger.error(
        'CDN purge flush on shutdown timed out; these deleted objects remain cached at the cloud.oxy.so edge',
        { timeoutMs, paths: queue.pendingPaths() },
      );
    }
  } catch (error) {
    logger.error('CDN purge flush on shutdown failed', {
      error: error instanceof Error ? error.message : String(error),
      paths: queue.pendingPaths(),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
