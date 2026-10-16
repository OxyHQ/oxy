import type Redis from 'ioredis';

import fileCache, {
  FILE_CACHE_INVALIDATION_CHANNEL,
  FILE_CACHE_ORIGIN,
  fileCacheInvalidationMessageSchema,
} from './fileCache';
import { logger } from './logger';

const LOG_COMPONENT = 'FileCacheInvalidationSubscriber';

/**
 * Handle one message from {@link FILE_CACHE_INVALIDATION_CHANNEL}: drop the
 * named files from this task's cache, locally only (re-publishing would loop).
 * A message this process published is skipped — it already dropped them. An
 * invalid message is logged and ignored. Exported for tests.
 */
export function handleFileCacheInvalidationMessage(channel: string, raw: string): void {
  if (channel !== FILE_CACHE_INVALIDATION_CHANNEL) return;
  try {
    const parsed = fileCacheInvalidationMessageSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      logger.warn('fileCache: dropped invalid invalidation message', {
        component: LOG_COMPONENT,
        err: parsed.error.message,
      });
      return;
    }
    if (parsed.data.origin === FILE_CACHE_ORIGIN) return;
    fileCache.invalidateLocal(parsed.data.fileIds);
  } catch (error) {
    logger.warn('fileCache: failed to handle invalidation message', {
      component: LOG_COMPONENT,
      err: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Subscribe to cross-task file-record invalidations (ADR 0042 stage 4b), so a
 * block, trash, deletion or visibility change made by ONE API task stops every
 * other task serving its cached record at once instead of after the cache's
 * five-minute TTL.
 *
 * Uses a dedicated `duplicate()` — the main client must stay publish-capable.
 */
export function startFileCacheInvalidationSubscriber(redis: Redis): { stop: () => Promise<void> } {
  const subscriber = redis.duplicate();

  subscriber.on('message', handleFileCacheInvalidationMessage);

  subscriber.subscribe(FILE_CACHE_INVALIDATION_CHANNEL).catch((error) => {
    logger.error('fileCache: failed to subscribe to invalidation channel', {
      component: LOG_COMPONENT,
      channel: FILE_CACHE_INVALIDATION_CHANNEL,
      err: error instanceof Error ? error.message : String(error),
    });
  });

  logger.info('File cache invalidation subscriber enabled', {
    component: LOG_COMPONENT,
    channel: FILE_CACHE_INVALIDATION_CHANNEL,
  });

  return {
    async stop() {
      try {
        await subscriber.quit();
      } catch {
        subscriber.disconnect();
      }
    },
  };
}
