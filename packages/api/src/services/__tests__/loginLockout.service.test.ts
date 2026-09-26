/**
 * Login Lockout Service Tests (H7 regression coverage)
 *
 * These tests verify the in-memory fallback path; Redis is mocked out so
 * `getRedisClient()` returns null and the service uses its Map-backed
 * bucket. Production deployments use Redis but the policy is identical.
 */

jest.mock('../../config/redis', () => ({
  __esModule: true,
  getRedisClient: () => null,
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  reserveAttempt,
  isLockedOut,
  recordFailure,
  clearFailures,
  _resetInMemoryStateForTests,
} from '../loginLockout.service';

describe('loginLockout.service', () => {
  beforeEach(() => {
    _resetInMemoryStateForTests();
    jest.useRealTimers();
  });

  it('reports no lockout for a fresh identifier', async () => {
    const state = await isLockedOut({ scope: 'login', identifier: 'alice' });
    expect(state.locked).toBe(false);
    expect(state.attempts).toBe(0);
  });

  it('locks the account after maxAttempts failures within the window', async () => {
    const opts = {
      scope: 'login',
      identifier: 'mallory',
      maxAttempts: 3,
      windowSeconds: 60,
    };

    let last = await recordFailure(opts);
    expect(last.locked).toBe(false);
    last = await recordFailure(opts);
    expect(last.locked).toBe(false);
    last = await recordFailure(opts);
    expect(last.locked).toBe(true);
    expect(last.retryAfterSeconds).toBeGreaterThan(0);
    expect(last.retryAfterSeconds).toBeLessThanOrEqual(60);

    const check = await isLockedOut(opts);
    expect(check.locked).toBe(true);
    expect(check.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('treats identifiers case-insensitively', async () => {
    const lowerOpts = { scope: 'login', identifier: 'alice', maxAttempts: 2, windowSeconds: 60 };
    const upperOpts = { scope: 'login', identifier: 'ALICE', maxAttempts: 2, windowSeconds: 60 };

    await recordFailure(lowerOpts);
    const post = await recordFailure(upperOpts);
    expect(post.locked).toBe(true);
  });

  it('clearFailures removes the lockout state', async () => {
    const opts = { scope: 'login', identifier: 'bob', maxAttempts: 2, windowSeconds: 60 };

    await recordFailure(opts);
    await recordFailure(opts);
    expect((await isLockedOut(opts)).locked).toBe(true);

    await clearFailures(opts);
    const after = await isLockedOut(opts);
    expect(after.locked).toBe(false);
    expect(after.attempts).toBe(0);
  });

  it('isolates counters across distinct scopes', async () => {
    const loginOpts = { scope: 'login', identifier: 'eve', maxAttempts: 2, windowSeconds: 60 };
    const twoFAOpts = { scope: '2fa-login', identifier: 'eve', maxAttempts: 2, windowSeconds: 60 };

    await recordFailure(loginOpts);
    await recordFailure(loginOpts);
    expect((await isLockedOut(loginOpts)).locked).toBe(true);
    // 2FA counter should be untouched.
    expect((await isLockedOut(twoFAOpts)).locked).toBe(false);
  });

  it('does not lock once the window has elapsed', async () => {
    const opts = { scope: 'login', identifier: 'oscar', maxAttempts: 2, windowSeconds: 1 };

    await recordFailure(opts);
    await recordFailure(opts);
    expect((await isLockedOut(opts)).locked).toBe(true);

    // Move past the bucket reset by mutating the bucket's resetAt (the
    // service uses Date.now internally so we simulate by sleeping the
    // event loop a single millisecond past `windowSeconds`).
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const after = await isLockedOut(opts);
    expect(after.locked).toBe(false);
  });
});

describe('reserveAttempt', () => {
  it('reserves atomically: of 50 concurrent attempts exactly five get through, then the window is reset by a success', async () => {
    const options = { scope: 'reserve-test', identifier: `id-${Math.random()}` };
    const results = await Promise.all(Array.from({ length: 50 }, () => reserveAttempt(options)));
    expect(results.filter((result) => !result.locked)).toHaveLength(5);
    expect(results.filter((result) => result.locked)).toHaveLength(45);
    await clearFailures(options);
    expect((await reserveAttempt(options)).locked).toBe(false);
  });
});
