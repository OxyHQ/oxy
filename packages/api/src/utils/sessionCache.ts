import { getRedisClient } from '../config/redis';
import type { sessions } from '../db/schema/sessions';

/**
 * A cached session — one `sessions` row.
 *
 * Inferred from the schema rather than re-declared, and taken from the SCHEMA
 * rather than from `session.service` (which imports this module — naming the
 * table directly is what keeps that from becoming an import cycle).
 */
export type CachedSession = typeof sessions.$inferSelect;

/**
 * Date-valued columns of a `sessions` row.
 *
 * The Redis tier stores JSON, and `JSON.parse` hands every `Date` back as a
 * STRING. Without reviving them a Redis hit and a local hit would disagree on
 * the type of `expiresAt` — and `expiresAt.toISOString()` on the sign-in
 * response would throw for whichever tier answered second. Mongo had the same
 * latent split; typing the cache off the schema is what made it visible.
 */
const DATE_COLUMNS = [
  'lastActiveAt',
  'tokenRotatedAt',
  'expiresAt',
  'lastRefresh',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof CachedSession)[];

/** Re-hydrate the `Date` columns of a session parsed back out of Redis JSON. */
function reviveSession(raw: unknown): CachedSession | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  for (const column of DATE_COLUMNS) {
    const value = record[column];
    if (typeof value === 'string') {
      record[column] = new Date(value);
    }
  }
  return record as unknown as CachedSession;
}

const DEFAULT_TTL = 5 * 60; // 5 minutes in seconds
const LAST_ACTIVE_THRESHOLD = 60 * 1000; // 1 minute in ms
const MAX_LOCAL_SIZE = 5000;

class SessionCache {
  private local: Map<string, { session: CachedSession; userId?: string; timestamp: number; ttl: number }> = new Map();
  private pendingLastActiveUpdates: Map<string, Date> = new Map();
  private cleanupTimer: NodeJS.Timeout;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanupLocal(), 60_000);
    this.cleanupTimer.unref?.();
  }

  async getAsync(sessionId: string): Promise<CachedSession | null> {
    const redis = getRedisClient();
    if (redis && redis.status === 'ready') {
      try {
        const data = await redis.get(`session:${sessionId}`);
        if (data) return reviveSession(JSON.parse(data));
        return null;
      } catch { /* fall through to local */ }
    }
    return this.getLocal(sessionId);
  }

  get(sessionId: string): CachedSession | null {
    const local = this.getLocal(sessionId);
    if (local) return local;

    const redis = getRedisClient();
    if (redis && redis.status === 'ready') {
      redis.get(`session:${sessionId}`).then(data => {
        if (data) {
          const session = reviveSession(JSON.parse(data));
          if (session) this.setLocal(sessionId, session);
        }
      }).catch(() => {});
    }
    return null;
  }

  set(sessionId: string, session: CachedSession, ttl?: number): void {
    const ttlSec = ttl ? Math.ceil(ttl / 1000) : DEFAULT_TTL;
    this.setLocal(sessionId, session, ttl);

    const redis = getRedisClient();
    if (redis && redis.status === 'ready') {
      redis.setex(`session:${sessionId}`, ttlSec, JSON.stringify(session)).catch(() => {});
    }
  }

  invalidate(sessionId: string): void {
    this.local.delete(sessionId);
    this.pendingLastActiveUpdates.delete(sessionId);

    const redis = getRedisClient();
    if (redis && redis.status === 'ready') {
      redis.del(`session:${sessionId}`).catch(() => {});
    }
  }

  invalidateUserSessions(userId: string): void {
    for (const [key, cached] of this.local.entries()) {
      if (cached.userId === userId) {
        this.local.delete(key);
        this.pendingLastActiveUpdates.delete(cached.session.sessionId);
      }
    }

    // Redis: scan and delete (best-effort)
    const redis = getRedisClient();
    if (redis && redis.status === 'ready') {
      const stream = redis.scanStream({ match: 'session:*', count: 100 });
      stream.on('data', async (keys: string[]) => {
        for (const key of keys) {
          try {
            const data = await redis.get(key);
            if (data) {
              const session = reviveSession(JSON.parse(data));
              // `user_id` is a plain text column now, so this is a string
              // compare rather than the ObjectId `.toString()` Mongo needed.
              if (session?.userId === userId) {
                await redis.del(key);
              }
            }
          } catch { /* ignore */ }
        }
      });
    }
  }

  shouldUpdateLastActive(sessionId: string): boolean {
    const redis = getRedisClient();
    if (redis && redis.status === 'ready') {
      // Use Redis SETNX for distributed throttling
      const key = `session_la:${sessionId}`;
      const ttlSec = Math.ceil(LAST_ACTIVE_THRESHOLD / 1000);
      redis.set(key, '1', 'EX', ttlSec, 'NX').then(result => {
        if (!result) {
          // Key already exists — throttled
        }
      }).catch(() => {});
      // Fall through to local check for synchronous response
    }

    const lastUpdate = this.pendingLastActiveUpdates.get(sessionId);
    if (!lastUpdate) {
      this.pendingLastActiveUpdates.set(sessionId, new Date());
      return true;
    }
    if (Date.now() - lastUpdate.getTime() >= LAST_ACTIVE_THRESHOLD) {
      this.pendingLastActiveUpdates.set(sessionId, new Date());
      return true;
    }
    return false;
  }

  clearPendingLastActive(sessionId: string): void {
    this.pendingLastActiveUpdates.delete(sessionId);
  }

  // --- Local cache helpers ---

  private getLocal(sessionId: string): CachedSession | null {
    const cached = this.local.get(sessionId);
    if (!cached) return null;
    if (Date.now() - cached.timestamp > cached.ttl) {
      this.local.delete(sessionId);
      return null;
    }
    return cached.session;
  }

  private setLocal(sessionId: string, session: CachedSession, ttl?: number): void {
    if (this.local.size >= MAX_LOCAL_SIZE) {
      // Evict oldest 10%
      const entries = Array.from(this.local.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const count = Math.floor(MAX_LOCAL_SIZE * 0.1);
      for (let i = 0; i < count; i++) {
        this.local.delete(entries[i][0]);
      }
    }
    this.local.set(sessionId, {
      session,
      userId: session.userId,
      timestamp: Date.now(),
      ttl: ttl || DEFAULT_TTL * 1000,
    });
  }

  private cleanupLocal(): void {
    const now = Date.now();
    for (const [key, cached] of this.local.entries()) {
      if (now - cached.timestamp > cached.ttl) {
        this.local.delete(key);
        this.pendingLastActiveUpdates.delete(cached.session.sessionId);
      }
    }
  }

  clear(): void {
    this.local.clear();
    this.pendingLastActiveUpdates.clear();
  }

  getStats(): { size: number; maxSize: number; pendingUpdates: number } {
    return {
      size: this.local.size,
      maxSize: MAX_LOCAL_SIZE,
      pendingUpdates: this.pendingLastActiveUpdates.size,
    };
  }

  stop(): void {
    clearInterval(this.cleanupTimer);
  }
}

const sessionCache = new SessionCache();
export default sessionCache;
