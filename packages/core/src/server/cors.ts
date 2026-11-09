/**
 * Strict CORS allowlist for Oxy backends.
 *
 * WHY THIS EXISTS
 * ---------------
 * App backends kept hand-rolling CORS, and the unsafe patterns recurred:
 *   - `Access-Control-Allow-Origin: *` together with credentials (which is
 *     spec-invalid AND a credential-leak vector), or
 *   - a "reflect whatever Origin the request carried" fallback (effectively
 *     `*` for credentialed requests — the Allo wildcard-fallback class).
 *
 * `createOxyCors` returns a self-contained Express middleware (no `cors`
 * package dependency) that:
 *   - allows the Oxy apex origin family over HTTPS only: the apex plus
 *     one-label subdomains such as `auth.oxy.so`, `api.oxy.so`,
 *     `accounts.oxy.so`, `console.oxy.so`, and `inbox.oxy.so`,
 *   - allows the caller's explicit `appOrigins`,
 *   - REFUSES the opaque origin on both sides (see `OPAQUE_ORIGIN`),
 *   - DENIES everything else (no reflection, never a wildcard with credentials),
 *   - echoes back the EXACT matched origin (so credentialed requests work) and
 *     sets `Vary: Origin` for correct caching,
 *   - answers CORS preflight (`OPTIONS`) with `204`.
 *
 * Node/Express-only: exported solely from `@oxy.so/core/server`.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createLogger } from '../logger';
import { CENTRAL_IDP_APEX } from '../utils/authWebUrl';

const log = createLogger('OxyCors');

/** Default HTTP methods allowed across origins. */
const DEFAULT_ALLOWED_METHODS = ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'];

/** Default request headers a browser may send on a credentialed cross-origin call. */
const DEFAULT_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Requested-With',
  'X-Oxy-User-Id',
  'X-Oxy-Internal',
  'X-Oxy-Edge-Region',
  'X-Oxy-Activity-Id',
];

/** How long (seconds) a browser may cache a successful preflight. */
const DEFAULT_MAX_AGE_SECONDS = 86_400;

const OXY_ONE_LABEL_SUBDOMAIN_PATTERN = new RegExp(
  `^[a-z0-9-]+\\.${CENTRAL_IDP_APEX.replace('.', '\\.')}$`,
);

export interface OxyCorsOptions {
  /**
   * Explicit additional allowed origins (exact-origin match, e.g.
   * `https://app.example.com`, `http://localhost:3000`). These are allowed IN
   * ADDITION TO the built-in HTTPS Oxy apex origin family. Each is normalized
   * via `new URL().origin`.
   *
   * An entry that is not a URL, or whose origin is the opaque origin
   * (`exp://…`, `capacitor://…`, `chrome-extension://…`, `file:`, `data:`), is
   * DROPPED with an error log rather than admitted — see `OPAQUE_ORIGIN` for
   * why one such entry would otherwise admit every other one.
   */
  appOrigins?: string[];
  /**
   * Whether to emit `Access-Control-Allow-Credentials: true`. Default `true`
   * (the Oxy ecosystem uses cookie/bearer credentials). Even when `true`, the
   * helper NEVER emits a wildcard origin — only an exact matched origin.
   */
  allowCredentials?: boolean;
  /** HTTP methods to allow. Defaults to the full standard set. */
  methods?: string[];
  /** Request headers to allow. Defaults to the common Oxy set. */
  allowedHeaders?: string[];
  /** Response headers to expose to the browser. Defaults to none. */
  exposedHeaders?: string[];
  /** Preflight cache lifetime in seconds. Default 86400 (24h). */
  maxAgeSeconds?: number;
}

/**
 * Whether `candidate` belongs to the built-in Oxy apex origin family. This
 * intentionally mirrors the API allowlist shape: HTTPS only, no custom port,
 * the apex itself (`https://oxy.so`), or exactly one lowercase subdomain label
 * (`https://auth.oxy.so`, `https://api.oxy.so`, …).
 *
 * Arbitrary/multi-level subdomains and `http://*.oxy.so` are not implicitly
 * trusted for credentialed CORS. If a service needs a non-standard development
 * or tenant origin, it must opt in explicitly via `appOrigins`.
 */
function isOxyFamilyOrigin(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.port !== '') return false;

    const hostname = url.hostname;
    if (hostname === CENTRAL_IDP_APEX) return true;

    return OXY_ONE_LABEL_SUBDOMAIN_PATTERN.test(hostname);
  } catch {
    return false;
  }
}

