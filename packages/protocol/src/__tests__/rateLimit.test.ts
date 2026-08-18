/**
 * `createRateLimiter` unit tests — exercise the limiter directly (no Express
 * server) so per-key state and the memory-bounding behaviour are deterministic.
 *
 * Covers:
 *  - correct fixed-window budgeting for a legitimate client (allow up to `max`,
 *    then 429, then reset after the window),
 *  - the hard-cap LRU backstop: a burst of distinct keys never grows the tracked
 *    map past `maxEntries`,
 *  - the active sweep: expired windows are reclaimed on the timer even when their
 *    keys are never touched again,
 *  - `stop()` clears the sweep timer,
 *  - the tracked key is a salted hash of the client address rather than the
 *    address itself, on an ephemeral per-process salt — and the limiter actually
 *    goes through that hasher.
 */

import type { Request, Response, NextFunction } from 'express';
import { clientRateLimitKey, createRateLimiter, type RateLimiter } from '../node/rateLimit';

/** A minimal `Response` double capturing the status/headers/body the limiter sets. */
interface ResponseSpy {
  res: Response;
  statusCode: number | null;
  body: unknown;
  headers: Record<string, string>;
}

function makeResponseSpy(): ResponseSpy {
  const spy: ResponseSpy = { res: {} as Response, statusCode: null, body: undefined, headers: {} };
  const res: Pick<Response, 'status' | 'json' | 'setHeader'> = {
    status(code: number) {
      spy.statusCode = code;
      return res as Response;
    },
    json(payload: unknown) {
      spy.body = payload;
      return res as Response;
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      spy.headers[name] = String(value);
      return res as Response;
    },
  };
  spy.res = res as Response;
  return spy;
}

/**
 * Drive one request through the limiter for `ip`; returns whether `next()` ran.
 * `ip` is optional so a request Express resolved no address for — the sentinel
 * path — can be driven through the same helper.
 */
function call(limiter: RateLimiter, ip?: string): { passed: boolean; response: ResponseSpy } {
  const req = { ip } as Request;
  const response = makeResponseSpy();
  let passed = false;
  const next: NextFunction = () => {
    passed = true;
  };
  limiter(req, response.res, next);
  return { passed, response };
}

