/**
 * BullMQ connection OPTIONS for queues and workers.
 *
 * BullMQ has hard requirements that the shared cache client in
 * `src/config/redis.ts` does NOT satisfy:
 *   - `maxRetriesPerRequest` MUST be `null` (BullMQ manages its own retries and
 *     uses long-running blocking commands like BRPOPLPUSH).
 *   - A `Worker` needs its OWN blocking connection, separate from the `Queue`'s
 *     connection, because the worker blocks on the connection while waiting for
 *     jobs and would otherwise starve the queue's regular commands.
 *
 * We therefore hand BullMQ a plain connection-OPTIONS object (NOT a shared
 * ioredis instance) and let BullMQ build the underlying connections itself: the
 * `Queue` gets one command connection and each `Worker` gets its own dedicated
 * blocking connection. Closing the Queue/Worker closes the connection it owns,
 * so there is nothing to track or tear down here.
 *
 * The options are typed against BullMQ's OWN `ConnectionOptions`/`RedisOptions`
 * (imported from `'bullmq'`, NOT from `'ioredis'`): that is the shape BullMQ
 * accepts, whichever ioredis it is handed (BullMQ 6 takes ioredis as a peer,
 * so it is the app's own copy).
 *
 * The `rediss://` TLS handling mirrors the cache client, and the reconnect
 * backoff IS the cache client's (`redisRetryStrategy`), so operational
 * behaviour stays consistent.
 */

import type { ConnectionOptions, RedisOptions } from 'bullmq';
import { redisRetryStrategy } from '../config/redis';

const KEEP_ALIVE_MS = 10_000;

/** Default Redis port when the URL omits one. */
const DEFAULT_REDIS_PORT = 6379;
/** Default Redis logical database when the URL omits one. */
const DEFAULT_REDIS_DB = 0;

/**
 * Parse the logical database index from a Redis URL path (e.g. `/2` → `2`).
 * Returns the default when the path is empty/`/` or not a valid number.
 */
function parseRedisDb(pathname: string): number {
  const raw = pathname.replace(/^\//, '');
  if (raw === '') return DEFAULT_REDIS_DB;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? DEFAULT_REDIS_DB : parsed;
}

/**
 * Build BullMQ connection options from one explicit Redis URL.
 */
function parseQueueConnectionOptions(url: string): ConnectionOptions {
  const parsed = new URL(url);
  const isTls = parsed.protocol === 'rediss:';

  const options: RedisOptions = {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : DEFAULT_REDIS_PORT,
    db: parseRedisDb(parsed.pathname),
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    tls: isTls ? {} : undefined,
    maxRetriesPerRequest: null,
    lazyConnect: true,
    enableReadyCheck: true,
    keepAlive: KEEP_ALIVE_MS,
    // Never gives up: a worker whose connection ended would stop taking jobs
    // until the next deploy (see `redisRetryStrategy`).
    retryStrategy: redisRetryStrategy,
    reconnectOnError(err: Error) {
      return err.message.includes('READONLY');
    },
  };

  return options;
}

/**
 * Build the shared BullMQ connection OPTIONS from `REDIS_URL`.
 *
 * Parses the URL into an explicit host/port/username/password/db target
 * rather than passing the raw URL string, so TLS and DB selection are applied
 * deterministically. `tls: {}` is set for `rediss://`, otherwise omitted.
 *
 * The critical BullMQ difference from the cache client is
 * `maxRetriesPerRequest: null`.
 *
 * @throws Error if `REDIS_URL` is not set — callers must gate on
 *   `isQueueEnabled()` before requesting connection options.
 */
export function getQueueConnectionOptions(): ConnectionOptions {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error('getQueueConnectionOptions called without REDIS_URL set');
  }
  return parseQueueConnectionOptions(url);
}

/** Production asset variants use the isolated noeviction Valkey instance. */
export function getAssetVariantQueueUrl(): string | undefined {
  return (
    process.env.QUEUE_REDIS_URL ??
    (process.env.NODE_ENV !== 'production' ? process.env.REDIS_URL : undefined)
  );
}

/** Production asset variants use the isolated noeviction Valkey instance. */
export function getAssetVariantQueueConnectionOptions(): ConnectionOptions {
  const url = getAssetVariantQueueUrl();
  if (!url) {
    throw new Error('getAssetVariantQueueConnectionOptions called without QUEUE_REDIS_URL set');
  }
  return parseQueueConnectionOptions(url);
}
