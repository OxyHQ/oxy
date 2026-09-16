import jwt from "jsonwebtoken";
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
 * NOTE — the token-gated BULK-PATH exemption that used to live here
 * (`SERVICE_TO_SERVICE_BULK_PATHS` + `isServiceToServiceBulkRequest`) is gone,
 * subsumed by {@link isFirstPartyServiceRequest}: a valid service credential is
 * now exempt from the per-IP browser budget on EVERY path and charged to its own
 * per-credential budget instead, so an exact-path allow-list that had to be kept
 * in sync by hand (and twice was not — see the `/assets/service/by-ids` note in
 * the history) no longer decides whether real service traffic gets throttled.
 * The route-level service limiters it pointed at are unchanged and remain the
 * tighter per-surface ceilings.
 */

/**
 * Cache slot for {@link servicePrincipal}. Four limiters ask the same question of
 * the same request, and the answer is a JWT signature verification — memoised per
 * request so it is computed at most once, and on the request object rather than
 * in a module map so it cannot outlive the request or leak across them.
 */
const SERVICE_PRINCIPAL = Symbol('oxy.rateLimit.servicePrincipal');

interface RequestWithServicePrincipal extends Request {
  [SERVICE_PRINCIPAL]?: { payload: ReturnType<typeof verifyServiceToken> };
}

/**
 * The verified SERVICE principal behind this request, or `undefined` for a
 * browser, an anonymous caller, a user session, or an invalid/expired token.
 *
 * This is a rate-limiting question only: it names the credential a budget should
 * be charged to. AUTHORISATION still belongs to `serviceAuthMiddleware` at the
 * route, which verifies the same token again through the same single source of
 * truth and checks its scopes. Nothing here grants access.
 */
function servicePrincipal(req: Request): { appId: string } | undefined {
  const cached = (req as RequestWithServicePrincipal)[SERVICE_PRINCIPAL];
  if (cached) {
    return cached.payload.ok ? { appId: cached.payload.payload.appId } : undefined;
  }

  const authHeader = req.headers.authorization;
  const verification = authHeader?.startsWith('Bearer ')
    ? verifyServiceToken(authHeader.slice('Bearer '.length))
    : ({ ok: false, reason: 'invalid' } as ReturnType<typeof verifyServiceToken>);
  (req as RequestWithServicePrincipal)[SERVICE_PRINCIPAL] = { payload: verification };
  return verification.ok ? { appId: verification.payload.appId } : undefined;
}

/** Cache slot for {@link userPrincipal}; see {@link SERVICE_PRINCIPAL}. */
const USER_PRINCIPAL = Symbol('oxy.rateLimit.userPrincipal');

interface RequestWithUserPrincipal extends Request {
  [USER_PRINCIPAL]?: { userId?: string };
}

/**
 * The SESSION SUBJECT behind this request, from a locally verified access
 * token, or `undefined` for an anonymous caller, a service token, or a token
 * that does not verify.
 *
 * WHY THE LIMITER RESOLVES THIS ITSELF — the per-IP budget has no per-account
 * attribution, and a relying app's backend reads on its users' behalf from ONE
 * NAT egress IP. So thousands of signed-in readers share one 1000/15min bucket,
 * and the app's normal traffic 429s itself: measured on Mention, whose feed
 * privacy reads (which fail closed) turned those 429s into 500s for readers.
 * Keying an authenticated request by its SUBJECT is what makes the budget mean
 * "this account's traffic" wherever it enters from.
 *
 * Signature + expiry only, and NO session lookup: this decides whose budget to
 * charge, never what the caller may do. `authMiddleware` still validates the
 * session for authorisation, and a forged token verifies as nothing here, so it
 * falls back to the per-IP key rather than minting itself a fresh bucket.
 * `sessionId` is required because that is what a real Oxy access token carries
 * (`authMiddleware` rejects a token without it), so a decorative JWT cannot buy
 * its own bucket either.
 */
function userPrincipal(req: Request): string | undefined {
  const cached = (req as RequestWithUserPrincipal)[USER_PRINCIPAL];
  if (cached) return cached.userId;

  const resolve = (): string | undefined => {
    const secret = process.env.ACCESS_TOKEN_SECRET;
    const authHeader = req.headers.authorization;
    if (!secret || !authHeader?.startsWith('Bearer ')) return undefined;
    try {
      const decoded = jwt.verify(authHeader.slice('Bearer '.length), secret);
      if (typeof decoded !== 'object' || decoded === null) return undefined;
      const claims = decoded as { sessionId?: unknown; userId?: unknown; id?: unknown; _id?: unknown };
      if (typeof claims.sessionId !== 'string' || claims.sessionId.length === 0) return undefined;
      for (const candidate of [claims.userId, claims.id, claims._id]) {
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
      }
      return undefined;
    } catch {
      return undefined;
    }
  };

  const userId = resolve();
  (req as RequestWithUserPrincipal)[USER_PRINCIPAL] = { userId };
  return userId;
}

/**
 * Charge an authenticated request to its SUBJECT and everything else to its IP.
 *
 * The `usr:` prefix keeps the two key spaces apart — {@link hashedIpKey} answers
 * 24 hex characters, so no account id can ever collide with an IP bucket.
 */
