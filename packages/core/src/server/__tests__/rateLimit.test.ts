import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { OxyServices } from '../../OxyServices';

const rateLimitMock = jest.fn();

jest.mock('express-rate-limit', () => ({
  __esModule: true,
  default: (...args: unknown[]) => rateLimitMock(...args),
}));

import { createOxyRateLimit } from '../rateLimit';

interface CapturedRateLimitOptions {
  max: (req: Request) => number;
  keyGenerator: (req: Request) => string;
  skip: (req: Request) => boolean;
}

interface RateLimitTestRequest extends Request {
  userId?: string | null;
  user?: { id?: string; _id?: string } | null;
  sessionId?: string | null;
  serviceApp?: { appId?: string } | null;
  serviceActingAs?: { userId?: string } | null;
  observedMax?: number;
  observedKey?: string;
}

const HEX24 = /^[0-9a-f]{24}$/;

function makeOxy(authHandler: RequestHandler): OxyServices {
  return {
    auth: jest.fn(() => authHandler),
  } as unknown as OxyServices;
}

function makeRequest(overrides: Partial<RateLimitTestRequest> = {}): RateLimitTestRequest {
  const ip = overrides.ip ?? '203.0.113.9';
  return {
    method: 'GET',
    path: '/api/test',
    ip,
    socket: { remoteAddress: ip },
    ...overrides,
  } as RateLimitTestRequest;
}

/** Run the anonymous limiter for a bare IP and return the store key it produced. */
function keyForIp(ip: string): string {
  const oxy = makeOxy((_req: Request, _res: Response, next: NextFunction) => next());
  const req = makeRequest({ ip });
  createOxyRateLimit(oxy)(req, {} as Response, jest.fn());
  if (typeof req.observedKey !== 'string') {
    throw new Error('key generator did not run');
  }
  return req.observedKey;
}

