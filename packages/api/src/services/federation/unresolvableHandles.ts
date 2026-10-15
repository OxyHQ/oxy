import { getRedisClient } from '../../config/redis';
import { logger } from '../../utils/logger';

/**
 * Fediverse handles whose discovery (WebFinger, actor fetch, registry) just
 * returned nothing.
 *
 * A profile lookup of a handle Oxy has never stored has to wait for discovery:
 * there is nothing else to serve. When discovery fails, the next lookup of the
 * same handle would repeat the same remote round trips and fail the same way —
 * production logged about thirty such `GET /profiles/username` 404s a day at a
 * median of 1.2 s each, and people search fires one per fediverse-shaped query.
 * Remembering the failure for {@link UNRESOLVABLE_HANDLE_TTL_SECONDS} bounds
 * that to one remote attempt per handle per window, fleet-wide through Redis
 * and per process without it (the `getRedisClient` contract).
 *
 * The window is the one {@link FederationService} already uses between
 * background refreshes of a known actor, so an unknown handle is retried no
 * more eagerly than a known one is refreshed. Only a lookup of an UNKNOWN
 * handle consults this: a handle that becomes known (an actor resolved by URI,
 * an inbound activity) is found in the registry before this is read.
 */
export const UNRESOLVABLE_HANDLE_TTL_SECONDS = 5 * 60;

const KEY_PREFIX = 'federation:unresolvable-handle:';
const MAX_LOCAL_ENTRIES = 10_000;

/** handle -> expiry (ms), in insertion order so the oldest is evicted first. */
const local = new Map<string, number>();

function localHas(handle: string): boolean {
  const expiresAt = local.get(handle);
  if (expiresAt === undefined) return false;
  if (expiresAt > Date.now()) return true;
  local.delete(handle);
  return false;
}

function localRemember(handle: string): void {
  local.delete(handle);
  if (local.size >= MAX_LOCAL_ENTRIES) {
    const oldest = local.keys().next().value;
    if (oldest !== undefined) local.delete(oldest);
  }
  local.set(handle, Date.now() + UNRESOLVABLE_HANDLE_TTL_SECONDS * 1000);
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const unresolvableHandles = {
  /** Whether discovery of this (normalized) handle failed within the window. */
  async has(handle: string): Promise<boolean> {
    const redis = getRedisClient();
    if (redis && redis.status === 'ready') {
      try {
        return (await redis.exists(KEY_PREFIX + handle)) === 1;
      } catch (error) {
        logger.warn('Unresolvable-handle cache read failed; using the process cache', {
          error: failureMessage(error),
        });
      }
    }
    return localHas(handle);
  },

  /** Record that discovery of this (normalized) handle just failed. */
  async remember(handle: string): Promise<void> {
    const redis = getRedisClient();
    if (redis && redis.status === 'ready') {
      try {
        await redis.set(KEY_PREFIX + handle, '1', 'EX', UNRESOLVABLE_HANDLE_TTL_SECONDS);
        return;
      } catch (error) {
        logger.warn('Unresolvable-handle cache write failed; using the process cache', {
          error: failureMessage(error),
        });
      }
    }
    localRemember(handle);
  },

  /** Test seam: forget every process-local entry. */
  clearLocal(): void {
    local.clear();
  },
};
