import rateLimit from "express-rate-limit";
import slowDown from "express-slow-down";
import { type Request, Response, NextFunction } from "express";
import helmet from "helmet";
import { RedisStore } from "rate-limit-redis";
import type { RedisReply } from "rate-limit-redis";
import { getRedisClient } from "../config/redis";
import type { AuthRequest } from "./auth";
import { verifyServiceToken } from "./serviceToken";
import { hashedIpKey } from "../utils/ipKey";

const isProd = process.env.NODE_ENV !== 'development';

/** hashedIpKey already buckets IPv6 before HMAC; silence express-rate-limit v8's false-positive scan. */
const rateLimitValidate = { validate: { keyGeneratorIpFallback: false } } as const;

// Build Redis-backed store options if available, otherwise fall back to in-memory.
// Each limiter MUST pass a unique `prefix` so that hits land in distinct Redis
// keys; otherwise a request that flows through both the global limiter and a
// per-route limiter increments the same counter twice and express-rate-limit
// emits ERR_ERL_DOUBLE_COUNT (and the user's effective budget is halved).
function makeStore(prefix: string) {
  const redis = getRedisClient();
  if (!redis) return {};
  return {
    store: new RedisStore({
      prefix,
      sendCommand: (...args: string[]) =>
        redis.call(args[0], ...args.slice(1)) as Promise<RedisReply>,
    }),
  };
}

/**
 * Paths hit ONLY by the first-party IdP worker (auth.oxy.so) server-to-server,
 * never by a browser directly:
 *   - GET  /session/validate/:id    (worker: fetchUserFromAPI / validateSession)
 *
 * The IdP worker fans EVERY user's session flow through this, from a small pool
 * of shared Cloudflare egress IPs. Subjecting it to the per-IP browser budget
 * (rl:general 1000/15min) lets normal multi-user traffic exhaust the budget on
 * one worker IP → 429 → the IdP fails closed → RP auth guards re-bounce and
 * amplify the load. These are trusted infrastructure calls, NOT browser traffic,
 * so they are excluded from the general per-IP limiter and capped instead by
 * their own dedicated route limiter (idpServiceLimiter for `/session/validate/`).
 *
 * MOUNT-ORDER INVARIANT: the general `rateLimiter` skips these paths, so any
 * path listed here MUST carry its OWN dedicated limiter at its route. Adding a
 * path here without a route-level limiter would leave it entirely unthrottled.
 * `/session/validate-header/` is intentionally NOT matched — it is bearer-cross-
 * checked and browser-reachable, so it stays under the general budget.
 */
export function isIdpServiceToServicePath(path: string): boolean {
  return path.startsWith('/session/validate/');
}

/**
 * Paths hit ONLY by relying-app backends server-to-server via a `federation:write`
 * service token, never by a browser directly — the federation sign-on-behalf
 * surface:
 *   - POST /federation/sign            (HTTP-Signature signing on behalf)
 *   - GET  /federation/public-key/:u   (publish an actor's public key block)
 *   - POST /federation/follow          (mirror a remote follow into the graph)
 *
 * Every route under `/federation/` is gated by `serviceAuthMiddleware`, so the
 * whole prefix is service-to-service. A relying app (e.g. Mention) fans ALL of
 * its outbound ActivityPub signing through a SINGLE NAT egress IP — an outbox
 * backfill or a large delivery fan-out legitimately signs tens of thousands of
 * requests in a burst. Subjecting that to the per-IP browser budget
 * (`rl:general`, 1000/15min) exhausts the shared budget in seconds → 429 → ALL
 * of that app's federation signing (and every other oxy-api call from the same
 * IP) fails intermittently, silently degrading outbound federation. So these
 * paths are excluded from the general per-IP limiter (and the slowDown latency
 * penalty) and capped instead by their own dedicated high-ceiling limiter
 * (`federationServiceLimiter`).
 *
 * MOUNT-ORDER INVARIANT: the general `rateLimiter` skips these paths, so the
 * `/federation` mount MUST carry `federationServiceLimiter` (it does, in
 * server.ts). Adding a path here without that dedicated limiter would leave it
 * entirely unthrottled.
 */
export function isFederationServiceToServicePath(path: string): boolean {
  return path.startsWith('/federation/');
}

/**
 * Exact paths that are EXCLUSIVELY service-to-service (each gated by
 * `serviceAuthMiddleware`) yet live UNDER a user-facing prefix, and that a
 * relying app's federation/connectors backfill calls in BULK — all fanned
 * through ONE NAT egress IP:
 *   - PUT  /users/resolve             (find-or-create a federated/agent user)
 *   - POST /assets/service/cache      (mirror remote media into the cache ns)
 *   - POST /assets/service/federation (persist durable federated media)
 *   - POST /assets/service/user-media (persist media for a local user; MCP)
 *   - POST /assets/service/by-ids     (resolve asset metadata for a batch of ids)
 *   - POST /assets/service/by-sha256  (reverse-resolve assets by content hash)
 *   - POST /auth/mcp/oauth/introspect (live MCP resource-token validation)
 *
 * Because these share a prefix with genuine browser/user routes (`/users/*`,
 * `/assets/*`), a PURE path match — as used for the IdP worker / federation
 * paths, whose whole prefix is service-only — is unsafe here: it could exempt a
 * future sibling browser route and would leave UNauthenticated floods of the
 * path unbounded. The exemption is therefore additionally gated on the request
 * carrying a VALID service token (see {@link isServiceToServiceBulkRequest}).
 *
 * The `/api/` prefix is already stripped by the time the limiters run (the strip
 * middleware is mounted before them), so the bare forms suffice.
 */
