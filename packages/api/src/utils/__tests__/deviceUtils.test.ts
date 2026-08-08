/**
 * deviceUtils — `deriveStableDeviceId` tests (security review H1).
 *
 * The derived deviceId scopes session-grouping per (server-salt + user) so
 * two distinct users on the same browser do NOT collide on the same id. IP is
 * deliberately NOT an input (privacy invariant — no user IPs at rest). These
 * tests pin that contract.
 */

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// Only the pure `deriveStableDeviceId` is under test here, so `deviceUtils.ts`'s
// sibling imports are stubbed to keep this a unit test rather than a database one.
jest.mock('../sessionCache', () => ({ __esModule: true, default: { invalidate: jest.fn() } }));
jest.mock('../userTransform', () => ({ formatUserResponse: jest.fn() }));

import crypto from 'crypto';
import type { Request } from 'express';
import {
  deriveCoarseClientLabel,
  deriveStableDeviceId,
  deriveServiceDeviceId,
  extractDeviceInfo,
  generateDeviceFingerprint,
} from '../deviceUtils';

const STRONG_SALT_A = 'a'.repeat(48);
const STRONG_SALT_B = 'b'.repeat(48);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0.0.0 Safari/537.36';
const LANG = 'en-US,en;q=0.9';

const ORIGINAL_ENV = process.env;

describe('deriveStableDeviceId', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    process.env.DEVICE_ID_SALT = STRONG_SALT_A;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('returns a 32-char hex string for valid inputs', () => {
    const id = deriveStableDeviceId(UA, LANG, 'user-1');
    expect(id).not.toBeNull();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic for the same (ua, lang, userId) inputs', () => {
    const a = deriveStableDeviceId(UA, LANG, 'user-1');
    const b = deriveStableDeviceId(UA, LANG, 'user-1');
    expect(a).toBe(b);
  });

  it('derives the same deviceId regardless of network (no IP input)', () => {
    process.env.DEVICE_ID_SALT = 'test-salt-0123456789abcdef';
    const a = deriveStableDeviceId('Mozilla/5.0 (X11; Linux x86_64)', 'en-US', 'user1');
    expect(a).toMatch(/^[a-f0-9]{32}$/);
    expect(deriveStableDeviceId('Mozilla/5.0 (X11; Linux x86_64)', 'en-US', 'user1')).toBe(a);
  });

  it('produces DIFFERENT ids for two distinct users on the same browser', () => {
    const userA = deriveStableDeviceId(UA, LANG, 'user-A');
    const userB = deriveStableDeviceId(UA, LANG, 'user-B');
    expect(userA).not.toBeNull();
    expect(userB).not.toBeNull();
    expect(userA).not.toBe(userB);
  });

  it('produces a DIFFERENT id when the server salt changes (defends against salt-guessing)', () => {
    const withSaltA = deriveStableDeviceId(UA, LANG, 'user-1');
    process.env.DEVICE_ID_SALT = STRONG_SALT_B;
    const withSaltB = deriveStableDeviceId(UA, LANG, 'user-1');
    expect(withSaltA).not.toBeNull();
    expect(withSaltB).not.toBeNull();
    expect(withSaltA).not.toBe(withSaltB);
  });

  describe('pre-auth (userId omitted / null)', () => {
    it('still returns a stable id (deterministic with itself)', () => {
      const a = deriveStableDeviceId(UA, LANG, null);
      const b = deriveStableDeviceId(UA, LANG, null);
      const c = deriveStableDeviceId(UA, LANG);
      expect(a).not.toBeNull();
      expect(a).toBe(b);
      expect(a).toBe(c);
    });

    it('produces a DIFFERENT id from any post-auth id derived from the same inputs', () => {
      const preAuth = deriveStableDeviceId(UA, LANG, null);
      const postAuth = deriveStableDeviceId(UA, LANG, 'user-1');
      expect(preAuth).not.toBeNull();
      expect(postAuth).not.toBeNull();
      expect(preAuth).not.toBe(postAuth);
    });

    it('treats empty-string userId as pre-auth', () => {
      const empty = deriveStableDeviceId(UA, LANG, '');
      const preAuth = deriveStableDeviceId(UA, LANG, null);
      expect(empty).toBe(preAuth);
    });
  });

  describe('unresolvable inputs', () => {
    it('returns null when DEVICE_ID_SALT is unset', () => {
      delete process.env.DEVICE_ID_SALT;
      expect(deriveStableDeviceId(UA, LANG, 'user-1')).toBeNull();
    });

    it('returns null when DEVICE_ID_SALT is empty', () => {
      process.env.DEVICE_ID_SALT = '';
      expect(deriveStableDeviceId(UA, LANG, 'user-1')).toBeNull();
    });

    it.each([
      ['empty UA', ''],
      ['literal "unknown" UA', 'unknown'],
    ])('returns null for %s', (_label, ua) => {
      expect(deriveStableDeviceId(ua, LANG, 'user-1')).toBeNull();
    });
  });
});

