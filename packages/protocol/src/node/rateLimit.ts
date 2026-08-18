/**
 * A small, dependency-free fixed-window per-IP rate limiter for the node app's
 * owner-authorized write routes.
 *
 * The node is a single-writer model (only the owner key may write), so the
 * limiter is a defence-in-depth budget on the unauthenticated edge — it caps the
 * request rate BEFORE signature verification so a flood of bogus envelopes can't
 * pin CPU on crypto. It is intentionally process-local (a single node serves one
 * owner's repo); there is no shared store to coordinate.
 *
 * Fixed-window counting, one budget per client: each key gets `max` requests per
 * `windowMs`, and the window resets lazily on the first request after it elapses.
 * The key is a SALTED HASH of the client address, never the address itself — see
 * {@link clientRateLimitKey}.
 *
 * Bounded memory (defence against a key-rotation DoS — spoofed IPs / many DIDs
 * growing the map without limit → memory exhaustion):
 *  - An ACTIVE periodic sweep on an `unref()`'d interval deletes every entry
 *    whose window has fully elapsed, so keys that are never touched again do not
 *    leak forever (lazy expiry-on-access alone cannot reclaim them). The
 *    interval is `unref()`'d so it never keeps the node process alive, and
 *    {@link RateLimiter.stop} clears it for a clean lifecycle teardown.
 *  - A hard cap on the number of tracked keys ({@link RateLimitConfig.maxEntries})
 *    evicts the OLDEST window (insertion-order LRU) when exceeded — a synchronous
 *    backstop against a burst that arrives between sweeps.
 */