const SERVICE_TO_SERVICE_BULK_PATHS: ReadonlySet<string> = new Set([
  '/users/resolve',
  '/assets/service/cache',
  '/assets/service/federation',
  '/assets/service/user-media',
  // The two bulk READ lookups. Omitting them was not a judgement call — they
  // were introduced after this set and never added, so a relying app's metadata
  // backfill ran under the 1000/15min browser budget and absorbed 24,423
  // consecutive 429s in one run. Both carry `assetServiceLookupLimiter`, which
  // is what the MOUNT-ORDER INVARIANT below requires of every entry here.
  '/assets/service/by-ids',
  '/assets/service/by-sha256',
  '/auth/mcp/oauth/introspect',
]);

/**
 * True when the request targets a {@link SERVICE_TO_SERVICE_BULK_PATHS} path AND
 * carries a valid `service`-type token. Used to exempt genuine internal backfill
 * traffic from the per-IP BROWSER protections (rl:general + slowDown) WITHOUT
 * weakening them for user-facing traffic or unauthenticated floods — anything
 * lacking a valid service token is NOT exempted and stays under the general
 * per-IP budget.
 *
 * MOUNT-ORDER INVARIANT: every exempt path MUST carry its own dedicated service
 * limiter at its route — `/users/resolve` → `userResolveServiceLimiter`
 * (routes/users.ts), `/assets/service/{cache,federation,user-media}` →
 * `cacheUploadLimiter`, `/assets/service/{by-ids,by-sha256}` →
 * `assetServiceLookupLimiter` (both routes/assets.ts). The path set here and
 * those route limiters must be kept in sync: an entry added here WITHOUT a route
 * limiter is not a smaller fix, it is a regression — it removes the only ceiling
 * that authenticated service traffic on that path has.
 */
export function isServiceToServiceBulkRequest(req: Request): boolean {
  const originalPath = req.originalUrl?.split('?', 1)[0];
  const requestPath = originalPath?.startsWith('/api/')
    ? originalPath.slice('/api'.length)
    : originalPath;
  if (!SERVICE_TO_SERVICE_BULK_PATHS.has(requestPath ?? req.path)) return false;
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return false;
  return verifyServiceToken(authHeader.slice('Bearer '.length)).ok;
}

// General rate limiting middleware (exclude file uploads). The previous
// ceiling of 150/15min was below what a single signed-in user generates
// against the API in normal usage (feed scrolling, profile loads, sockets'
// REST fallback, device-first token mints), which surfaced as
// misleading 429s on unrelated endpoints. The userRateLimiter below still caps
// per-account traffic. IdP worker server-to-server paths are skipped (see
// isIdpServiceToServicePath) so shared-egress traffic never exhausts this budget.
const rateLimiter = rateLimit({
  ...makeStore('rl:general:'),
  ...rateLimitValidate,
  windowMs: 15 * 60 * 1000,
  max: isProd ? 1000 : 2000,
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: hashedIpKey,
  skip: (req: Request) =>
    req.path.startsWith('/files/upload') ||
    isIdpServiceToServicePath(req.path) ||
    isFederationServiceToServicePath(req.path) ||
    isServiceToServiceBulkRequest(req),
});

// Dedicated high-ceiling limiter for the federation sign-on-behalf surface
// (see isFederationServiceToServicePath: /federation/*). Because those paths are
// skipped by rl:general, this is their SOLE per-IP budget. Mounted at the
// `/federation` router in server.ts so it also bounds unauthenticated floods
// (it runs before serviceAuthMiddleware).
//
// The ceiling is deliberately high: a relying app's outbox backfill / delivery
// fan-out signs tens of thousands of requests through ONE NAT egress IP. Sizing
// for the empirical worst case — a sustained ~25 req/s backfill (a 12k-post
// reconciliation) plus concurrent live delivery — needs well above the general
// 1000/15min: 60000/15min ≈ 66 req/s sustained is ~2.6x that peak, with room
// for live traffic, while still bounding a runaway loop or a compromised
// credential (whose signatures are already domain-scoped to its own actor).
// Unique prefix (`rl:federation:service:`) keeps this budget distinct from every
// other limiter (no ERR_ERL_DOUBLE_COUNT).
const federationServiceLimiter = rateLimit({
  ...makeStore('rl:federation:service:'),
  ...rateLimitValidate,
  windowMs: 15 * 60 * 1000,
  max: isProd ? 60000 : 120000,
  message: "Too many federation signing requests, please slow down.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: hashedIpKey,
  skip: (req: Request) => req.path.startsWith('/files/upload'),
});