/**
 * The URL standard's serialization of an OPAQUE origin: the literal string
 * `"null"`, which `new URL(x).origin` returns for every scheme that has no
 * origin to speak of — `exp:`, `capacitor:`, `chrome-extension:`,
 * `vscode-webview:`, and also `file:`, `data:` and `about:`.
 *
 * This value is why an allowlist may never store it. Every such scheme
 * normalizes to the SAME `"null"`, so a set built by normalization cannot tell
 * them apart: ONE opaque entry admits ALL of them. With credentials on and the
 * raw header echoed back, a single `myapp://` in `appOrigins` turned this
 * helper into "allow any custom-scheme browsing context" — measured live, an
 * `exp://localhost:8150` entry answered `Origin: vscode-webview://…` with
 * `access-control-allow-origin: vscode-webview://…` and
 * `access-control-allow-credentials: true`.
 *
 * There is deliberately no escape hatch that matches such an origin by raw
 * string instead. Admitting a custom-scheme browsing context to a CREDENTIALED
 * allowlist is a distinct decision with its own threat model, and it must not
 * arrive as a side effect of someone adding one line to `appOrigins`. Note
 * also that a native client is not subject to CORS at all, so a mobile app
 * never needs an entry here: React Native's `fetch` sends no `Origin`, and its
 * WebSocket (like iOS's SocketRocket and OxyOS) sends the URL's own origin,
 * which `createOxySocketCors` admits as same-origin.
 */
const OPAQUE_ORIGIN = 'null';

