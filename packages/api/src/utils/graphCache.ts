/**
 * Viewer-Graph Cache
 *
 * Short-TTL, Redis-backed cache for the consolidated per-viewer social graph
 * (`GET /users/me/graph` → `{ followingIds, mutualIds, blockedIds, restrictedIds }`). The graph
 * is read on nearly every feed/timeline request by consuming apps (Mention,
 * Allo, Homiio), so caching the ids-only payload for a short window removes the
 * three Postgres round trips it otherwise costs on each request.
 *
 * MUST be Redis-backed (not in-memory) because the API runs multiple instances
 * behind a load balancer (the Socket.IO Redis adapter in `server.ts` confirms
 * this): a follow/unfollow/block write served by instance A has to invalidate a
 * graph a read served by instance B may have cached. An in-memory cache would
 * strand stale graphs on the instances that did not process the write.
 *
 * Degrades to a no-op (never a cache, never a throw) when `getRedisClient()`
 * returns null (Redis not configured) — exactly like `userCache`/`blockCache`
 * fall back gracefully. Every operation also swallows-and-logs Redis errors so
 * a Redis blip degrades to "recompute from Postgres", never a failed request.
 */

import { getRedisClient } from '../config/redis';
import { logger } from './logger';
import type { ViewerGraph } from '../types/user.types';

/** Namespaced key prefix; `v1` allows the cached shape to be versioned later. */
const REDIS_KEY_PREFIX = 'viewergraph:v1:';

/**
 * TTL for a cached viewer graph, in seconds. Deliberately short: writes
 * (follow/unfollow/block) invalidate proactively, so this TTL is only the
 * backstop that bounds staleness from writes this instance never observed
 * (e.g. a graph edge changed directly in the DB). Matches the recommendation
 * cache's staleness posture (`REC_CACHE_TTL_SECONDS`).
 */
export const GRAPH_CACHE_TTL_SECONDS = 90;

function buildKey(viewerId: string): string {
  return `${REDIS_KEY_PREFIX}${viewerId}`;
}

/** True only when the parsed value is a well-formed {@link ViewerGraph}. */
function isViewerGraph(value: unknown): value is ViewerGraph {
  if (!value || typeof value !== 'object') return false;
  const graph = value as Partial<ViewerGraph>;
  return (
    Array.isArray(graph.followingIds) &&
    Array.isArray(graph.mutualIds) &&
    Array.isArray(graph.blockedIds) &&
    Array.isArray(graph.restrictedIds)
  );
}

/**
 * Read a cached viewer graph. Returns null on a miss, on a malformed/legacy
 * cached value, when Redis is not configured, or on any Redis error — every
 * null path makes the caller recompute from Mongo, which is always correct.
 */
async function get(viewerId: string): Promise<ViewerGraph | null> {
  if (!viewerId) return null;

  const redis = getRedisClient();
  if (!redis) return null;

  try {
    const raw = await redis.get(buildKey(viewerId));
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    return isViewerGraph(parsed) ? parsed : null;
  } catch (error) {
    logger.warn('[graphCache] Redis read failed, recomputing from source', {
      viewerId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Cache a viewer graph with the short TTL. A no-op when Redis is not configured;
 * Redis errors are swallowed-and-logged (a failed cache write must never fail
 * the request that produced the graph).
 */
async function set(
  viewerId: string,
  graph: ViewerGraph,
  ttlSeconds: number = GRAPH_CACHE_TTL_SECONDS
): Promise<void> {
  if (!viewerId) return;

  const redis = getRedisClient();
  if (!redis) return;

  try {
    await redis.set(buildKey(viewerId), JSON.stringify(graph), 'EX', ttlSeconds);
  } catch (error) {
    logger.warn('[graphCache] Redis write failed', {
      viewerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Drop a viewer's cached graph. Called from the graph-mutating write paths
 * (follow/unfollow/block/unblock) so the next read recomputes fresh truth. A
 * no-op when Redis is not configured; Redis errors are swallowed-and-logged so
 * the write that triggered the invalidation still succeeds.
 */
async function invalidate(viewerId: string): Promise<void> {
  if (!viewerId) return;

  const redis = getRedisClient();
  if (!redis) return;

  try {
    await redis.del(buildKey(viewerId));
  } catch (error) {
    logger.warn('[graphCache] Redis invalidate failed', {
      viewerId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const graphCache = { get, set, invalidate, ttlSeconds: GRAPH_CACHE_TTL_SECONDS };
export default graphCache;