import { createHmac, randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

// The package's `lib` includes `DOM` (the isomorphic root code uses Web Crypto),
// so the ambient `setInterval` overload TypeScript picks for a bare call is the
// browser one returning `number` — which has no `.unref()`. This `node/` subpath
// is Node-only; reach the Node timer globals through their `@types/node`
// signatures so the handle is correctly `NodeJS.Timeout` (no cast, no shadowing).
// Resolved at call time (not captured at module load) so test fake-timers that
// swap the globals still drive the sweep.
function nodeSetInterval(handler: () => void, ms: number): NodeJS.Timeout {
  const set: (handler: () => void, ms: number) => NodeJS.Timeout = globalThis.setInterval;
  return set(handler, ms);
}
function nodeClearInterval(timer: NodeJS.Timeout): void {
  const clear: (timer: NodeJS.Timeout) => void = globalThis.clearInterval;
  clear(timer);
}

/**
 * The HMAC key under which client addresses are hashed into rate-limit keys.
 * 256 CSPRNG bits, minted once when this module is first loaded and held only in
 * memory — never read from a config, never written anywhere, never sent.
 *
 * ## Why the salt is deliberately EPHEMERAL, and what a stable one would cost
 *
 * A rate-limit window is short-lived (`windowMs`, seconds to a minute) and this
 * limiter is process-local by design — a node serves one owner's repo and there
 * is no shared store to coordinate. So nothing here needs a key to mean the same
 * thing after a restart, or to mean the same thing on another node. That makes a
 * per-process salt not merely sufficient but BETTER than a configured one:
 *
 *   - there is no value to distribute, so there is nothing for a node operator to
 *     get wrong, nothing to rotate, and nothing to leak from an env file, a
 *     process listing or a container image;
 *   - the mapping dies with the process, so the same address hashes to a
 *     different key after every restart and the keys correlate to nothing once
 *     the process exits.
 *
 * A stable salt (an env var, a file) would buy exactly one thing this limiter
 * does not want — a client identifier that survives a restart and can be compared
 * across nodes — in exchange for a config burden and a secret at rest. That is
 * the trade, and it is why this is not configurable.
 *
 * ## What the hash does and does not buy, stated honestly
 *
 * It removes the raw address from the process's data structures: the limiter's
 * Map holds digests, so an address is no longer sitting in memory as a key for
 * the lifetime of a window, and nothing downstream can casually read one back
 * out. What it does NOT claim is secrecy against an attacker who already has the
 * live process — the salt is in the same heap, and with it the IPv4 space is
 * enumerable. That is the general reason hashing is not an acceptable AT-REST
 * form for an address anywhere in Oxy; this value is never at rest.
 */
const CLIENT_KEY_SALT = randomBytes(32);

/**
 * The rate-limit key for a request: a salted hash of the client address, or the
 * `'unknown'` sentinel when Express resolved no address at all (a request whose
 * address is unknown cannot be budgeted individually, so all of them share one
 * bucket — the same behaviour this limiter has always had).
 *
 * Truncated to 96 bits, which keeps a tracked entry to a short string beside its
 * two numbers (the memory-bounding rationale on {@link RateLimitConfig.maxEntries}
 * assumes exactly that). At the 10 000-entry cap a collision — two clients
 * sharing one budget — has probability around 10⁸/2⁹⁷, i.e. never.
 *
 * Residue, named rather than left implicit: the address is hashed VERBATIM, so an
 * IPv6 client that rotates through its /64 still mints a fresh key per address,
 * exactly as it did before this was hashed. oxy-api's `hashedIpKey` buckets IPv6
 * to /56 first to close that; doing the same here is a rate-limiting change with
 * its own reasoning (it makes a whole prefix share one budget) and is deliberately
 * not folded into a privacy fix.
 *
 * Exported for {@link createRateLimiter}'s own tests, not part of
 * `@oxyhq/protocol/node`'s public surface — it is not re-exported by the barrel.
 */
export function clientRateLimitKey(req: Request): string {
  const ip = req.ip;
  if (!ip) {
    return 'unknown';
  }
  // Single-purpose salt: it derives this key and nothing else, so there is no
  // second derivation to namespace against (oxy-api's `hashedIpKey` prefixes
  // `rl|` because its salt is shared with deviceId derivation). A future second
  // use of this salt would need a namespace, or its own salt.
  return createHmac('sha256', CLIENT_KEY_SALT).update(ip).digest('hex').slice(0, 24);
}

/** A request-rate budget: at most `max` requests per `windowMs`. */
export interface RateLimitConfig {
  /** The rolling window length, in milliseconds. */
  readonly windowMs: number;
  /** The maximum number of requests permitted within one window. */
  readonly max: number;
  /**
   * Hard cap on the number of distinct keys (client identifiers) tracked at
   * once. When the map exceeds this, the oldest-inserted window is evicted as a
   * synchronous backstop against a burst of distinct keys arriving between
   * sweeps. Defaults to {@link DEFAULT_MAX_RATE_LIMIT_ENTRIES}.
   */
  readonly maxEntries?: number;
}

/** Default budget for owner write routes (generous — single-writer model). */
export const DEFAULT_WRITE_RATE_LIMIT: RateLimitConfig = { windowMs: 60_000, max: 60 };

/**
 * Default hard cap on tracked keys. Sized so the map's worst-case footprint
 * stays small (each entry is a short string key + two numbers) while never
 * evicting a legitimately active key for the single-writer node — the owner
 * drives traffic from a handful of IPs, far below this ceiling.
 */
export const DEFAULT_MAX_RATE_LIMIT_ENTRIES = 10_000;

interface WindowCounter {
  /** Epoch ms when the current window started. */
  start: number;
  /** Requests counted in the current window. */
  count: number;
}

/**
 * The Express middleware returned by {@link createRateLimiter}, carrying a
 * {@link stop} hook so the owning app can clear the background sweep on shutdown.
 */
export interface RateLimiter {
  (req: Request, res: Response, next: NextFunction): void;
  /**
   * Stop the background sweep timer. Idempotent. Called by the node app's
   * graceful-shutdown path; not required for process exit (the timer is
   * `unref()`'d) but keeps long-lived test harnesses leak-free.
   */
  stop(): void;
}

/**
 * Build an Express middleware enforcing a fixed-window per-client rate limit.
 * Exceeding the budget responds `429 { error: 'rate_limited' }` and does not call
 * `next`. The key is {@link clientRateLimitKey} — a salted hash of Express's
 * resolved client IP, so no address is held in the tracked map.
 *
 * The returned middleware owns a background sweep timer; call {@link RateLimiter.stop}
 * to release it (e.g. on app shutdown).
 */
export function createRateLimiter(config: RateLimitConfig): RateLimiter {
  const windows = new Map<string, WindowCounter>();
  const maxEntries = config.maxEntries ?? DEFAULT_MAX_RATE_LIMIT_ENTRIES;

  // Active sweep: delete every entry whose window has fully elapsed. Running on
  // a timer (rather than only on request arrival) reclaims keys that are never
  // touched again, so a churn of distinct IPs cannot leak memory once traffic
  // for those keys stops. One pass per window is sufficient: an entry lives at
  // most `2 * windowMs` before a sweep removes it.
  function sweepExpired(): void {
    const now = Date.now();
    for (const [key, counter] of windows) {
      if (now - counter.start >= config.windowMs) {
        windows.delete(key);
      }
    }
  }

  const sweepTimer = nodeSetInterval(sweepExpired, config.windowMs);
  // Never let the sweep keep the node process alive on its own.
  sweepTimer.unref();

  function rateLimit(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    const key = clientRateLimitKey(req);
    const counter = windows.get(key);

    if (!counter || now - counter.start >= config.windowMs) {
      // Hard cap backstop: if a burst of distinct keys outran the sweep, evict
      // the oldest-inserted window before admitting a new key. A `Map` preserves
      // insertion order, so its first key is the oldest tracked entry.
      if (!counter && windows.size >= maxEntries) {
        const oldest = windows.keys().next().value;
        if (oldest !== undefined) {
          windows.delete(oldest);
        }
      }
      windows.set(key, { start: now, count: 1 });
      next();
      return;
    }

    if (counter.count >= config.max) {
      const retryAfterSec = Math.ceil((counter.start + config.windowMs - now) / 1000);
      res.setHeader('Retry-After', String(Math.max(retryAfterSec, 1)));
      res.status(429).json({ error: 'rate_limited' });
      return;
    }

    counter.count += 1;
    next();
  }

  // Attach the lifecycle hook to the middleware, yielding the `RateLimiter`
  // callable-with-`stop` without a cast.
  return Object.assign(rateLimit, {
    stop(): void {
      nodeClearInterval(sweepTimer);
    },
  });
}