describe('extractDeviceInfo', () => {
  const SAVED_SALT = process.env.DEVICE_ID_SALT;

  beforeEach(() => {
    process.env.DEVICE_ID_SALT = STRONG_SALT_A;
  });

  afterEach(() => {
    if (SAVED_SALT === undefined) {
      delete process.env.DEVICE_ID_SALT;
    } else {
      process.env.DEVICE_ID_SALT = SAVED_SALT;
    }
  });

  it('returns no ipAddress and no location', () => {
    const req = {
      headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en', 'cf-ipcountry': 'ES' },
      ip: '203.0.113.7',
      connection: { remoteAddress: '203.0.113.7' },
    } as unknown as Request;
    const info = extractDeviceInfo(req);
    expect('ipAddress' in info).toBe(false);
    expect('location' in info).toBe(false);
  });
});

/**
 * deviceUtils — `deriveServiceDeviceId` tests.
 *
 * The server-minted device id is keyed by (server-salt + userId + RP key),
 * NOT by the caller's UA/IP. These tests pin: determinism (so one
 * (user, RP) reuses one session), per-user scoping (security review H1),
 * per-RP scoping, and fail-closed behaviour when the salt is unset.
 */
describe('deriveServiceDeviceId', () => {
  const RP_A = 'https://relying.party.example';
  const RP_B = 'https://other.party.example';
  const SAVED_SALT = process.env.DEVICE_ID_SALT;

  beforeEach(() => {
    process.env.DEVICE_ID_SALT = STRONG_SALT_A;
  });

  afterEach(() => {
    if (SAVED_SALT === undefined) {
      delete process.env.DEVICE_ID_SALT;
    } else {
      process.env.DEVICE_ID_SALT = SAVED_SALT;
    }
  });

  it('returns a 32-char hex string for valid inputs', () => {
    const id = deriveServiceDeviceId('user-1', RP_A);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic for the same (userId, key) inputs', () => {
    const a = deriveServiceDeviceId('user-1', RP_A);
    const b = deriveServiceDeviceId('user-1', RP_A);
    expect(a).toBe(b);
  });

  it('produces DIFFERENT ids for two distinct users with the same RP key (per-user scoping, H1)', () => {
    const userA = deriveServiceDeviceId('user-A', RP_A);
    const userB = deriveServiceDeviceId('user-B', RP_A);
    expect(userA).not.toBe(userB);
  });

  it('produces DIFFERENT ids for the same user across two distinct RP keys (per-RP scoping)', () => {
    const rpA = deriveServiceDeviceId('user-1', RP_A);
    const rpB = deriveServiceDeviceId('user-1', RP_B);
    expect(rpA).not.toBe(rpB);
  });

  it('produces a DIFFERENT id when the server salt changes', () => {
    const withSaltA = deriveServiceDeviceId('user-1', RP_A);
    process.env.DEVICE_ID_SALT = STRONG_SALT_B;
    const withSaltB = deriveServiceDeviceId('user-1', RP_A);
    expect(withSaltA).not.toBe(withSaltB);
  });

  it('can never collide with a UA-derived id (distinct "idp" namespace)', () => {
    const serviceId = deriveServiceDeviceId('user-1', RP_A);
    const stableId = deriveStableDeviceId(UA, LANG, 'user-1');
    expect(serviceId).not.toBe(stableId);
  });

  it('THROWS (fail-closed) when DEVICE_ID_SALT is unset', () => {
    delete process.env.DEVICE_ID_SALT;
    expect(() => deriveServiceDeviceId('user-1', RP_A)).toThrow(/DEVICE_ID_SALT/);
  });

  it('THROWS (fail-closed) when DEVICE_ID_SALT is empty', () => {
    process.env.DEVICE_ID_SALT = '';
    expect(() => deriveServiceDeviceId('user-1', RP_A)).toThrow(/DEVICE_ID_SALT/);
  });
});

