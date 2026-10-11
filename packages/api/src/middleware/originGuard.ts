/**
 * Origin Guard Middleware (MED-1 CSRF hardening, Phase A)
 *
 * Browser-enforced CSRF defence for state-changing auth endpoints
 * (`/auth/recover/reset` and the bearer-gated `/session/device/*` routes).
 * Browsers attach the `Origin` header automatically on cross-origin (and all
 * non-GET) requests and it cannot be forged from a page, so requiring an
 * allowlisted Origin blocks cross-site requests.
 *
 * Decision table for non-safe methods (POST/PUT/PATCH/DELETE):
 *  - `Origin` present + allowlisted                       → allow
 *  - `Origin` present + NOT allowlisted                   → 403 BAD_ORIGIN
 *  - `Origin` absent + `Sec-Fetch-Site: same-origin|same-site` → allow
 *  - `Origin` absent + `Sec-Fetch-Site: cross-site|none`  → 403 BAD_ORIGIN
 *  - Neither header present (curl / legacy HTTP clients)  → allow
 *    (no browser context to attack from; SameSite=Lax already withholds the
 *    cookie on cross-site requests)
 *
 * Rollout flag: `ORIGIN_GUARD_MODE=log-only` logs rejections without
 * blocking (24 h gradual deploy); default is `enforce`.
 */

import type { Request, Response, NextFunction } from 'express';
import { isAllowedOrigin } from '../config/allowedOrigins';
import { logger } from '../utils/logger';

export { isAllowedOrigin } from '../config/allowedOrigins';

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

const ALLOWED_SEC_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'same-site']);

type GuardVerdict =
  | { allowed: true }
  | { allowed: false; reason: 'origin_not_allowlisted' | 'sec_fetch_site_cross_site' };

function evaluateRequest(
  origin: string | undefined,
  secFetchSite: string | undefined,
): GuardVerdict {
  if (origin !== undefined) {
    return isAllowedOrigin(origin)
      ? { allowed: true }
      : { allowed: false, reason: 'origin_not_allowlisted' };
  }

  if (secFetchSite !== undefined) {
    return ALLOWED_SEC_FETCH_SITES.has(secFetchSite)
      ? { allowed: true }
      : { allowed: false, reason: 'sec_fetch_site_cross_site' };
  }

  return { allowed: true };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/**
 * Express middleware: reject state-changing requests whose Origin (or
 * Sec-Fetch-Site fallback) indicates a cross-site browser context.
 */
export function requireSameSiteOrigin(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  const origin = headerValue(req.headers.origin);
  const secFetchSite = headerValue(req.headers['sec-fetch-site']);
  const verdict = evaluateRequest(origin, secFetchSite);

  if (verdict.allowed) {
    next();
    return;
  }

  logger.warn('csrf.origin.reject', {
    origin: origin ?? null,
    secFetchSite: secFetchSite ?? null,
    path: req.path,
    method: req.method,
    reason: verdict.reason,
    mode: process.env.ORIGIN_GUARD_MODE === 'log-only' ? 'log-only' : 'enforce',
  });

  if (process.env.ORIGIN_GUARD_MODE === 'log-only') {
    next();
    return;
  }

  res.status(403).json({
    error: {
      code: 'BAD_ORIGIN',
      message: 'Request origin is not allowed for this endpoint',
    },
  });
}
