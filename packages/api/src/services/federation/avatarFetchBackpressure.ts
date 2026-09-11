import crypto from 'crypto';
import { getRedisClient } from '../../config/redis';
import { logger } from '../../utils/logger';

const ORIGIN_REQUEST_LEASE_MS = 15_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 60 * 60 * 1_000;
const FAILURE_COUNTER_TTL_SECONDS = 60 * 60;

const localCooldowns = new Map<string, number>();
const localFailures = new Map<string, { count: number; expiresAt: number }>();

function originKey(rawUrl: string): string {
  return crypto.createHash('sha256').update(new URL(rawUrl).origin).digest('hex');
}

function cooldownKey(key: string): string {
  return `federation:avatar:origin:${key}:cooldown`;
}

function failuresKey(key: string): string {
  return `federation:avatar:origin:${key}:rate-limit-failures`;
}

function localRemainingMs(key: string, now: number): number {
  const expiresAt = localCooldowns.get(key);
  if (expiresAt === undefined) return 0;
  if (expiresAt <= now) {
    localCooldowns.delete(key);
    return 0;
  }
  return expiresAt - now;
}

/**
 * Acquire a short per-origin lease before fetching an avatar. Redis makes the
 * lease effective across API replicas; the local map preserves the same
 * behaviour when Redis is intentionally unavailable in development.
 */
export async function acquireAvatarOriginLease(rawUrl: string): Promise<number> {
  const key = originKey(rawUrl);
  const now = Date.now();
  const redis = getRedisClient();

  if (redis) {
    try {
      const acquired = await redis.set(
        cooldownKey(key),
        'request-gap',
        'PX',
        ORIGIN_REQUEST_LEASE_MS,
        'NX',
      );
      if (acquired === 'OK') return 0;
      const remaining = await redis.pttl(cooldownKey(key));
      return remaining > 0 ? remaining : ORIGIN_REQUEST_LEASE_MS;
    } catch (error) {
      logger.warn('Federated avatar origin lease fell back to process memory', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const remaining = localRemainingMs(key, now);
  if (remaining > 0) return remaining;
  localCooldowns.set(key, now + ORIGIN_REQUEST_LEASE_MS);
  return 0;
}

function retryAfterMs(value: string | undefined, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds * 1_000), MAX_RATE_LIMIT_BACKOFF_MS);
  }
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.min(Math.max(date - now, 0), MAX_RATE_LIMIT_BACKOFF_MS);
}

/** Persist a remote origin's 429 cooldown, honouring Retry-After when valid. */
export async function recordAvatarOriginRateLimit(
  rawUrl: string,
  retryAfter: string | undefined,
): Promise<number> {
  const key = originKey(rawUrl);
  const now = Date.now();
  const advertisedDelay = retryAfterMs(retryAfter, now);
  const redis = getRedisClient();

  if (redis) {
    try {
      const failures = await redis.incr(failuresKey(key));
      await redis.expire(failuresKey(key), FAILURE_COUNTER_TTL_SECONDS);
      const exponentialDelay = Math.min(
        DEFAULT_RATE_LIMIT_BACKOFF_MS * 2 ** Math.min(failures - 1, 7),
        MAX_RATE_LIMIT_BACKOFF_MS,
      );
      const delay = Math.max(advertisedDelay ?? 0, exponentialDelay);
      await redis.set(cooldownKey(key), 'rate-limited', 'PX', delay);
      return delay;
    } catch (error) {
      logger.warn('Federated avatar rate-limit state fell back to process memory', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const previous = localFailures.get(key);
  const count = previous && previous.expiresAt > now ? previous.count + 1 : 1;
  localFailures.set(key, { count, expiresAt: now + FAILURE_COUNTER_TTL_SECONDS * 1_000 });
  const exponentialDelay = Math.min(
    DEFAULT_RATE_LIMIT_BACKOFF_MS * 2 ** Math.min(count - 1, 7),
    MAX_RATE_LIMIT_BACKOFF_MS,
  );
  const delay = Math.max(advertisedDelay ?? 0, exponentialDelay);
  localCooldowns.set(key, now + delay);
  return delay;
}

/** A successful response resets backoff history without releasing its request lease. */
export async function clearAvatarOriginFailures(rawUrl: string): Promise<void> {
  const key = originKey(rawUrl);
  localFailures.delete(key);
  const redis = getRedisClient();
  if (!redis) return;
  try {
    await redis.del(failuresKey(key));
  } catch (error) {
    logger.warn('Could not clear federated avatar rate-limit history', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
