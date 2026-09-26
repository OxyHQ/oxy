/**
 * Who may call the routes that sign people in, create accounts and change how
 * an account signs in: official Oxy apps and auth.oxy.so.
 *
 * - A browser request carries `Origin`. It must be an official application's
 *   origin (`isAllowedOrigin`: the trusted snapshot of
 *   `isTrustedApplication` apps' registered redirect URIs, loopback, and the
 *   emergency `OXY_EXTRA_ALLOWED_ORIGINS`) or auth.oxy.so itself. A third-party
 *   site — which signs people in through OAuth on auth.oxy.so — is refused, so
 *   its page can never run Oxy's sign-in on its own origin.
 * - A request with no `Origin` but a `Sec-Fetch-Site` that is not same-origin
 *   or same-site is a cross-site browser context and is refused too.
 * - A request with neither is not a browser (an official native app): there is
 *   no page to protect, and native apps cannot be told apart from any other
 *   HTTP client by a header, so they are admitted, as `requireSameSiteOrigin`
 *   admits them. The routes' own proofs (codes, secrets, device credentials)
 *   are what protect them.
 *
 * Unlike `requireSameSiteOrigin` this guard has no log-only mode: it always
 * enforces.
 */
import type { NextFunction, Request, Response } from 'express';
import { SIGN_IN_ERROR_CODES } from '@oxy.so/contracts';
import { isAllowedOrigin } from '../config/allowedOrigins';
import { ApiError } from '../utils/error';
import { isAuthWebOrigin } from '../utils/origin';

const SAME_SITE_FETCH = new Set(['same-origin', 'same-site']);

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function refuse(next: NextFunction): void {
  next(new ApiError(403, 'Only official Oxy apps can do this here.', SIGN_IN_ERROR_CODES.originNotAllowed));
}

/** Official Oxy apps, auth.oxy.so, and non-browser (native) clients. */
export function requireOfficialOrigin(req: Request, _res: Response, next: NextFunction): void {
  const origin = header(req.headers.origin);
  if (origin !== undefined) {
    if (isAuthWebOrigin(origin) || isAllowedOrigin(origin)) {
      next();
      return;
    }
    refuse(next);
    return;
  }
  const fetchSite = header(req.headers['sec-fetch-site']);
  if (fetchSite !== undefined && !SAME_SITE_FETCH.has(fetchSite)) {
    refuse(next);
    return;
  }
  next();
}

/** auth.oxy.so (and loopback) only — a browser `Origin` is required. */
export function requireAuthWebOrigin(req: Request, _res: Response, next: NextFunction): void {
  const origin = header(req.headers.origin);
  if (origin === undefined || !isAuthWebOrigin(origin)) {
    refuse(next);
    return;
  }
  next();
}
