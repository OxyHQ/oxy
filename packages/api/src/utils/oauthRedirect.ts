/**
 * OAuth redirect-URI allowlist check.
 *
 * The SINGLE authority for "is this redirect_uri registered for this
 * Application" — shared by `POST /auth/oauth/authorize`, `GET /auth/oauth/consent`,
 * the OAuth-bound `POST /auth/session/create` binding, and the finalization of an
 * OAuth-bound `AuthSession`. Duplicating it per call site is how one path
 * silently drifts into accepting a prefix match, so it lives here alone.
 */

import * as crypto from 'crypto';
import { canonicalizeOAuthRedirectUri } from '../services/oauthCode.service';

/**
 * Validate a redirect URI against the Application allowlist using an exact
 * match (per OAuth2 RFC 6749 §3.1.2). Partial / prefix matching is the source
 * of countless open-redirect vulnerabilities — we never normalise away path or
 * query for the comparison. Constant-time equality keeps the comparison from
 * leaking the allowlist contents via timing.
 *
 * Origin-only https URLs are canonicalized so `https://app.example` and
 * `https://app.example/` match the same registered apex origin.
 */
export function isAllowedRedirectUri(
  app: { redirectUris?: string[] },
  redirectUri: string,
): boolean {
  const allowlist = app.redirectUris ?? [];
  if (allowlist.length === 0) return false;
  const provided = Buffer.from(canonicalizeOAuthRedirectUri(redirectUri));
  let matched = false;
  for (const allowed of allowlist) {
    const allowedBuf = Buffer.from(canonicalizeOAuthRedirectUri(allowed));
    if (allowedBuf.length === provided.length && crypto.timingSafeEqual(allowedBuf, provided)) {
      matched = true;
    }
  }
  return matched;
}