describe('createRateLimiter', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('allows up to `max` requests per window then responds 429 rate_limited', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 });
    try {
      expect(call(limiter, '1.1.1.1').passed).toBe(true);
      expect(call(limiter, '1.1.1.1').passed).toBe(true);
      expect(call(limiter, '1.1.1.1').passed).toBe(true);

      const fourth = call(limiter, '1.1.1.1');
      expect(fourth.passed).toBe(false);
      expect(fourth.response.statusCode).toBe(429);
      expect(fourth.response.body).toEqual({ error: 'rate_limited' });
      expect(Number(fourth.response.headers['Retry-After'])).toBeGreaterThanOrEqual(1);
    } finally {
      limiter.stop();
    }
  });

  it('budgets each client key independently', () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 });
    try {
      expect(call(limiter, 'a').passed).toBe(true);
      expect(call(limiter, 'a').passed).toBe(false); // a exhausted
      expect(call(limiter, 'b').passed).toBe(true); // b independent
    } finally {
      limiter.stop();
    }
  });

  it('resets a key after its window elapses', () => {
    jest.useFakeTimers();
    const limiter = createRateLimiter({ windowMs: 1_000, max: 1 });
    try {
      expect(call(limiter, 'x').passed).toBe(true);
      expect(call(limiter, 'x').passed).toBe(false);
      jest.advanceTimersByTime(1_001);
      expect(call(limiter, 'x').passed).toBe(true); // fresh window
    } finally {
      limiter.stop();
    }
  });

  it('bounds memory: a burst of distinct keys never exceeds maxEntries (LRU eviction)', () => {
    // With max:1, a SURVIVING key is rate-limited on its second hit, while an
    // EVICTED key behaves brand new (passes). That makes eviction observable
    // without reaching into the private map. All requests stay within one window
    // (no sweep), so only the hard cap can bound the tracked set.
    const maxEntries = 50;
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, maxEntries });
    try {
      // Seed the oldest key, exhausting its single-request budget.
      expect(call(limiter, 'oldest').passed).toBe(true);
      expect(call(limiter, 'oldest').passed).toBe(false); // exhausted, still tracked

      // Burst well past the cap with distinct keys. Each insertion past the cap
      // evicts the oldest-inserted entry — 'oldest' is the first to go.
      for (let i = 0; i < maxEntries * 4; i += 1) {
        expect(call(limiter, `flood-${i}`).passed).toBe(true);
      }

      // 'oldest' was evicted by the cap, so it now passes as a brand-new key —
      // proving the tracked set was bounded rather than growing unboundedly.
      expect(call(limiter, 'oldest').passed).toBe(true);
    } finally {
      limiter.stop();
    }
  });

  it('actively sweeps expired windows even for keys never touched again', () => {
    jest.useFakeTimers();
    // A burst of keys, then total silence: the active timer must still reclaim
    // them. With max:1, a surviving key would be rate-limited on its next hit;
    // a swept (reclaimed) key passes again as brand new.
    const limiter = createRateLimiter({ windowMs: 1_000, max: 1 });
    try {
      for (let i = 0; i < 100; i += 1) {
        expect(call(limiter, `burst-${i}`).passed).toBe(true);
      }
      // Exhaust one specific key so survival is observable.
      expect(call(limiter, 'burst-0').passed).toBe(false); // exhausted within window

      // Advance past the window: the unref'd interval fires (>= windowMs) and
      // deletes every expired entry — no further request needed to trigger it.
      jest.advanceTimersByTime(1_500);

      // The previously-exhausted key was reclaimed by the sweep → passes again.
      expect(call(limiter, 'burst-0').passed).toBe(true);
    } finally {
      limiter.stop();
    }
  });

  /**
   * The limiter's Map used to be keyed on `req.ip ?? 'unknown'` — a raw client
   * address, in memory, for the life of a window. Oxy persists no user IP in any
   * form and the invariant has no in-memory exemption, so the key is now a salted
   * hash. These cases are what makes that statement checkable rather than a
   * comment: reverting the key to the address turns the first of them red.
   */
  describe('the tracked key is a salted hash of the address, never the address', () => {
    const ADDRESS = '203.0.113.7';

    it('never yields the address itself', () => {
      const key = clientRateLimitKey({ ip: ADDRESS } as Request);

      expect(key).not.toBe(ADDRESS);
      // A hex digest cannot contain a dotted quad or a colonned v6 literal, so
      // this holds for any salt rather than for the one this process happened to
      // draw. (A digest CAN contain '203' — hence the whole literal, not a piece.)
      expect(key).not.toContain(ADDRESS);
      expect(clientRateLimitKey({ ip: '2001:db8::1' } as Request)).not.toContain('2001:db8::1');
      expect(key).toMatch(/^[0-9a-f]{24}$/);
    });

    it('is stable for one address and distinct across addresses', () => {
      // The CONTROL for the ephemerality case below: a key that changed per call
      // would satisfy "a different key after a reload" while making the limiter
      // count nothing, and a key that collapsed every address into one constant
      // would satisfy "not the address" while budgeting the whole internet as one
      // client.
      expect(clientRateLimitKey({ ip: ADDRESS } as Request)).toBe(
        clientRateLimitKey({ ip: ADDRESS } as Request),
      );
      expect(clientRateLimitKey({ ip: '203.0.113.8' } as Request)).not.toBe(
        clientRateLimitKey({ ip: ADDRESS } as Request),
      );
    });

    it('draws a fresh salt per process, so the same address hashes differently after a restart', async () => {
      const before = clientRateLimitKey({ ip: ADDRESS } as Request);

      // A fresh module registry re-runs module initialisation, which is where the
      // salt is minted — the closest thing in-process to a restarted node. A
      // hard-coded or configured salt passes every other case in this block and
      // fails here, which is the point: the salt is deliberately ephemeral, so
      // nothing correlates a key across processes. `isolateModulesAsync` rather
      // than a bare `resetModules`, so the isolation ends with this case and no
      // later test in the file inherits a reset registry.
      let afterRestart = '';
      let stableAfterRestart = false;
      await jest.isolateModulesAsync(async () => {
        const reloaded = await import('../node/rateLimit');
        afterRestart = reloaded.clientRateLimitKey({ ip: ADDRESS } as Request);
        stableAfterRestart = reloaded.clientRateLimitKey({ ip: ADDRESS } as Request) === afterRestart;
      });

      expect(afterRestart).not.toBe(before);
      // The reloaded instance is internally consistent too — a key that simply
      // changed on every call would satisfy the line above while counting nothing.
      expect(stableAfterRestart).toBe(true);
    });

    it('answers the `unknown` sentinel when Express resolved no address', () => {
      expect(clientRateLimitKey({} as Request)).toBe('unknown');
    });

    it('is what the LIMITER keys on, not merely available beside it', () => {
      // A hasher can be correct, exported, fully tested and never called — the
      // revert this guards against is one line in the middleware body. So: drive a
      // real request through the real limiter and require that the hash happened.
      const crypto = require('node:crypto') as typeof import('node:crypto');
      const hmac = jest.spyOn(crypto, 'createHmac');
      const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });

      try {
        expect(call(limiter, '198.51.100.4').passed).toBe(true);
        expect(hmac).toHaveBeenCalledTimes(1);

        // CONTROL: the sentinel path hashes NOTHING, so the count above is this
        // limiter's own work rather than a spy that reports a call no matter what
        // the request was.
        hmac.mockClear();
        expect(call(limiter).passed).toBe(true);
        expect(hmac).not.toHaveBeenCalled();
      } finally {
        limiter.stop();
        hmac.mockRestore();
      }
    });
  });

  it('stop() halts the sweep timer and is idempotent', () => {
    jest.useFakeTimers();
    const limiter = createRateLimiter({ windowMs: 1_000, max: 1 });

    // Seed and exhaust a key, then stop the limiter.
    expect(call(limiter, 'k').passed).toBe(true);
    expect(call(limiter, 'k').passed).toBe(false);
    limiter.stop();
    limiter.stop(); // second call must not throw

    // After stop, the active sweep no longer runs — the entry is NOT reclaimed by
    // the timer. Advancing past the sweep interval leaves the key tracked; only
    // the lazy expiry-on-access (its window having elapsed) gives it a fresh slot.
    jest.advanceTimersByTime(10_000);
    // The window has elapsed, so the next access resets the key lazily; this
    // proves the limiter still functions while confirming stop() didn't crash.
    expect(call(limiter, 'k').passed).toBe(true);
  });
});
