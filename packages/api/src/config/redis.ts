import Redis, { type RedisOptions } from 'ioredis';
import { logger } from '../utils/logger';

let redis: Redis | null = null;
let pingInterval: ReturnType<typeof setInterval> | null = null;
/**
 * Set while `closeRedis()` is tearing the client down. `lazyConnect` means the
 * initial `connect()` promise can still be in flight at that moment; quitting
 * rejects it with "Connection is closed.", which is expected teardown, not a
 * failure. Without this flag a clean shutdown logs a spurious ERROR — exactly
 * the kind of line that makes a healthy one-shot task look like a broken one.
 */
let closing = false;

/**
 * Get a shared Redis/Valkey client.
 * Returns null when REDIS_URL is not set — all consumers
 * should gracefully fall back to in-memory stores.
 */
export function getRedisClient(): Redis | null {
  if (!process.env.REDIS_URL) return null;

  if (!redis) {
    // A fresh client ends any previous teardown window (see `closing`).
    closing = false;
    const url = process.env.REDIS_URL;
    const opts: RedisOptions = {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      enableReadyCheck: true,
      keepAlive: 10000,
      tls: url.startsWith('rediss://') ? {} : undefined,

      retryStrategy(times: number) {
        if (times > 20) return null;
        return Math.min(times * 200, 5000);
      },

      reconnectOnError(err: Error) {
        return err.message.includes('READONLY');
      },
    };

    redis = new Redis(url, opts);

    redis.on('connect', () => logger.info('Redis connected'));
    redis.on('ready', () => {
      logger.info('Redis ready');
      startPingInterval();
    });
    // During an intentional teardown both of these fire as a matter of course;
    // reporting them at error/warn makes a clean shutdown read like a fault.
    redis.on('error', (err) => {
      if (closing) return;
      logger.error('Redis error:', err);
    });
    redis.on('close', () => {
      if (closing) return;
      logger.warn('Redis connection closed');
    });
    redis.on('reconnecting', (ms: number) =>
      logger.info('Redis reconnecting', { retryIn: ms })
    );

    redis.connect().catch((err) => {
      if (closing) {
        logger.info('Redis initial connect aborted by shutdown');
        return;
      }
      logger.error('Redis initial connect failed:', err);
    });
  }

  return redis;
}

/**
 * Send PING every 60s to prevent managed Valkey idle timeout (default 300s).
 * TCP keepalive alone doesn't count as application-level activity.
 */
function startPingInterval(): void {
  if (pingInterval) return;
  const timer = setInterval(async () => {
    if (redis && redis.status === 'ready') {
      try {
        await redis.ping();
      } catch {
        // Reconnection is handled by ioredis automatically
      }
    }
  }, 60_000);
  // Never let the keep-alive ping alone hold the event loop open: the long-lived
  // server is kept alive by its own HTTP listener (so the ping still fires every
  // 60s there), while a one-shot script must be free to exit once its work is
  // done. Required of every singleton timer — see `~/AGENTS.md`.
  timer.unref?.();
  pingInterval = timer;
}

/**
 * Gracefully close the Redis connection (for shutdown hooks, and for every
 * one-shot script — a live ioredis socket is a ref'd libuv handle, so a task
 * that ever touched the cache never exits on its own without this).
 *
 * Safe to call unconditionally: a no-op when REDIS_URL is unset or no client
 * was ever created. Never throws — teardown must not mask a script's real
 * result, so a failed `quit()` falls back to a forced `disconnect()`.
 */
export async function closeRedis(): Promise<void> {
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  if (!redis) return;

  const client = redis;
  closing = true;
  try {
    await client.quit();
  } catch {
    // `quit()` rejects if the socket never finished connecting. Drop it.
    client.disconnect();
  } finally {
    redis = null;
    // `closing` deliberately stays set: ioredis rejects the in-flight connect
    // asynchronously, AFTER this returns, so clearing it here would let that
    // deferred rejection log a spurious error. `getRedisClient()` clears it
    // when it constructs the next client.
  }
}