function subjectOrIpKey(req: Request): string {
  const userId = userPrincipal(req);
  return userId ? `usr:${userId}` : hashedIpKey(req);
}

/**
 * A first-party SERVICE credential is infrastructure, not a browser.
 *
 * A relying app's backend fans EVERY one of its signed-in users' server-side
 * reads through ONE NAT egress IP, and every app in the cluster shares that IP.
 * Under the per-IP browser budget (`rl:general`, 1000/15min) that pool is spent
 * by normal multi-user traffic in seconds, and then EVERY app's calls start
 * failing at once — which is not a rate limit doing its job, it is one app's
 * traffic becoming another app's outage. It was measured: Mention's sitemap and
 * record-signing traffic exhausted the shared budget, and the 429s landed on its
 * feed's privacy reads, which fail closed, so readers got 500s.
 *
 * So service traffic is charged to the CREDENTIAL that made it
 * ({@link serviceCredentialLimiter}) rather than to whatever IP it left through:
 * one app's burst is bounded without touching any other app, and a per-IP pool
 * shared by unrelated services stops existing.
 *
 * MOUNT-ORDER INVARIANT: `rl:general` and `slowDown` skip these requests, so
 * `serviceCredentialLimiter` MUST stay mounted globally, immediately alongside
 * them in server.ts — it is the only ceiling this traffic has left. The
 * route-level service limiters (`federationServiceLimiter`,
 * `assetServiceLookupLimiter`, …) remain the tighter, per-surface budgets on top
 * of it; each has its own Redis prefix, so nothing double-counts.
 */
export function isFirstPartyServiceRequest(req: Request): boolean {
  return servicePrincipal(req) !== undefined;
}

/**
 * Per-CREDENTIAL budget for everything a service token does, keyed by `appId`.
 *
 * The ceiling is sized like the federation one (which fans a whole app's
 * outbound delivery through one credential): 60000/15min ≈ 66 req/s sustained
 * per app, comfortably above what a relying backend generates at present while
 * still bounding a runaway loop or a compromised credential — and now it bounds
 * it to the app that owns it, instead of to everyone sharing its egress IP.
 *
 * Keyed by `appId`, NOT by credential id: rotating a credential must not hand
 * the same application a second budget.
 */
const serviceCredentialLimiter = rateLimit({
  ...makeStore('rl:service:credential:'),
  ...rateLimitValidate,
  windowMs: 15 * 60 * 1000,
  max: isProd ? 60000 : 120000,
  message: "Too many requests for this service credential, please slow down.",
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => servicePrincipal(req)?.appId ?? hashedIpKey(req),
  skip: (req: Request) => !isFirstPartyServiceRequest(req),
});

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
  message: "Too many requests, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  // Per SUBJECT for an authenticated caller, per IP for everyone else — see
  // `userPrincipal`. A shared backend egress IP would otherwise pool every
  // signed-in reader of a relying app into ONE bucket.
  keyGenerator: subjectOrIpKey,
  skip: (req: Request) =>
    req.path.startsWith('/files/upload') ||
    isIdpServiceToServicePath(req.path) ||
    isFederationServiceToServicePath(req.path) ||
    isFirstPartyServiceRequest(req),
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

/**
 * Per-user rate limiting for authenticated requests.
 *
 * The ceiling was 200/15min — about 13 requests a minute — which describes a
 * human clicking a browser and nothing else. A RELYING APP's backend also reads
 * Oxy on the signed-in user's behalf (Mention's feed alone resolves the viewer's
 * blocked, restricted, following and follower lists per request), and those
 * reads are charged to the same account, so one reader scrolling spent the
 * budget in under a minute and the app 429'd itself. Mention's privacy reads
 * fail CLOSED, so what the reader actually saw was a 500 on every feed request.
 *
 * 2000/15min (≈2.2 req/s sustained) is above what a reader plus the app reading
 * for them generates, and still bounds one account: a compromised session or a
 * runaway client is throttled long before it is a load problem, and it is
 * throttled ALONE — this budget is per account, so it cannot become anyone
 * else's outage.
 */
const userRateLimiter = rateLimit({
  ...makeStore('rl:user:'),
  ...rateLimitValidate,
  windowMs: 15 * 60 * 1000,
  max: isProd ? 2000 : 4000,
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
  // Same key as the general limiter: an authenticated request is charged to its
  // SUBJECT. Keyed purely by IP, a relying app's shared egress crossed
  // `delayAfter` almost immediately and every signed-in reader behind it paid a
  // 500ms penalty per request — a latency-shaped version of the same pooling.
  keyGenerator: subjectOrIpKey,
  skip: (req: Request) =>
    req.path.startsWith('/files/upload') ||
    isIdpServiceToServicePath(req.path) ||
    isFederationServiceToServicePath(req.path) ||
    isFirstPartyServiceRequest(req),
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
  // no browsing context here. HTML origins use @oxy.so/core/server
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

export { rateLimiter, serviceCredentialLimiter, idpServiceLimiter, federationServiceLimiter, authRateLimiter, userRateLimiter, bruteForceProtection, securityHeaders };
