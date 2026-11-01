import { AUTH_CACHE_PROBE_FRESH_MS, authSessionCache } from '../authSessionCache';
import type { CachedSession } from '../sessionCache';

const row = (sessionId = 'session-1', userId = 'user-1') =>
  ({ sessionId, userId, expiresAt: new Date(Date.now() + 60_000) }) as CachedSession;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  authSessionCache.unavailable();
});

afterEach(() => {
  authSessionCache.unavailable();
  jest.useRealTimers();
});

describe('the authentication-only session cache', () => {
  it('does not cache before a verified probe or after subscriber loss', () => {
    const initial = authSessionCache.snapshot('session-1');
    authSessionCache.set(initial, row());
    expect(authSessionCache.get('session-1')).toBeNull();

    authSessionCache.probe(Date.now());
    const healthy = authSessionCache.snapshot('session-1');
    authSessionCache.set(healthy, row());
    expect(authSessionCache.get('session-1')).toEqual(row());
    authSessionCache.unavailable();
    expect(authSessionCache.get('session-1')).toBeNull();
    expect(authSessionCache.current(healthy, 'user-1')).toBe(false);

    authSessionCache.probe(Date.now());
    expect(authSessionCache.get('session-1')).toBeNull();
  });

  it('fences a read started before a session or user revocation', () => {
    authSessionCache.probe(Date.now());
    const sessionRead = authSessionCache.snapshot('session-1');
    authSessionCache.invalidateSession('session-1');
    authSessionCache.set(sessionRead, row());
    expect(authSessionCache.current(sessionRead, 'user-1')).toBe(false);
    expect(authSessionCache.get('session-1')).toBeNull();

    const userRead = authSessionCache.snapshot('session-1');
    authSessionCache.invalidateUser('user-1');
    authSessionCache.set(userRead, row());
    expect(authSessionCache.current(userRead, 'user-1')).toBe(false);
    expect(authSessionCache.get('session-1')).toBeNull();
  });

  it('does not reject an unrelated in-flight session after another user is revoked', () => {
    authSessionCache.probe(Date.now());
    const pending = authSessionCache.snapshot('session-1');
    authSessionCache.invalidateUser('other-user');
    authSessionCache.invalidateSession('other-session');
    expect(authSessionCache.current(pending, 'user-1')).toBe(true);
    authSessionCache.set(pending, row());
    expect(authSessionCache.get('session-1')).toEqual(row());
  });

  it('stops using rows when the probe becomes stale or the session expires', () => {
    authSessionCache.probe(Date.now());
    const stale = authSessionCache.snapshot('session-1');
    authSessionCache.set(stale, row());
    jest.advanceTimersByTime(AUTH_CACHE_PROBE_FRESH_MS + 1);
    expect(authSessionCache.get('session-1')).toBeNull();
    expect(authSessionCache.current(stale, 'user-1')).toBe(false);

    authSessionCache.probe(Date.now());
    const expiring = authSessionCache.snapshot('session-1');
    authSessionCache.set(expiring, { ...row(), expiresAt: new Date(Date.now() + 10) });
    jest.advanceTimersByTime(10);
    expect(authSessionCache.get('session-1')).toBeNull();
  });
});