/**
 * deviceUtils — `deriveCoarseClientLabel` tests (issue #691).
 *
 * The approval screen's "where did this come from" line. The label is COARSE by
 * design: a browser bucket plus an OS bucket, nothing else. These tests pin the
 * two properties that make it safe to store and display — the raw User-Agent
 * never survives the derivation, and anything unidentifiable degrades to `null`
 * instead of a guessed label.
 */
describe('deriveCoarseClientLabel', () => {
  it.each([
    [
      'Chrome on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.127 Safari/537.36',
    ],
    [
      'Firefox on macOS',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0',
    ],
    [
      'Safari on iOS',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    ],
    ['Firefox on Linux', 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0'],
    [
      // Android UAs also contain "Linux"; the mobile platform must win.
      'Chrome on Android',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    ],
    [
      'Edge on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
    ],
    [
      'Opera on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/112.0.0.0',
    ],
    [
      'Chrome on iOS',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.69 Mobile/15E148 Safari/604.1',
    ],
    [
      'Firefox on iOS',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/127.0 Mobile/15E148 Safari/605.1.15',
    ],
  ])('derives %s', (expected, userAgent) => {
    expect(deriveCoarseClientLabel(userAgent)).toBe(expected);
  });

  it('never leaks the raw User-Agent or any version detail into the label', () => {
    const userAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.127 Safari/537.36';
    const label = deriveCoarseClientLabel(userAgent);

    expect(label).toBe('Chrome on Windows');
    expect(label).not.toContain('126.0.6478.127');
    expect(label).not.toContain('AppleWebKit');
    expect(label).not.toContain('Win64');
    expect((label ?? '').length).toBeLessThanOrEqual(64);
  });

  it('drops the platform half rather than labelling it "Unknown"', () => {
    // A recognised browser on an unrecognised platform is still useful on its
    // own; "Chrome on Unknown" would be a junk label.
    const label = deriveCoarseClientLabel('Mozilla/5.0 (SomeFuturePlatform) Chrome/200.0');
    expect(label).toBe('Chrome');
  });

  it.each([
    ['a native okhttp client (React Native / Android)', 'okhttp/4.12.0'],
    ['a native iOS URLSession client', 'MyApp/1.0 CFNetwork/1494.0.7 Darwin/23.4.0'],
    ['a command-line HTTP client', 'curl/8.4.0'],
    ['junk', '!!!! 12345 ????'],
    ['a platform with no identifiable browser', 'SomeBot/1.0 (Windows NT 10.0)'],
    ['the literal "unknown" placeholder', 'unknown'],
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['undefined', undefined],
    ['null', null],
  ])('returns null for %s (never invents a label)', (_label, userAgent) => {
    expect(deriveCoarseClientLabel(userAgent)).toBeNull();
  });

  it('never derives anything from an IP, country, or language header value', () => {
    // The derivation reads ONE input — the User-Agent. Values that would be
    // network/geo signals are not browser strings and yield nothing.
    expect(deriveCoarseClientLabel('203.0.113.7')).toBeNull();
    expect(deriveCoarseClientLabel('ES')).toBeNull();
    expect(deriveCoarseClientLabel('en-US,en;q=0.9')).toBeNull();
  });
});

describe('generateDeviceFingerprint', () => {
  it('preserves 64-character client fingerprint strings instead of hashing them as empty structured objects', () => {
    const firstClientFingerprint = 'a'.repeat(64);
    const secondClientFingerprint = 'b'.repeat(64);

    expect(generateDeviceFingerprint(firstClientFingerprint)).toBe(
      firstClientFingerprint
    );
    expect(generateDeviceFingerprint(secondClientFingerprint)).toBe(
      secondClientFingerprint
    );
    expect(generateDeviceFingerprint(firstClientFingerprint)).not.toBe(
      generateDeviceFingerprint(secondClientFingerprint)
    );
    expect(generateDeviceFingerprint(firstClientFingerprint)).not.toBe(
      crypto.createHash('sha256').update('').digest('hex')
    );
  });

  it('continues to hash structured device fingerprints', () => {
    expect(
      generateDeviceFingerprint({
        userAgent: 'Mozilla/5.0',
        platform: 'macOS',
        language: 'en-US',
        timezone: 'America/Los_Angeles',
        screen: { width: 1440, height: 900, colorDepth: 24 },
      })
    ).toBe(
      crypto
        .createHash('sha256')
        .update('Mozilla/5.0|macOS|en-US|America/Los_Angeles|1440x900x24')
        .digest('hex')
    );
  });
});