// Dedicated high-ceiling limiter for the IdP worker's server-to-server READ
// calls (see isIdpServiceToServicePath: /session/validate/*). Because those
// paths are skipped by rl:general, this is their SOLE per-IP budget.
// The ceiling is deliberately high: each hit is the shared Cloudflare Worker
// egress fanning MANY users' device-first/IdP-chooser calls through one IP,
// not a single browser — yet it still bounds a runaway or compromised caller.
// Unique prefix (`rl:idp:service:`) keeps the IdP worker's server-to-server
// READ budget distinct from every other limiter (no ERR_ERL_DOUBLE_COUNT).
const idpServiceLimiter = rateLimit({
  ...makeStore('rl:idp:service:'),
  ...rateLimitValidate,
  windowMs: 15 * 60 * 1000,
  max: isProd ? 20000 : 40000,
  message: "Too many requests, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: hashedIpKey,
  skip: (req: Request) => req.path.startsWith('/files/upload'),
});

// Per-IP rate limiting for /auth/*. This guards against blanket abuse of the
// auth surface; individual sensitive endpoints (/auth/challenge, /auth/verify,
// /auth/login, /auth/lookup, /auth/refresh, ...) layer their own tighter
// limiters on top. The ceiling here must stay well above realistic per-IP
// traffic for shared NAT egress (offices, mobile carriers): a single user
// signing in hits ~5–8 /auth/* endpoints, and active sessions refresh on
// /auth/refresh roughly every 15 minutes.
const authRateLimiter = rateLimit({
  ...makeStore('rl:auth:'),
  ...rateLimitValidate,
  windowMs: 15 * 60 * 1000,
  max: isProd ? 300 : 2000,
  message: "Too many authentication attempts from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: hashedIpKey,
  skip: (req: Request) => req.path.startsWith('/files/upload'),
});

// Per-user rate limiting for authenticated requests
const userRateLimiter = rateLimit({
  ...makeStore('rl:user:'),
  ...rateLimitValidate,
  windowMs: 15 * 60 * 1000,
  max: isProd ? 200 : 2000,
  message: "Too many requests, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    return (req as AuthRequest).user?.id || hashedIpKey(req);
  },
  skip: (req: Request) => {
    return req.path.startsWith('/files/upload') || !(req as AuthRequest).user;
  },
});

// Brute force protection middleware (exclude file uploads). Also skips the IdP
// worker's server-to-server paths (see isIdpServiceToServicePath): this is a
// sibling per-IP budget mounted alongside the general limiter, and its low
// delayAfter (100/15min) would otherwise add 500ms delays to the shared worker
// egress IP — a latency-based version of the same fail-closed amplification.
const bruteForceProtection = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: isProd ? 100 : 1000,
  delayMs: () => isProd ? 500 : 100,
  keyGenerator: hashedIpKey,
  skip: (req: Request) =>
    req.path.startsWith('/files/upload') ||
    isIdpServiceToServicePath(req.path) ||
    isFederationServiceToServicePath(req.path) ||
    isServiceToServiceBulkRequest(req),
});

/**
 * Security headers middleware using Helmet
 * Implements comprehensive HTTPS security headers following OWASP recommendations
 */
const securityHeaders = helmet({
  // Strict-Transport-Security: Enforce HTTPS for 1 year including subdomains
  hsts: process.env.NODE_ENV === 'production' ? {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  } : false,

  // No Content-Security-Policy: oxy-api is JSON-only — a source-list CSP governs
  // no browsing context here. HTML origins use @oxyhq/core/server
  // buildOxyPagesHeaders / createOxySecurityHeaders instead.
  contentSecurityPolicy: false,

  // X-Frame-Options: Prevent clickjacking attacks
  frameguard: {
    action: 'deny',
  },

  // Referrer-Policy: Control referrer information
  referrerPolicy: {
    policy: 'strict-origin-when-cross-origin',
  },

  // API is consumed cross-origin by multiple frontend apps —
  // same-origin (Helmet default) blocks <img>, fetch, etc.
  crossOriginResourcePolicy: { policy: 'cross-origin' as const },

  // Not needed for API servers; can interfere with cross-origin consumers
  crossOriginOpenerPolicy: false,

  // X-Content-Type-Options: Prevent MIME type sniffing (enabled by default)
  // X-DNS-Prefetch-Control: Control browser DNS prefetching
  // X-Download-Options: Prevent IE from executing downloads in site context
  // X-Permitted-Cross-Domain-Policies: Restrict Adobe Flash and PDF
});

export { rateLimiter, idpServiceLimiter, federationServiceLimiter, authRateLimiter, userRateLimiter, bruteForceProtection, securityHeaders };
