import { createHmac } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import type { Request, RequestHandler } from 'express';
import rateLimit, { type Store } from 'express-rate-limit';
import type { OxyServices } from '../OxyServices';
import { createOptionalOxyAuth } from './auth';

/**
 * Server-only rate limiting for Oxy backends.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every Oxy backend previously shipped its own copy-pasted `security.ts`
 * implementing the same per-user/per-IP rate limiter — and every copy carried
 * the same latent bug: the limiter ran BEFORE the session was resolved, so
 * `req.user` was always undefined inside it. Consequences:
 *   1. Authenticated users got the low ANONYMOUS limit.
 *   2. Requests were keyed by IP. Behind a shared load balancer (e.g. the AWS
 *      ALB) many users share one egress IP, so a single bucket was split across
 *      all of them → frequent, spurious HTTP 429s.
 *
 * `@oxyhq/core` already owns the session: `oxy.auth()` resolves `req.user` /
 * `req.userId`. Per-user rate limiting is the same concern (session identity),
 * so it belongs here — once — instead of being re-implemented per app.
 *
 * WHAT IT PROVIDES
 * ----------------
 * `createOxyRateLimit(oxy, options)` returns a SINGLE composed middleware that:
 *   1. Resolves the user via `createOptionalOxyAuth` (idempotent — it skips
 *      resolution entirely if a prior middleware already resolved a user, so
 *      the limiter can never erase an identity it did not create).
 *   2. Applies an `express-rate-limit` limiter keyed PER USER when
 *      authenticated, falling back to the (IPv6-safe) IP otherwise, with
 *      generous, media-app-realistic defaults and sensible exemptions.
 *
 * Mount it after CORS and before your routers:
 * ```ts
 * app.use(cors(...));
 * app.use(oxy.rateLimit({ store }));   // resolves session + limits per user
 * app.use('/api', apiRouter);
 * ```
 */

/** Minimal shape of the request after Oxy session resolution. */
interface OxyAuthedRequest extends Request {
  userId?: string | null;
  user?: { id?: string; _id?: string } | null;
  sessionId?: string | null;
  serviceApp?: { appId?: string } | null;
  serviceActingAs?: { userId?: string } | null;
}

export interface OxyRateLimitOptions {
  /**
   * Max requests per window for AUTHENTICATED users (keyed per user).
   * Default 5000 — ~5.5 req/s sustained, comfortable for a media client that
   * fans out into many small requests per screen.
   */
  authenticatedMax?: number;
  /**
   * Max requests per window for ANONYMOUS callers (keyed per IP).
   * Default 600 — enough to browse public pages while bounding abuse.
   */
  anonymousMax?: number;
  /** Rate-limit window in milliseconds. Default 15 minutes. */
  windowMs?: number;
  /**
   * Optional `express-rate-limit` store (e.g. a Redis store) for distributed
   * limiting across instances. Defaults to the library's in-memory store.
   */
  store?: Store;
  /**
   * Extra path predicates to exempt from limiting, in addition to the built-in
   * exemptions (uploads, image proxy, streaming sub-requests, health probes,
   * CORS preflight). Return `true` to skip limiting for the request.
   */
  exempt?: (req: Request) => boolean;
  /** Response message body sent with a 429. */
  message?: string;
  /**
   * Options forwarded to the internal `oxy.auth({ optional: true })` resolver
   * (e.g. `{ jwtSecret }` to verify service tokens). `optional` is forced true.
   */
  auth?: Parameters<OxyServices['auth']>[0];
}

/**
 * Built-in exemptions. A media app's cover-art/avatar fan-out and HLS
 * sub-requests must not consume the coarse global budget; health probes from
 * the load balancer must never be limited; CORS preflight is not a real call.
 */
function isBuiltInExempt(req: Request): boolean {
  const path = req.path;
  return (
    req.method === 'OPTIONS' ||
    path.startsWith('/files/upload') ||
    path.includes('/images/') ||
    path.includes('/media/') ||
    path.startsWith('/api/stream/') ||
    path.includes('/stream/') ||
    path === '/health' ||
    path.endsWith('/health')
  );
}

