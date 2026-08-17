/**
 * CORS (Cross-Origin Resource Sharing) Configuration
 *
 * Two-lane Origin policy derived from the Application registry
 * (`./dynamicOriginRegistry`):
 *  - TRUSTED origins (first-party / internal / system / official apps, the
 *    bootstrap-core seed, and `OXY_EXTRA_ALLOWED_ORIGINS`) get the credentialed
 *    lane: `Access-Control-Allow-Origin: <origin>` + `Access-Control-Allow-
 *    Credentials: true`. The origin is ALWAYS echoed back, NEVER `*`, because
 *    the response carries credentials.
 *  - THIRD-PARTY active apps get a NON-credentialed lane: an
 *    `Access-Control-Allow-Origin: <origin>` echo WITHOUT credentials — exactly
 *    what a public PKCE/bearer client needs, and it never drags `oxy.so`
 *    cookies. This lane never widens the credentialed/CSRF boundary.
 *  - Unknown origins get no ACAO header at all, so the browser fails the
 *    preflight/response check.
 *
 * Socket.IO stays TRUSTED-only via `isAllowedOrigin` (it always uses
 * credentials). The registry is the single source of truth, shared with the
 * Origin guard middleware via `./allowedOrigins`.
 */

import type { Request, Response, NextFunction } from 'express';
import { isAllowedOrigin } from './allowedOrigins';
import { getCorsDecision } from './dynamicOriginRegistry';

/**
 * Standard HTTP methods allowed for CORS
 */
export const ALLOWED_METHODS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'OPTIONS',
] as const;

/**
 * Headers that clients are allowed to send
 */
export const ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-CSRF-Token',
  'X-Requested-With',
  'Accept',
  'Accept-Version',
  'Content-Length',
  'Content-MD5',
  'Date',
  'X-Api-Version',
  'X-File-Name',
  'Range',
  'X-Session-Id',
  'x-session-id',
  'X-Device-Fingerprint',
  'x-device-fingerprint',
  'X-Native-App',
  // The inference edge reads `Idempotency-Key` on every invoke and dedupes on
  // it. Absent from this list, a browser cannot SEND it at all — the preflight
  // rejects the header — so no browser client could use idempotency support the
  // edge already implements. Sending it is safe by construction: it is the
  // caller's own correlation string, bounded server-side.
  'Idempotency-Key',
] as const;

/**
 * Headers that browsers are allowed to access from responses.
 *
 * The `X-Oxy-*` block is the inference edge's documented integration surface,
 * and it is not decoration: the OpenAI-compat body at `/v1/chat/completions` is
 * deliberately stock, so on THAT surface the request id, the resolved model
 * revision, the serving provider, the routing policy and the metered units exist
 * ONLY in these headers. Without them here, `Access-Control-Expose-Headers`
 * omits them and `res.headers.get('X-Oxy-Request-Id')` returns `null` in every
 * browser — silently, with no error and nothing in a network log to explain it.
 * That makes an unreportable request id the default for every browser customer.
 */
export const EXPOSED_HEADERS = [
  'Content-Type',
  'Content-Length',
  'Content-Range',
  'Content-Disposition',
  'Accept-Ranges',
  'Last-Modified',
  'ETag',
  'Cache-Control',
  'X-CSRF-Token',
  // The inference edge (`utils/inferenceEdgeErrors.ts`, `routes/inferenceEdge.ts`).
  'X-Oxy-Request-Id',
  'X-Oxy-Inference-Contract-Version',
  'X-Oxy-Model',
  'X-Oxy-Provider',
  'X-Oxy-Routing-Policy',
  'X-Oxy-Routing-Policy-Version',
  // Four token headers, not two: the contract's units PARTITION a request, so
  // the cached-input and reasoning counts are what make the charge add up.
  'X-Oxy-Usage-Input-Tokens',
  'X-Oxy-Usage-Cached-Input-Tokens',
  'X-Oxy-Usage-Output-Tokens',
  'X-Oxy-Usage-Reasoning-Tokens',
  // The compat surface's error idiom: a stock OpenAI client sees only
  // `{ error: { … } }`, so retryability rides here (ADR 0010).
  'X-Oxy-Error-Code',
  'X-Oxy-Error-Retryable',
  'X-Oxy-Finish-Reason',
] as const;

/**
 * Cache control for OPTIONS preflight requests (24 hours)
 */
export const PREFLIGHT_MAX_AGE = 86400;

/**
 * CORS middleware factory.
 *
 * Echoes the request origin in `Access-Control-Allow-Origin` when the registry
 * allows it, and additionally sends `Access-Control-Allow-Credentials: true`
 * ONLY for TRUSTED origins. Third-party origins get the ACAO echo without
 * credentials; unknown origins get no ACAO header at all (the preflight fails;
 * the browser will not deliver the cross-origin response). `Vary: Origin` is
 * always set so caches never serve one origin's headers to another.
 */
export function createCorsMiddleware() {
  const allowedMethodsStr = ALLOWED_METHODS.join(', ');
  const allowedHeadersStr = ALLOWED_HEADERS.join(', ');
  const exposedHeadersStr = EXPOSED_HEADERS.join(', ');

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;

    let originAllowed = false;
    if (origin) {
      const decision = getCorsDecision(origin);
      if (decision.allow) {
        originAllowed = true;
        res.setHeader('Access-Control-Allow-Origin', origin);
        if (decision.credentials) {
          res.setHeader('Access-Control-Allow-Credentials', 'true');
        }
      }
    }

    res.setHeader('Access-Control-Allow-Methods', allowedMethodsStr);
    res.setHeader('Access-Control-Allow-Headers', allowedHeadersStr);
    res.setHeader('Access-Control-Expose-Headers', exposedHeadersStr);
    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
      // A preflight is a per-Origin, security-sensitive response and must NEVER be
      // stored by a shared/HTTP cache. Previously we sent `Cache-Control: public,
      // max-age=86400` unconditionally — so a preflight that resolved to NO
      // `Access-Control-Allow-Origin` (e.g. during a deploy/restart window before
      // the origin registry seeded) was cached `public` for a day and re-served to
      // every later request, breaking CORS long after the server recovered. Use the
      // browser's dedicated per-origin preflight cache (`Access-Control-Max-Age`),
      // and ONLY when the origin was actually allowed (ACAO present).
      res.setHeader('Cache-Control', 'no-store');
      if (originAllowed) {
        res.setHeader('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE));
      }
      res.status(204).end();
      return;
    }

    next();
  };
}

/**
 * Socket.IO CORS configuration — same strict allowlist as the HTTP layer.
 */
export const SOCKET_IO_CORS_CONFIG = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ): void => {
    if (!origin || isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  methods: ['GET', 'POST'],
  credentials: true,
};
