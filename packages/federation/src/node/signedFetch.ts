/**
 * `signedFetch` — a signed ActivityPub GET with per-hop HTTP-signature
 * re-signing, built over an injected SSRF-safe single-hop transport.
 *
 * WHY A FACTORY OVER AN INJECTED TRANSPORT (not core `safeFetch` directly)
 * -----------------------------------------------------------------------
 * An HTTP signature is bound to the `(request-target)`/`host` of ONE specific
 * URL, so on a redirect the signature MUST be recomputed for the new target.
 * `@oxy.so/core/server`'s `safeFetch` follows redirects internally and re-sends
 * the ORIGINAL headers on each hop (it never re-signs, and it destroys redirect
 * bodies), so it cannot back per-hop re-signing. Instead — mirroring how
 * `@oxy.so/protocol/node` injects its `NodeFetch` adapter over `safeFetch` — this
 * factory takes a single-hop transport that validates + IP-pins ONE request and
 * returns the response WITHOUT following redirects. The engine owns the
 * federation policy (signing, the bounded redirect loop that re-signs each hop,
 * the unsigned 5xx fallback); the app supplies the SSRF transport (Mention adapts
 * its `@oxy.so/core/server`-based single-hop fetch), keeping the SSRF/DNS-pin
 * policy in ONE place.
 */

import { signRequest, type HttpSignatureSigner } from '../httpSignature';

/** Total time budget for a single signed hop (connect + response headers). */
const SIGNED_FETCH_TIMEOUT_MS = 10000;
/** Bounded redirect budget for signed AP GETs; each hop is re-validated and re-signed. */
const SIGNED_FETCH_MAX_REDIRECTS = 3;
const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Per-request options handed to the injected single-hop transport. */
export interface SingleHopFetchInit {
  /** The EXACT request headers to send (the factory assembles these). */
  headers: Record<string, string>;
  /** Aborts the in-flight request when the signal fires. */
  signal: AbortSignal;
  /** Time-to-first-byte deadline in milliseconds. */
  headersTimeoutMs?: number;
}

/**
 * An SSRF-safe single-hop fetch: it validates + IP-pins the URL and returns the
 * response WITHOUT following redirects (a 3xx is returned as-is so the caller can
 * re-sign the next hop). Mention adapts its `@oxy.so/core/server`-backed
 * `fetchUpstreamSingleHop` into this shape.
 */
export type SingleHopFetch = (url: string, init: SingleHopFetchInit) => Promise<Response>;

/** Non-fatal diagnostics sink for signed fetches. */
export interface SignedFetchLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** Adapters + config a {@link SignedFetch} is built from. */
export interface CreateSignedFetchConfig {
  /** RSA-SHA256 signer — private-key custody stays behind this (Mention: oxy-api). */
  sign: HttpSignatureSigner;
  /** Resolve the instance actor's `keyId` used to sign outbound GETs. */
  getInstanceKeyId: () => Promise<string>;
  /** SSRF-safe single-hop transport (does NOT follow redirects). */
  fetchSingleHop: SingleHopFetch;
  /** User-Agent presented to remote servers. */
  userAgent: string;
  /** Optional diagnostics sink (5xx unsigned retry, 401/403 rejection). */
  logger?: SignedFetchLogger;
}

/** A signed ActivityPub GET, returning the standard WHATWG {@link Response}. */
export type SignedFetch = (url: string, accept: string, init?: RequestInit) => Promise<Response>;

function requestInitHeaders(init: RequestInit): Record<string, string> {
  if (!init.headers) return {};
  if (init.headers instanceof Headers) {
    // `Headers.forEach` is typed on the base `DOM` lib, whereas
    // `Headers.entries()` requires `DOM.Iterable` — which this package's build
    // tsconfig deliberately omits (isomorphic node/web split). `forEach` keeps
    // the flatten build-safe under every lib config (Docker + local).
    const flattened: Record<string, string> = {};
    init.headers.forEach((value, key) => {
      flattened[key] = value;
    });
    return flattened;
  }
  if (Array.isArray(init.headers)) return Object.fromEntries(init.headers);
  return init.headers as Record<string, string>;
}

