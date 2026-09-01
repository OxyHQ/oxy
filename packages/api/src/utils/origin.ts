/**
 * Canonical origin-normalisation helper shared across the CORS/CSRF origin
 * guard, the dynamic origin registry, and the auth surface (`auth.ts`).
 *
 * Normalises an origin string for equality / allow-list comparisons:
 *  - lowercases the scheme and the host;
 *  - preserves an explicit port (e.g. `:3000`), drops an implicit/default one;
 *  - drops any path, query, fragment, userinfo and trailing slash — only the
 *    `scheme://host[:port]` triple is reconstructed.
 *
 * Fails closed: returns `null` (never throws) when `value` is not a parseable
 * absolute origin (empty string, relative path, or otherwise invalid URL). The
 * caller decides how to treat the `null` — reject, skip, or substitute.
 *
 * @example
 *   normaliseOrigin('HTTPS://Example.com/path?q=1') // 'https://example.com'
 *   normaliseOrigin('https://example.com:3000/')     // 'https://example.com:3000'
 *   normaliseOrigin('not a url')                      // null
 */
export function normaliseOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    const port = url.port ? `:${url.port}` : '';
    return `${url.protocol.toLowerCase()}//${url.hostname.toLowerCase()}${port}`;
  } catch {
    return null;
  }
}

/**
 * Loopback (local development) origin predicate. Matches `http://localhost`,
 * `http://127.0.0.1`, and `http://[::1]` with an OPTIONAL `:<port>` (any 1–5
 * digit port). HTTP only — loopback dev servers are served over http, so an
 * `https://localhost` origin is deliberately NOT a loopback match.
 *
 * The input is normalised first (via {@link normaliseOrigin}), so scheme/host
 * casing and trailing paths/queries never defeat the check, and only the
 * `scheme://host[:port]` triple is tested. Fails closed: returns `false` for any
 * unparseable input.
 *
 * @example
 *   isLoopbackOrigin('http://localhost:8081')  // true
 *   isLoopbackOrigin('http://127.0.0.1')       // true
 *   isLoopbackOrigin('http://[::1]:19006')     // true
 *   isLoopbackOrigin('https://localhost:8081') // false (https)
 *   isLoopbackOrigin('http://localhost.evil.com') // false
 */
const LOOPBACK_ORIGIN_PATTERN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

export function isLoopbackOrigin(origin: string): boolean {
  const normalised = normaliseOrigin(origin);
  if (normalised === null) {
    return false;
  }
  return LOOPBACK_ORIGIN_PATTERN.test(normalised);
}

/**
 * True when `origin` belongs to the Oxy apex ecosystem — the `oxy.so` registrable
 * domain (`oxy.so` itself or any `*.oxy.so` subdomain over any scheme/port) OR a
 * loopback dev origin (see {@link isLoopbackOrigin}). This is the WebAuthn
 * `expectedOrigin` allow-set: a passkey minted with `WEBAUTHN_RP_ID=oxy.so` may be
 * used from any first-party Oxy web origin, and a `localhost` dev server may
 * exercise the ceremony locally. Fails closed: any unparseable origin, or a host
 * merely ending in the literal `oxy.so` without the dot boundary
 * (`notoxy.so`, `evil-oxy.so`), returns `false`.
 *
 * @example
 *   isOxyApexOrigin('https://accounts.oxy.so') // true
 *   isOxyApexOrigin('https://oxy.so')          // true
 *   isOxyApexOrigin('http://localhost:8081')   // true
 *   isOxyApexOrigin('https://evil-oxy.so')     // false
 *   isOxyApexOrigin('https://oxy.so.evil.com') // false
 */
/**
 * True when the request carries browser context signals (`Origin` or
 * `Sec-Fetch-Site`). Native HTTP clients (OkHttp, URLSession, curl) send
 * neither; credentialed `fetch` in a browser always sends at least one.
 *
 * Used to refuse endpoints that must be native-only (e.g. background-credential
 * provisioning) without relying on client-side platform gates alone.
 */
export function isBrowserClient(
  headers: { origin?: string | string[]; 'sec-fetch-site'?: string | string[] },
): boolean {
  const origin = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
  if (origin !== undefined) {
    return true;
  }
  const secFetchSite = Array.isArray(headers['sec-fetch-site'])
    ? headers['sec-fetch-site'][0]
    : headers['sec-fetch-site'];
  return secFetchSite !== undefined;
}

export function isOxyApexOrigin(origin: string): boolean {
  if (isLoopbackOrigin(origin)) {
    return true;
  }
  const normalised = normaliseOrigin(origin);
  if (normalised === null) {
    return false;
  }
  let hostname: string;
  try {
    hostname = new URL(normalised).hostname.toLowerCase();
  } catch {
    return false;
  }
  return hostname === 'oxy.so' || hostname.endsWith('.oxy.so');
}