/** Normalize a raw origin string to its canonical `scheme://host[:port]` form. */
function normalizeOrigin(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/**
 * Normalize the configured `appOrigins` into the exact-match set — the
 * CONFIGURE-SIDE half of the opaque-origin guard.
 *
 * An entry that is not a URL, or whose origin is opaque, is dropped and named
 * in an error log. Dropped rather than thrown on because `appOrigins` is
 * deployment configuration — at least one Oxy backend reads it from the
 * environment — and a typo there must cost that one origin its CORS headers,
 * never the whole service its boot. Both failure modes are equally SAFE (the
 * entry is absent from the set either way), so the choice is purely about
 * blast radius, and dropping keeps it to one origin whose requests then fail
 * visibly in the browser.
 *
 * Exported for `__tests__/cors.socket.test.ts` and NOT re-exported from
 * `server/index.ts`, so it is not part of the package's public surface. The
 * two halves of the guard are separately exported because they are separately
 * testable only that way: with this half in place the match-side half is
 * unreachable through `createOxyCors`, so a test driving the public API alone
 * would measure this function twice and the other one never.
 */
export function normalizeAppOrigins(appOrigins: string[]): Set<string> {
  const explicit = new Set<string>();
  for (const raw of appOrigins) {
    const normalized = normalizeOrigin(raw);
    if (normalized === null) {
      log.error('CORS allowlist entry ignored: it is not a URL', undefined, { entry: raw });
      continue;
    }
    if (normalized === OPAQUE_ORIGIN) {
      log.error('CORS allowlist entry ignored: it has no origin to match against', undefined, {
        entry: raw,
      });
      continue;
    }
    explicit.add(normalized);
  }
  return explicit;
}

/**
 * Whether `origin` may be echoed back: it is in the built-in HTTPS Oxy apex
 * family, or it exactly matches one of the configured app origins.
 *
 * The opaque-origin refusal here is the MATCH-SIDE half of the guard, and it
 * is what makes the property hold regardless of how `explicit` was built — a
 * set that somehow contains `"null"` still matches nothing, because no
 * incoming origin ever normalizes past this line. `normalizeAppOrigins` is
 * what stops such a set existing today; this is what stops it mattering.
 *
 * Exported for the same reason as `normalizeAppOrigins`, and likewise absent
 * from `server/index.ts`.
 */
export function matchesAllowedOrigin(explicit: ReadonlySet<string>, origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  if (normalized === null) return false;
  if (normalized === OPAQUE_ORIGIN) return false;
  if (explicit.has(normalized)) return true;
  return isOxyFamilyOrigin(normalized);
}

/**
 * The origin predicate `createOxyCors` applies, for any other transport that
 * must admit the same browsers: the built-in HTTPS Oxy apex family plus the
 * exact `appOrigins`, never an opaque origin (`exp://`, `file:`, …).
 *
 * ```ts
 * const allowed = createOxyOriginCheck(['https://app.example.com']);
 * allowed('https://mention.oxy.so'); // true
 * ```
 */
export function createOxyOriginCheck(appOrigins: string[] = []): (origin: string) => boolean {
  const explicit = normalizeAppOrigins(appOrigins);
  return (origin: string) => matchesAllowedOrigin(explicit, origin);
}

/** Options of {@link createOxySocketCors}. */
export interface OxySocketCorsOptions {
  /** Explicit additional allowed origins, as {@link OxyCorsOptions.appOrigins}. */
  appOrigins?: string[];
  /** Whether the polling transport sends `Access-Control-Allow-Credentials: true`. Default `true`. */
  allowCredentials?: boolean;
}

/**
 * The part of a Socket.IO handshake request (`http.IncomingMessage`) that
 * `allowRequest` reads. `socket` is `unknown` because only a TLS socket has
 * `encrypted`, and a plain `net.Socket` must still be assignable here.
 */
export interface OxySocketHandshakeRequest {
  headers: Record<string, string | string[] | undefined>;
  socket?: unknown;
}

/** A `Host` header that is an authority and nothing else: no userinfo, path, query or fragment. */
const HOST_HEADER_PATTERN = /^[^\s/?#@\\]+$/;

/**
 * The scheme the client used to reach this server: the first
 * `X-Forwarded-Proto` value when a proxy in front says (it saw the client's
 * connection; the connection here is the proxy's), else `https` when this
 * connection is TLS, else `http`. A forwarded value other than `http` or
 * `https` names no scheme an origin can have, so the answer is "unknown".
 */
function requestScheme(req: OxySocketHandshakeRequest): 'http' | 'https' | null {
  const forwarded = req.headers['x-forwarded-proto'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (raw !== undefined) {
    const first = raw.split(',')[0]?.trim().toLowerCase();
    return first === 'https' || first === 'http' ? first : null;
  }
  const socket = req.socket;
  const encrypted =
    typeof socket === 'object' && socket !== null && 'encrypted' in socket
      ? socket.encrypted === true
      : false;
  return encrypted ? 'https' : 'http';
}

/**
 * The server's own origin as this request addressed it: the scheme from
 * {@link requestScheme} and the `Host` header, normalized like any origin (so
 * `api.example.com:443` over https is `https://api.example.com`, and a
 * non-default port stays part of it). `null` when the request does not say:
 * no `Host`, a `Host` that is more than an authority, or an unknown scheme.
 */
function requestOwnOrigin(req: OxySocketHandshakeRequest): string | null {
  const host = req.headers.host;
  if (typeof host !== 'string' || !HOST_HEADER_PATTERN.test(host)) return null;
  const scheme = requestScheme(req);
  if (scheme === null) return null;
  const origin = normalizeOrigin(`${scheme}://${host}`);
  return origin === OPAQUE_ORIGIN ? null : origin;
}

/**
 * Whether a handshake carrying `origin` comes from the server's own origin.
 * That is not a cross-origin request, so there is nothing for an allowlist to
 * decide: a browser page served by this very origin may open a socket to it,
 * and a native WebSocket client sends exactly this (see below).
 *
 * The comparison cannot be forged by a hostile page. A browser sets `Origin`
 * to the page's origin and `Host` to the socket URL's host, and a script can
 * set neither, nor `X-Forwarded-Proto`; for the two to match, the page must
 * already be this origin. A non-browser client can send any headers it likes,
 * and was never what `allowRequest` keeps out. The scheme is part of the
 * match, so an `http://` page of the same host does not open the `https://`
 * server's socket, and so is the port.
 *
 * It assumes a proxy in front passes the client's `Host` through (Cloudflare
 * and AWS load balancers do). One that rewrites it to an internal name only
 * stops the match, which leaves the origin to the allowlist as before.
 */
function isSameOriginHandshake(req: OxySocketHandshakeRequest, origin: string): boolean {
  const normalized = normalizeOrigin(origin);
  if (normalized === null || normalized === OPAQUE_ORIGIN) return false;
  return normalized === requestOwnOrigin(req);
}

/**
 * The Socket.IO server options that admit exactly the origins `createOxyCors`
 * admits — spread them into `new Server(httpServer, { ...createOxySocketCors(…) })`.
 *
 * Two halves, because Socket.IO has two transports: `cors` answers the
 * long-polling requests (which browsers check), and `allowRequest` refuses a
 * handshake from any other browser origin, which is the only check a WebSocket
 * upgrade gets — browsers apply no CORS to it.
 *
 * `allowRequest` admits a handshake with:
 *   - no `Origin` header (a server, a native `fetch`/XHR long-polling client),
 *   - an `Origin` that is the server's OWN origin — the request's `Host` with
 *     the scheme of `X-Forwarded-Proto`, or of the connection being TLS. That
 *     is a same-origin request, not a cross-origin one, and it is what every
 *     native WebSocket client sends when its caller gives no `Origin`: React
 *     Native's Android WebSocketModule, iOS's SocketRocket and OxyOS all send
 *     the socket URL's own origin. Refusing it refused every native app's
 *     socket, and
 *   - an `Origin` `createOxyCors` allows (the Oxy apex family, the exact
 *     `appOrigins`).
 * Anything else is refused, the opaque origin (`null`, `exp://`, `file:`…)
 * included. Admission is not authentication: authenticate every socket with
 * `oxy.middleware.socket()`.
 *
 * `cors.origin` needs no same-origin rule. It only decides whether the
 * polling response carries `Access-Control-Allow-*` headers; the request is
 * served either way. A browser applies no CORS check to a same-origin request,
 * and a native client applies none at all, so those headers matter only to a
 * cross-origin page, which the allowlist answers.
 */
export function createOxySocketCors(options: OxySocketCorsOptions = {}): {
  cors: {
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => void;
    credentials: boolean;
    methods: string[];
  };
  allowRequest: (
    req: OxySocketHandshakeRequest,
    callback: (error: string | null | undefined, success: boolean) => void,
  ) => void;
} {
  const allowed = createOxyOriginCheck(options.appOrigins);
  const admits = (origin: string | string[] | undefined): boolean =>
    origin === undefined || (typeof origin === 'string' && (origin === '' || allowed(origin)));
  return {
    cors: {
      origin: (origin, callback) => callback(null, admits(origin)),
      credentials: options.allowCredentials ?? true,
      methods: ['GET', 'POST'],
    },
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      const sameOrigin = typeof origin === 'string' && isSameOriginHandshake(req, origin);
      callback(null, sameOrigin || admits(origin));
    },
  };
}

/**
 * Create a strict Oxy CORS middleware. See module docs.
 *
 * @example
 * ```ts
 * app.use(createOxyCors({ appOrigins: ['https://app.example.com'] }));
 * ```
 */
export function createOxyCors(options: OxyCorsOptions = {}): RequestHandler {
  const {
    appOrigins = [],
    allowCredentials = true,
    methods = DEFAULT_ALLOWED_METHODS,
    allowedHeaders = DEFAULT_ALLOWED_HEADERS,
    exposedHeaders = [],
    maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
  } = options;

  const allowed = createOxyOriginCheck(appOrigins);
  const methodsHeader = methods.join(', ');
  const allowedHeadersHeader = allowedHeaders.join(', ');
  const exposedHeadersHeader = exposedHeaders.join(', ');

  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;

    // Same-origin or non-browser requests carry no Origin header — pass through
    // untouched (no ACAO header is emitted, which is correct for them).
    if (typeof origin !== 'string' || origin.length === 0) {
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
      return;
    }

    // Origin is present. Caching correctness: this response varies by Origin.
    res.setHeader('Vary', 'Origin');

    if (!allowed(origin)) {
      // DENY: do NOT reflect the origin, do NOT emit a wildcard. The browser
      // will block the cross-origin read. Preflights for denied origins get a
      // 204 with no CORS headers (the actual request then fails CORS).
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
      return;
    }

    // ALLOW: echo the EXACT matched origin — never `*`, even without credentials.
    res.setHeader('Access-Control-Allow-Origin', origin);
    if (allowCredentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (exposedHeadersHeader) {
      res.setHeader('Access-Control-Expose-Headers', exposedHeadersHeader);
    }

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', methodsHeader);
      // Honour the browser's requested headers when present, else the default set.
      const requested = req.headers['access-control-request-headers'];
      res.setHeader(
        'Access-Control-Allow-Headers',
        typeof requested === 'string' && requested.length > 0 ? requested : allowedHeadersHeader,
      );
      res.setHeader('Access-Control-Max-Age', String(maxAgeSeconds));
      res.sendStatus(204);
      return;
    }

    next();
  };
}
