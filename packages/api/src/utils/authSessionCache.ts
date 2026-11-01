import { OXY_SERVICE_EVENTS_HEARTBEAT_MS } from '@oxy.so/contracts';
import type { CachedSession } from './sessionCache';

export const AUTH_CACHE_PROBE_FRESH_MS = 2 * OXY_SERVICE_EVENTS_HEARTBEAT_MS + 1_000;

/** A request's view of subscriber health and invalidations before its database read. */
export interface AuthCacheSnapshot {
  readonly connection: number;
  readonly sequence: number;
  readonly sessionId: string;
}

/**
 * Auth-only session cache. It never reads the shared Redis session cache: a
 * subscriber that missed revocations cannot prove those rows are current.
 */
class AuthSessionCache {
  private readonly rows = new Map<string, { session: CachedSession; at: number }>();
  private readonly sessionsChanged = new Map<string, number>();
  private readonly usersChanged = new Map<string, number>();
  private connection = 0;
  private sequence = 0;
  private lastProbe: number | null = null;

  private reset(): void {
    this.connection += 1;
    this.rows.clear();
    this.sessionsChanged.clear();
    this.usersChanged.clear();
  }

  /** Never cache on startup, after a disconnect, or without a verified probe. */
  unavailable(): void {
    this.lastProbe = null;
    this.reset();
  }

  probe(at: number): void {
    if (this.lastProbe === null || at - this.lastProbe > AUTH_CACHE_PROBE_FRESH_MS) this.reset();
    this.lastProbe = at;
  }

  private healthy(now = Date.now()): boolean {
    if (this.lastProbe === null) return false;
    if (now - this.lastProbe > AUTH_CACHE_PROBE_FRESH_MS) {
      this.unavailable();
      return false;
    }
    return true;
  }

  snapshot(sessionId: string): AuthCacheSnapshot {
    this.healthy();
    return { connection: this.connection, sequence: this.sequence, sessionId };
  }

  current(snapshot: AuthCacheSnapshot, userId: string): boolean {
    this.healthy();
    return (
      snapshot.connection === this.connection &&
      (this.sessionsChanged.get(snapshot.sessionId) ?? 0) <= snapshot.sequence &&
      (this.usersChanged.get(userId) ?? 0) <= snapshot.sequence
    );
  }

  get(sessionId: string): CachedSession | null {
    if (!this.healthy()) return null;
    const entry = this.rows.get(sessionId);
    if (!entry) return null;
    if (Date.now() - entry.at > 5 * 60_000 || entry.session.expiresAt.getTime() <= Date.now()) {
      this.rows.delete(sessionId);
      return null;
    }
    return entry.session;
  }

  set(snapshot: AuthCacheSnapshot, session: CachedSession): void {
    if (!this.healthy() || !this.current(snapshot, session.userId)) return;
    if (this.rows.size >= 5_000) {
      const oldest = this.rows.keys().next().value;
      if (oldest !== undefined) this.rows.delete(oldest);
    }
    this.rows.set(snapshot.sessionId, { session, at: Date.now() });
  }

  invalidateSession(sessionId: string): void {
    this.sequence += 1;
    this.sessionsChanged.set(sessionId, this.sequence);
    this.rows.delete(sessionId);
    this.boundVersions();
  }

  invalidateUser(userId: string): void {
    this.sequence += 1;
    this.usersChanged.set(userId, this.sequence);
    for (const [id, row] of this.rows) {
      if (row.session.userId === userId) this.rows.delete(id);
    }
    this.boundVersions();
  }

  private boundVersions(): void {
    if (this.sessionsChanged.size + this.usersChanged.size > 10_000) this.reset();
  }
}

export const authSessionCache = new AuthSessionCache();
