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
 * How long ioredis waits before its next reconnect attempt: a backoff that
 * grows 200 ms per attempt and stays at 5 s, FOREVER.
 *
 * It used to answer `null` after 20 attempts (about 42 s), which tells ioredis
 * to stop reconnecting for good: the client ends, every later command fails
 * with "Connection is closed", and nothing but a new task brings it back. So a
 * Valkey outage a little longer than that outlived itself on every task, until
 * a deploy, while `/health` kept answering 200. A down Valkey costs one
 * connection attempt per task every 5 s; giving up costs the cache, the
 * subscribers and the queues until someone notices.
 *
 * Shared by every ioredis client the API builds: this one, its `duplicate()`
 * subscribers (which inherit it), and the BullMQ connections
 * (`queue/connection.ts`).
 */
export function redisRetryStrategy(times: number): number {
  return Math.min(times * 200, 5000);
}

/**
 * How long one command on the shared client may take, from the moment it is
 * sent: queued while the client connects or reconnects, then waiting for its
 * reply. Past it the command is rejected ("Command timed out") and the caller
 * falls back (every caller does: a cache reads the database, a limiter admits
 * uncounted, the lockout counts in memory).
 *
 * Without it, a command sent while Valkey is down waits in ioredis's offline
 * queue until `maxRetriesPerRequest` reconnect attempts have failed: 4 cycles
 * of up to 5 s backoff plus a connect attempt (10 s against a host that does not
 * answer), so up to a minute per command. Now that the client never gives up
 * (`redisRetryStrategy`), that would be every command for the whole outage,
 * where before it gave up after about 42 s and failed every command at once.
 * It also bounds a connection that is up but not answering, which nothing
 * else does.
 *
 * Why a timeout and not `enableOfflineQueue: false`: ioredis reads that option
 * on every command, so it would also reject what is sent before the FIRST
 * connect completes, and the server sends plenty then (every limiter's script
 * load, the subscriptions). The offline queue still buffers that, for at most
 * this long. A healthy in-VPC Valkey answers in well under a millisecond, so a
 * second is headroom for a starved event loop, not for Valkey.
 */
export const REDIS_COMMAND_TIMEOUT_MS = 1_000;

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
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      enableReadyCheck: true,
      keepAlive: 10000,
      tls: url.startsWith('rediss://') ? {} : undefined,

      retryStrategy: redisRetryStrategy,

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
    redis.on('reconnecting', (ms: number) => logger.info('Redis reconnecting', { retryIn: ms }));

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
 * A dedicated pub/sub connection on the shared client's settings, for a
 * subscriber (the shared client must stay publish-capable).
 *
 * It keeps the offline queue and drops the command timeout: its only commands
 * are its own SUBSCRIBEs, sent once at start, and a timeout would report a
 * subscription as failed that ioredis completes as soon as it connects. After
 * a reconnect, ioredis subscribes it again to every channel it held
 * (`autoResubscribe`, stated here so nobody turns it off by accident).
 */
export function duplicateRedisSubscriber(redis: Redis): Redis {
  return redis.duplicate({ commandTimeout: undefined, autoResubscribe: true });
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
