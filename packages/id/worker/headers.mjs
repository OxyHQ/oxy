/**
 * The response headers every id.oxy.so response carries.
 *
 * This origin unseals identities, so its policy is the narrowest that runs the
 * app: only first-party scripts and styles, network access to itself and the
 * Oxy API alone, never framed, no plugins, no forms posting anywhere. Written in
 * the Worker (not a generated `_headers` file) so the policy is code, reviewed
 * and unit-tested, and cannot silently drift from a build step.
 *
 * NO `Cross-Origin-Opener-Policy`: apps open this origin as a popup and watch
 * `popup.closed` to learn the user gave up. `same-origin` would sever that
 * relationship and every popup would read as closed the instant it opened.
 */

/** @param {{ apiOrigin: string }} config */
export function identityOriginHeaders({ apiOrigin }) {
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${apiOrigin}`,
    "manifest-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
  return {
    'Content-Security-Policy': csp,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'Permissions-Policy':
      'publickey-credentials-get=(self), publickey-credentials-create=(self), camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

/**
 * Validate the configured API origin: https (or loopback http for local
 * preview), origin only — a path, credentials or a wildcard would widen
 * `connect-src` beyond the one API it names.
 *
 * @param {string | undefined} value
 */
export function resolveApiOrigin(value) {
  const raw = (value ?? 'https://api.oxy.so').trim();
  const url = new URL(raw);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`OXY_API_ORIGIN must be a bare https origin, got ${raw}`);
  }
  return url.origin;
}

/**
 * Copy an asset response with the identity-origin headers applied.
 *
 * `no-transform` on every response stops the zone's Web Analytics from
 * injecting the Cloudflare Insights beacon into the page: the CSP would block
 * it anyway, and this origin runs no third-party script (ADR 0024 D1). It is
 * appended to the asset's own `Cache-Control`, so caching is unchanged.
 *
 * @param {Response} response
 * @param {Record<string, string>} headers
 */
export function withIdentityHeaders(response, headers) {
  const next = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) next.headers.set(name, value);
  const cacheControl = next.headers.get('cache-control');
  if (!cacheControl?.includes('no-transform')) {
    next.headers.set('cache-control', cacheControl ? `${cacheControl}, no-transform` : 'no-transform');
  }
  return next;
}
