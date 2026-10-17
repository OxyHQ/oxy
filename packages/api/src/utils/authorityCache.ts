/**
 * Short-lived, per-task caches for the authority reads oxy-api makes on (nearly)
 * every request: is this application still trusted, is this account supervised,
 * does this organization still hold operating authority.
 *
 * WHY. On 2026-10-16 a migration held an ACCESS EXCLUSIVE lock on `applications`
 * for 93 s. Every /internal request ran `select … from applications where id=$1`
 * for the same handful of application ids, each one took a pool connection and
 * queued behind the lock: 12.5 AAS on that one statement, 16 AAS for oxy-api,
 * and every product calling Oxy fail-closed returned 503. The answers were the
 * same few rows over and over. Here each task asks Postgres at most once per key
 * per {@link authorityCacheTtlMs}, and concurrent misses for one key share ONE
 * query (single flight), so a stalled read holds one connection, not forty.
 *
 * MAX STALENESS — the security contract:
 *
 *   * Where a write path calls `invalidate` (supervision start/end, application
 *     status/trust/scope edits, application deletion): immediately on the task
 *     that wrote, and on every other task as soon as the Redis broadcast
 *     (`AUTHORITY_INVALIDATION_CHANNEL`) arrives — milliseconds. A load that
 *     started BEFORE an invalidation never populates the cache (generation
 *     check), so it cannot re-cache the old answer.
 *   * Otherwise — a write path that does not invalidate (organization claim
 *     changes), or a lost broadcast — within the TTL,
 *     {@link DEFAULT_AUTHORITY_CACHE_TTL_MS} = 5 s. That is the hard bound: a
 *     demoted or suspended application, a newly supervised account or an
 *     organization that lost its claim keeps its previous answer for at most
 *     5 s on any task. Service tokens live an hour; 5 s is the bound that matters.
 *   * Errors are never cached: a failed load rejects every waiter and the next
 *     request asks again, so callers keep failing closed exactly as before.
 *
 * `OXY_AUTHORITY_CACHE_TTL_MS` overrides the TTL (0 disables caching); the jest
 * suite sets 0 so tests that write authority rows read them back live.
 */

import type Redis from 'ioredis';
import { getRedisClient } from '../config/redis';
import { logger } from './logger';

export const DEFAULT_AUTHORITY_CACHE_TTL_MS = 5_000;
/** Cross-task invalidations: `{ "cache": <name>, "key": <key> }`. */
export const AUTHORITY_INVALIDATION_CHANNEL = 'oxy-api:authority-cache:invalidate';
const DEFAULT_MAX_ENTRIES = 10_000;

export function authorityCacheTtlMs(): number {
  const raw = process.env.OXY_AUTHORITY_CACHE_TTL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_AUTHORITY_CACHE_TTL_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? Math.min(value, 60_000)
    : DEFAULT_AUTHORITY_CACHE_TTL_MS;
}

export interface AuthorityCache<V> {
  /** The cached value for `key`, or `load()`'s, shared by concurrent callers. */
  get(key: string, load: () => Promise<V>): Promise<V>;
  /** Forget `key` here now and on every other task via Redis; in-flight loads will not re-cache it. */
  invalidate(key: string): void;
  /** Forget `key` on this task only (the broadcast receiver). */
  invalidateLocal(key: string): void;
  /** Forget everything on this task. */
  clear(): void;
}

const registry = new Map<string, AuthorityCache<unknown>>();

export function createAuthorityCache<V>(
  name: string,
  options: { ttlMs?: () => number; maxEntries?: number; now?: () => number } = {},
): AuthorityCache<V> {
  const ttlMs = options.ttlMs ?? authorityCacheTtlMs;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const entries = new Map<string, { value: V; expiresAt: number }>();
  const inflight = new Map<string, { generation: number; promise: Promise<V> }>();
  // One monotonic counter: an invalidation stamps its key, a clear stamps the
  // epoch, and a load may populate only if nothing was stamped since it began.
  const generations = new Map<string, number>();
  let counter = 0;
  let epoch = 0;
  const generationOf = (key: string) => Math.max(epoch, generations.get(key) ?? 0);

  const cache: AuthorityCache<V> = {
    get(key, load) {
      const ttl = ttlMs();
      if (ttl <= 0) return load();
      const cached = entries.get(key);
      if (cached && cached.expiresAt > now()) return Promise.resolve(cached.value);
      if (cached) entries.delete(key);

      const generation = generationOf(key);
      const running = inflight.get(key);
      if (running && running.generation === generation) return running.promise;

      const promise = load().then(
        (value) => {
          if (inflight.get(key)?.promise === promise) inflight.delete(key);
          if (generationOf(key) === generation) {
            entries.delete(key);
            entries.set(key, { value, expiresAt: now() + ttl });
            if (entries.size > maxEntries) {
              const oldest = entries.keys().next().value;
              if (oldest !== undefined) entries.delete(oldest);
            }
          }
          return value;
        },
        (error: unknown) => {
          if (inflight.get(key)?.promise === promise) inflight.delete(key);
          throw error;
        },
      );
      inflight.set(key, { generation, promise });
      return promise;
    },
    invalidate(key) {
      cache.invalidateLocal(key);
      const redis = getRedisClient();
      if (redis && redis.status === 'ready') {
        // Fire-and-forget after a committed write; a lost message costs the TTL.
        redis
          .publish(AUTHORITY_INVALIDATION_CHANNEL, JSON.stringify({ cache: name, key }))
          .catch((error: unknown) =>
            logger.warn('authorityCache: invalidation publish failed', {
              cache: name,
              err: error instanceof Error ? error.message : String(error),
            }),
          );
      }
    },
    invalidateLocal(key) {
      entries.delete(key);
      inflight.delete(key);
      counter += 1;
      generations.set(key, counter);
      if (generations.size > maxEntries) {
        generations.clear();
        epoch = counter;
      }
    },
    clear() {
      entries.clear();
      inflight.clear();
      generations.clear();
      counter += 1;
      epoch = counter;
    },
  };
  registry.set(name, cache as AuthorityCache<unknown>);
  return cache;
}

/** Drop the keys other tasks invalidate. Uses its own `duplicate()` connection. */
export function startAuthorityCacheInvalidationSubscriber(redis: Redis): {
  stop: () => Promise<void>;
} {
  const subscriber = redis.duplicate();
  subscriber.on('message', (channel, raw) => {
    if (channel !== AUTHORITY_INVALIDATION_CHANNEL) return;
    try {
      const message = JSON.parse(raw) as { cache?: unknown; key?: unknown };
      if (typeof message.cache !== 'string' || typeof message.key !== 'string') return;
      registry.get(message.cache)?.invalidateLocal(message.key);
    } catch {
      // A malformed message cannot name a key; the TTL still bounds staleness.
    }
  });
  subscriber.subscribe(AUTHORITY_INVALIDATION_CHANNEL).catch((error: unknown) => {
    logger.error('authorityCache: failed to subscribe to invalidation channel', {
      err: error instanceof Error ? error.message : String(error),
    });
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