/**
 * Anonymous rate-limit keys must be PRIVACY-PRESERVING: the raw client IP must
 * never reach a store at rest (in-memory or Redis). We therefore HMAC-hash the
 * IP into a short, transient-only bucket key. Two IPv6-specific concerns shape
 * the pre-hash normalization:
 *
 *  - IPv6 hosts are typically handed an entire /64 (often a /56), so a single
 *    host can rotate through an enormous address space and evade a per-address
 *    limit. We bucket IPv6 to its /56 prefix BEFORE hashing.
 *  - express-rate-limit only exposes an `ipKeyGenerator` /56 helper from v8
 *    onwards; `@oxyhq/core` pins v7 (peer `^7.0.0`), so the masking is
 *    implemented here rather than pulling a major-version bump of a
 *    security-critical dependency (and its rate-limit-redis compatibility) into
 *    an unrelated privacy change. This mirrors `packages/api/src/utils/ipKey.ts`.
 */
const IPV6_SUBNET_BITS = 56;

/** Expand an IPv6 literal (handling `::` and embedded IPv4) to 8 numeric hextets, or null if unparseable. */
function ipv6Hextets(ip: string): number[] | null {
  let addr = ip;
  const zone = addr.indexOf('%');
  if (zone !== -1) {
    addr = addr.slice(0, zone);
  }

  // Embedded IPv4 tail (e.g. `::ffff:203.0.113.7`) → fold the dotted quad into two hextets.
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1 && addr.slice(lastColon + 1).includes('.')) {
    const v4 = addr.slice(lastColon + 1);
    if (!isIPv4(v4)) {
      return null;
    }
    const octets = v4.split('.').map((part) => Number.parseInt(part, 10));
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    addr = `${addr.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = addr.split('::');
  if (halves.length > 2) {
    return null;
  }
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 1) {
    groups = head;
  } else {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) {
      return null;
    }
    groups = [...head, ...new Array(missing).fill('0'), ...tail];
  }
  if (groups.length !== 8) {
    return null;
  }
  const hextets = groups.map((group) => Number.parseInt(group || '0', 16));
  if (hextets.some((value) => Number.isNaN(value) || value < 0 || value > 0xffff)) {
    return null;
  }
  return hextets;
}

/** Mask an IPv6 address to its /{bits} prefix, returned as a canonical hex string. */
function maskIPv6(ip: string, bits: number): string {
  const hextets = ipv6Hextets(ip);
  if (!hextets) {
    return ip;
  }
  const masked = hextets.map((hextet, index) => {
    const groupStart = index * 16;
    if (groupStart >= bits) {
      return 0;
    }
    const keepBits = Math.min(16, bits - groupStart);
    const mask = keepBits >= 16 ? 0xffff : (0xffff << (16 - keepBits)) & 0xffff;
    return hextet & mask;
  });
  return `${masked.map((hextet) => hextet.toString(16)).join(':')}/${bits}`;
}

/**
 * Hash a client IP into a privacy-preserving bucket key. IPv6 is bucketed to its
 * /56 prefix first (so a single v6 host can't rotate through its allocation to
 * mint fresh keys), then HMAC'd with the server-side salt. The salt is resolved
 * at CALL time (`IP_HASH_SALT`, else `DEVICE_ID_SALT`, else empty) — an empty
 * salt still hashes, which beats storing a raw IP; backends SHOULD set one of
 * those envs. The `rl|` namespace ensures a rate-limit key can never collide
 * with, or be correlated against, a deviceId derivation that reuses the same
 * salt. The result is a short hex digest with no colons, so it is Redis-safe.
 */
function hashAnonymousIp(ip: string): string {
  const normalized =
    isIPv6(ip) && !ip.startsWith('::ffff:') ? maskIPv6(ip, IPV6_SUBNET_BITS) : ip;
  const salt = process.env.IP_HASH_SALT || process.env.DEVICE_ID_SALT || '';
  return createHmac('sha256', salt).update(`rl|${normalized}`).digest('hex').slice(0, 24);
}

/**
 * Resolve the trusted authenticated rate-limit key.
 *
 * Only identities that came from a server-validated session or a verified
 * service token/delegation may pick a bucket. `req.sessionId` is the marker
 * for the former: `oxy.auth()` sets it only after `validateSession()` came
 * back valid, so requiring it here means an identity written by some OTHER
 * middleware — which this package cannot vouch for — shares the anonymous
 * per-IP bucket rather than getting the authenticated quota.
 */
function resolveTrustedAuthenticatedKey(req: OxyAuthedRequest): string | null {
  const userId = req.userId ?? req.user?.id ?? req.user?._id;
  if (userId && req.sessionId) {
    return `user:${userId}`;
  }

  const delegatedUserId = req.serviceActingAs?.userId;
  if (delegatedUserId && req.serviceApp?.appId) {
    return `user:${delegatedUserId}`;
  }

  const serviceAppId = req.serviceApp?.appId;
  if (serviceAppId) {
    return `service:${serviceAppId}`;
  }

  return null;
}

/** Resolve the rate-limit key: per trusted authenticated identity, else per hashed (IPv6-bucketed) IP. */
function resolveKey(req: OxyAuthedRequest): string {
  const authenticatedKey = resolveTrustedAuthenticatedKey(req);
  if (authenticatedKey) {
    return authenticatedKey;
  }
  const ip = req.ip || req.socket.remoteAddress;
  if (!ip) {
    return 'unknown';
  }
  return hashAnonymousIp(ip);
}

/**
 * Build the composed Oxy rate-limit middleware. See module docs for rationale.
 */
export function createOxyRateLimit(
  oxy: OxyServices,
  options: OxyRateLimitOptions = {},
): RequestHandler {
  const {
    authenticatedMax = 5000,
    anonymousMax = 600,
    windowMs = 15 * 60 * 1000,
    store,
    exempt,
    message = 'Too many requests, please try again later.',
    auth,
  } = options;

  // Idempotent optional-auth resolver. Reuses the SAME session resolution as
  // every protected route, so the limiter keys by the real user identity.
  //
  // `createOptionalOxyAuth` — NOT the raw `oxy.auth({ optional: true })` —
  // because only the former skips resolution when a preceding middleware has
  // already resolved a user. The raw middleware writes `req.userId = null` on
  // every request it cannot authenticate, and because it mutates the shared
  // `req` that erasure is visible to every handler downstream of the limiter,
  // not just to the bucket calculation.
  const resolveSession = createOptionalOxyAuth(oxy, { auth });

  const skip = (req: Request): boolean =>
    isBuiltInExempt(req) || (exempt ? exempt(req) : false);

  const limiter = rateLimit({
    windowMs,
    ...(store ? { store } : {}),
    max: (req: Request): number => {
      return resolveTrustedAuthenticatedKey(req as OxyAuthedRequest)
        ? authenticatedMax
        : anonymousMax;
    },
    keyGenerator: (req: Request): string => resolveKey(req as OxyAuthedRequest),
    message,
    standardHeaders: true,
    legacyHeaders: false,
    skip,
    // hashAnonymousIp already buckets IPv6 to /56 before HMAC; disable the v8
    // static source scan that false-positives on req.ip (ERR_ERL_KEY_GEN_IPV6).
    validate: { keyGeneratorIpFallback: false },
  });

  return (req, res, next) => {
    // Skipped paths bypass BOTH session resolution and limiting — cheap and
    // safe for static/streaming/health traffic.
    if (skip(req)) {
      next();
      return;
    }
    resolveSession(req, res, (err?: unknown) => {
      if (err) {
        // Optional auth never rejects; a token error just means "anonymous".
        // Swallow the error and continue through the anonymous limiter.
        limiter(req, res, next);
        return;
      }
      limiter(req, res, next);
    });
  };
}
