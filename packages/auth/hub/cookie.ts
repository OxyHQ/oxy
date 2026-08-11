/**
 * The `__Host-oxy-device` cookie — read, write, clear.
 *
 * This module is the ONLY place in the repository that renders a `Set-Cookie`
 * line, and the only place that reads one. Issue #937 Phase 5, ADR 0003.
 *
 * ## The attribute set, and why each one
 *
 *  - `__Host-` prefix (in the NAME, from `@oxyhq/contracts`) — a browser refuses
 *    to store the cookie at all if it carries `Domain`, if `Path` is not `/`, or
 *    if `Secure` is missing. So "bound to `auth.oxy.so` alone; no other `oxy.so`
 *    host can read or overwrite it" is enforced by the client, not merely
 *    intended by us. That is the entire alternative-rejected argument against
 *    `Domain=.oxy.so`: a delegated subdomain could otherwise read or forge the
 *    browser's device handle.
 *  - `Secure` — never sent over plaintext, and required by the prefix.
 *  - `HttpOnly` — no script on the IdP origin can read the handle, so an XSS on
 *    `auth.oxy.so` cannot exfiltrate the browser's device credential.
 *  - `SameSite=Lax` — never attached to a cross-site subrequest. Every flow that
 *    depends on this cookie is a top-level visit or a user-opened popup, so it
 *    is never needed in a third-party context, and `Lax` is what makes that
 *    structural rather than a convention.
 *  - `Path=/` — required by the prefix.
 *
 * ## `Max-Age` is here and is NOT in `BROWSER_HUB_COOKIE_ATTRIBUTES`
 *
 * The constant holds the SECURITY attributes, which are unconditional and are
 * what a test should pin. `Max-Age` is a lifetime, derived from the same
 * `BROWSER_HUB_HANDLE_TTL_MS` the server writes into `hub_secret_expires_at`, so
 * the cookie and the credential it addresses expire together.
 *
 * It is present at all because a hub handle cannot be a SESSION cookie. The
 * thing it identifies is the browser PROFILE's device session; one that
 * evaporated when the user quit their browser would send them back to a QR scan
 * every morning, which is the exact failure ADR 0003 exists to remove.
 */

import {
  BROWSER_HUB_COOKIE_ATTRIBUTES,
  BROWSER_HUB_COOKIE_NAME,
  BROWSER_HUB_HANDLE_TTL_MS,
} from '@oxyhq/contracts';

/**
 * The characters a hub handle may contain — base64url, which is exactly what
 * the API's issuer emits.
 *
 * Checked before rendering rather than trusted, because a `Set-Cookie` value
 * containing `;` or a newline is not a malformed cookie, it is a second
 * attribute or a second header. This can only fire if the API starts emitting
 * something else, which is why it throws instead of degrading: a handle that
 * cannot be written safely must not be written at all.
 */
const HANDLE_CHARSET = /^[A-Za-z0-9_-]+$/;

/** The handle in this request's `Cookie` header, or null. */
export function readHubHandle(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== BROWSER_HUB_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/** The `Set-Cookie` line that stores a freshly issued handle. */
export function hubCookieHeader(handle: string): string {
  if (!HANDLE_CHARSET.test(handle)) {
    throw new Error('hub handle is not cookie-safe');
  }
  const maxAge = Math.floor(BROWSER_HUB_HANDLE_TTL_MS / 1000);
  return [
    `${BROWSER_HUB_COOKIE_NAME}=${handle}`,
    ...BROWSER_HUB_COOKIE_ATTRIBUTES,
    `Max-Age=${maxAge}`,
  ].join('; ');
}

/**
 * The `Set-Cookie` line that removes the cookie.
 *
 * Carries the SAME attribute set as the write. A browser matches a deletion on
 * name/domain/path, and a `__Host-` cookie cleared without `Secure` and `Path=/`
 * is simply rejected — leaving the live cookie in place while the response looks
 * like it worked.
 */
export function clearedHubCookieHeader(): string {
  return [`${BROWSER_HUB_COOKIE_NAME}=`, ...BROWSER_HUB_COOKIE_ATTRIBUTES, 'Max-Age=0'].join('; ');
}
