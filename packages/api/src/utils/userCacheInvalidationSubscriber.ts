import { OXY_USER_INVALIDATION_CHANNEL, oxyUserInvalidationEventSchema } from '@oxyhq/contracts';
import type Redis from 'ioredis';

import { logger } from './logger';
import userCache from './userCache';

const LOG_COMPONENT = 'UserCacheInvalidationSubscriber';

/**
 * Subscribe to cross-instance identity invalidation events so every ECS task
 * drops its in-memory user row when a peer writes, without re-publishing.
 *
 * Uses a dedicated `duplicate()` — the main client must stay publish-capable.
 */
export function startUserCacheInvalidationSubscriber(
  redis: Redis,
): { stop: () => Promise<void> } {
  const subscriber = redis.duplicate();

  subscriber.on('message', (channel, raw) => {
    if (channel !== OXY_USER_INVALIDATION_CHANNEL) return;

    try {
      const parsed = oxyUserInvalidationEventSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        logger.warn('userCache: dropped invalid invalidation message', {
          component: LOG_COMPONENT,
          err: parsed.error.message,
        });
        return;
      }
      userCache.invalidateLocal(parsed.data.userId);
    } catch (error) {
      logger.warn('userCache: failed to handle invalidation message', {
        component: LOG_COMPONENT,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  });

  subscriber.subscribe(OXY_USER_INVALIDATION_CHANNEL).catch((error) => {
    logger.error('userCache: failed to subscribe to invalidation channel', {
      component: LOG_COMPONENT,
      channel: OXY_USER_INVALIDATION_CHANNEL,
      err: error instanceof Error ? error.message : String(error),
    });
  });

  logger.info('User cache invalidation subscriber enabled', {
    component: LOG_COMPONENT,
    channel: OXY_USER_INVALIDATION_CHANNEL,
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
