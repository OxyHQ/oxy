/**
 * A short-lived value kept ONLY in Redis (or, without Redis, in this process's
 * memory) — never in the database. For facts that must expire with the thing
 * they describe and must never reach storage at rest, such as which hashed IP
 * started a sign-in request.
 */
import { getRedisClient } from '../config/redis';
import { logger } from './logger';

const PREFIX = 'ephemeral:';
const memory = new Map<string, { value: string; expiresAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memory) {
    if (entry.expiresAt <= now) memory.delete(key);
  }
}, 60_000).unref();

export async function setEphemeral(key: string, value: string, ttlSeconds: number): Promise<void> {
  const redis = getRedisClient();
  if (redis) {
    try {
      await redis.set(`${PREFIX}${key}`, value, 'EX', ttlSeconds);
      return;
    } catch (error) {
      logger.warn('[ephemeral] Redis write failed, falling back to memory', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export async function getEphemeral(key: string): Promise<string | null> {
  const redis = getRedisClient();
  if (redis) {
    try {
      return await redis.get(`${PREFIX}${key}`);
    } catch (error) {
      logger.warn('[ephemeral] Redis read failed, falling back to memory', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const entry = memory.get(key);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.value;
}