/**
 * Build a `signedFetch(url, accept, init?)`:
 *
 * Signs a GET request using the instance actor key (via the injected signer) and
 * performs it under the SSRF-safe contract (the injected single-hop transport
 * validates the URL AND pins the TCP connection to the validated IP).
 *
 * Redirects are followed manually (bounded by {@link SIGNED_FETCH_MAX_REDIRECTS}),
 * re-validating AND re-signing each hop — an HTTP signature is bound to the
 * `(request-target)`/`host` of a specific URL. When the caller passes
 * `init.redirect === 'manual'`, the redirect `Response` is returned directly so
 * the caller can apply its own stricter redirect policy.
 *
 * Signed for servers that enforce authorized fetch (e.g. Threads). On a 5xx the
 * request is retried unsigned (same SSRF-safe path) as a fallback for public
 * resources.
 */
export function createSignedFetch(config: CreateSignedFetchConfig): SignedFetch {
  return async function signedFetch(
    url: string,
    accept: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const acceptHeader = `${accept}, application/ld+json; profile="https://www.w3.org/ns/activitystreams"`;
    const keyId = await config.getInstanceKeyId();
    const extraHeaders = requestInitHeaders(init);
    const manualRedirect = init.redirect === 'manual';

    const fetchOnce = async (targetUrl: string, signed: boolean): Promise<Response> => {
      const sigHeaders = signed ? await signRequest(config.sign, keyId, 'GET', targetUrl) : {};
      return config.fetchSingleHop(targetUrl, {
        headers: {
          Accept: acceptHeader,
          'User-Agent': config.userAgent,
          ...sigHeaders,
          ...extraHeaders,
        },
        signal: init.signal ?? AbortSignal.timeout(SIGNED_FETCH_TIMEOUT_MS),
        headersTimeoutMs: SIGNED_FETCH_TIMEOUT_MS,
      });
    };

    const fetchFollowingRedirects = async (
      initialUrl: string,
      signed: boolean,
    ): Promise<{ res: Response; finalUrl: string }> => {
      let currentUrl = initialUrl;
      for (let hop = 0; hop <= SIGNED_FETCH_MAX_REDIRECTS; hop++) {
        const res = await fetchOnce(currentUrl, signed);
        if (!REDIRECT_STATUS_CODES.has(res.status)) {
          return { res, finalUrl: currentUrl };
        }
        // The caller asked to handle redirects itself (stricter per-hop policy).
        if (manualRedirect) {
          return { res, finalUrl: currentUrl };
        }
        const location = res.headers.get('location');
        if (hop === SIGNED_FETCH_MAX_REDIRECTS || !location) {
          return { res, finalUrl: currentUrl };
        }
        currentUrl = new URL(location, currentUrl).toString();
      }
      throw new Error('redirect loop exhausted');
    };

    const { res, finalUrl } = await fetchFollowingRedirects(url, true);

    // If the remote server returns a 5xx (e.g. it can't resolve our keyId to
    // verify the signature), retry without the signature as a fallback for public
    // resources. Retry from the post-redirect URL so we don't restart a chain that
    // already landed on the failing hop.
    if (res.status >= 500) {
      config.logger?.info(`[FedSync] signedFetch got ${res.status} for ${finalUrl}, retrying unsigned`);
      return fetchFollowingRedirects(finalUrl, false).then(({ res: unsignedRes }) => unsignedRes);
    }

    // A 401/403 on a signed request means the remote rejected OUR signature (e.g.
    // it could not resolve/verify our keyId, or our instance key pair is
    // missing/invalid because the service token could not be acquired). Without a
    // log this silently yields zero results — surface it so the failure mode is
    // observable in production. The caller still receives the response and decides
    // how to proceed; we do not change control flow here.
    if (res.status === 401 || res.status === 403) {
      config.logger?.warn(
        `[FedSync] signedFetch got ${res.status} ${res.statusText} for ${url} — remote rejected our HTTP signature (check instance key pair / service token); returning the failed response so no posts are imported from this source`,
      );
    }

    return res;
  };
}