describe('@oxyhq/core/server rate limiter', () => {
  const originalEnv = {
    IP_HASH_SALT: process.env.IP_HASH_SALT,
    DEVICE_ID_SALT: process.env.DEVICE_ID_SALT,
  };

  beforeEach(() => {
    // Isolate salt resolution from any ambient env so key assertions are deterministic.
    delete process.env.IP_HASH_SALT;
    delete process.env.DEVICE_ID_SALT;
    rateLimitMock.mockImplementation((options: CapturedRateLimitOptions) => {
      return (req: RateLimitTestRequest, _res: Response, next: NextFunction) => {
        req.observedMax = options.max(req);
        req.observedKey = options.keyGenerator(req);
        next();
      };
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
    if (originalEnv.IP_HASH_SALT === undefined) delete process.env.IP_HASH_SALT;
    else process.env.IP_HASH_SALT = originalEnv.IP_HASH_SALT;
    if (originalEnv.DEVICE_ID_SALT === undefined) delete process.env.DEVICE_ID_SALT;
    else process.env.DEVICE_ID_SALT = originalEnv.DEVICE_ID_SALT;
  });

  it('does not trust locally decoded non-session JWT identities for quota or bucket keys', () => {
    const oxy = makeOxy((req: RateLimitTestRequest, _res: Response, next: NextFunction) => {
      req.userId = 'attacker-controlled-user';
      req.user = { id: 'attacker-controlled-user' };
      next();
    });
    const req = makeRequest();
    const next = jest.fn();

    createOxyRateLimit(oxy, { authenticatedMax: 5000, anonymousMax: 600 })(
      req,
      {} as Response,
      next,
    );

    expect(req.observedMax).toBe(600);
    // Anonymous callers are bucketed by a hashed key, NEVER the raw IP.
    expect(req.observedKey).toMatch(HEX24);
    expect(req.observedKey).not.toContain('203.0.113.9');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('uses authenticated quota and per-user keys for server-validated sessions', () => {
    const oxy = makeOxy((req: RateLimitTestRequest, _res: Response, next: NextFunction) => {
      req.userId = 'validated-user';
      req.user = { id: 'validated-user' };
      req.sessionId = 'validated-session';
      next();
    });
    const req = makeRequest();

    createOxyRateLimit(oxy, { authenticatedMax: 5000, anonymousMax: 600 })(
      req,
      {} as Response,
      jest.fn(),
    );

    expect(req.observedMax).toBe(5000);
    // Authenticated identities are keyed by the user id verbatim — NOT hashed.
    expect(req.observedKey).toBe('user:validated-user');
  });

  it('does not clobber an identity a preceding middleware already resolved', () => {
    // The limiter mutates the SHARED `req`, so the unconditional
    // `req.userId = null` that `oxy.auth({ optional: true })` writes for every
    // request it cannot authenticate is not merely a bucketing detail — it
    // erases the identity for every handler downstream of the limiter too.
    // The resolver must therefore skip entirely when a user is already present.
    // This handler stands in for that erasure.
    const clobberingAuth = jest.fn(
      (req: RateLimitTestRequest, _res: Response, next: NextFunction) => {
        req.userId = null;
        req.user = null;
        req.sessionId = null;
        next();
      },
    );
    const oxy = makeOxy(clobberingAuth as unknown as RequestHandler);
    const req = makeRequest({
      userId: 'resolved-by-the-app',
      user: { id: 'resolved-by-the-app' },
      sessionId: 'app-session',
    });

    createOxyRateLimit(oxy)(req, {} as Response, jest.fn());

    expect(req.userId).toBe('resolved-by-the-app');
    expect(req.user).toEqual({ id: 'resolved-by-the-app' });
    expect(req.sessionId).toBe('app-session');
    expect(req.observedKey).toBe('user:resolved-by-the-app');
    expect(clobberingAuth).not.toHaveBeenCalled();
  });

  it('still resolves the session when no identity is present yet', () => {
    const authHandler = jest.fn((req: RateLimitTestRequest, _res: Response, next: NextFunction) => {
      req.userId = 'resolved-by-oxy';
      req.user = { id: 'resolved-by-oxy' };
      req.sessionId = 'oxy-session';
      next();
    });
    const oxy = makeOxy(authHandler as unknown as RequestHandler);
    const req = makeRequest();

    createOxyRateLimit(oxy)(req, {} as Response, jest.fn());

    expect(authHandler).toHaveBeenCalledTimes(1);
    expect(req.observedKey).toBe('user:resolved-by-oxy');
  });

  it('continues through the anonymous limiter if optional auth returns an error', () => {
    const oxy = makeOxy((_req: Request, _res: Response, next: NextFunction) => {
      next(new Error('token rejected'));
    });
    const req = makeRequest();
    const next = jest.fn();

    createOxyRateLimit(oxy, { authenticatedMax: 5000, anonymousMax: 600 })(
      req,
      {} as Response,
      next,
    );

    expect(req.observedMax).toBe(600);
    expect(req.observedKey).toMatch(HEX24);
    expect(req.observedKey).not.toContain('203.0.113.9');
    expect(next).toHaveBeenCalledTimes(1);
  });

  describe('anonymous key hashing', () => {
    it('produces a deterministic 24-hex key that never contains the raw IP', () => {
      const first = keyForIp('203.0.113.9');
      const second = keyForIp('203.0.113.9');

      expect(first).toMatch(HEX24);
      expect(first).toBe(second);
      expect(first).not.toContain('203.0.113.9');
    });

    it('produces different keys for different IPv4 addresses', () => {
      expect(keyForIp('203.0.113.9')).not.toBe(keyForIp('198.51.100.7'));
    });

    it('buckets IPv6 addresses in the same /56 to the same key', () => {
      // 2001:db8:abcd:ee11 and 2001:db8:abcd:eeff share the /56 prefix (top byte of
      // the 4th hextet is 0xee for both); the differing bits are host bits.
      const a = keyForIp('2001:db8:abcd:ee11::1');
      const b = keyForIp('2001:db8:abcd:eeff::9999');

      expect(a).toMatch(HEX24);
      expect(a).toBe(b);
    });

    it('produces different keys for IPv6 addresses in different /56 prefixes', () => {
      const sameFiftySix = keyForIp('2001:db8:abcd:ee11::1');
      const otherFiftySix = keyForIp('2001:db8:abcd:ff11::1');

      expect(sameFiftySix).not.toBe(otherFiftySix);
    });

    it('salts the hash with IP_HASH_SALT so keys are not portable across salts', () => {
      const unsalted = keyForIp('203.0.113.9');

      process.env.IP_HASH_SALT = 'salt-a';
      const saltedA = keyForIp('203.0.113.9');

      process.env.IP_HASH_SALT = 'salt-b';
      const saltedB = keyForIp('203.0.113.9');

      expect(saltedA).toMatch(HEX24);
      expect(saltedA).not.toBe(unsalted);
      expect(saltedB).not.toBe(saltedA);
    });

    it('prefers IP_HASH_SALT over DEVICE_ID_SALT', () => {
      process.env.DEVICE_ID_SALT = 'device-salt';
      const deviceOnly = keyForIp('203.0.113.9');

      process.env.IP_HASH_SALT = 'ip-salt';
      const ipPreferred = keyForIp('203.0.113.9');

      expect(ipPreferred).not.toBe(deviceOnly);
    });

    it('falls back to the literal "unknown" key when no IP is resolvable', () => {
      const oxy = makeOxy((_req: Request, _res: Response, next: NextFunction) => next());
      const req = makeRequest({ ip: undefined, socket: {} as Request['socket'] });
      createOxyRateLimit(oxy)(req, {} as Response, jest.fn());

      expect(req.observedKey).toBe('unknown');
    });
  });
});
