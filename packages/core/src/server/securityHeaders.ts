/**
 * Shared security headers (Helmet + Content-Security-Policy) for Oxy backends.
 *
 * WHY THIS EXISTS
 * ---------------
 * A CSP only governs an origin that serves DOCUMENTS; on a JSON API it governs
 * no browsing context. The Oxy origins that serve HTML through Cloudflare have
 * so far either hand-written their own policy or shipped none at all, and two
 * bugs follow from that:
 *
 *  1. THE CLOUDFLARE INSIGHTS BEACON IS BLOCKED BY A HAND-WRITTEN POLICY.
 *     Cloudflare injects `<script src="https://static.cloudflareinsights.com/
 *     beacon.min.js/...">` into HTML it proxies. No application code loads it,
 *     so it cannot be allowlisted from the app side any other way, and an
 *     origin whose policy says `script-src 'self'` logs
 *     `Loading the script 'https://static.cloudflareinsights.com/beacon.min.js'
 *     violates the following Content Security Policy directive: "script-src
 *     'self'"` and collects nothing. The beacon needs BOTH hosts, and they are
 *     different halves of the same feature: `static.cloudflareinsights.com`
 *     serves the script (`script-src`), `cloudflareinsights.com` receives the
 *     measurements (`connect-src`). Allowing only the script leaves the beacon
 *     loading but unable to report, which looks fixed and is not. Verified in
 *     production 2026-07-29: `mention.earth` serves HTML behind Cloudflare with
 *     the beacon injected and `script-src 'self'` — blocked; `oxy.so` had
 *     already allowlisted the same two hosts in its own static `_headers`,
 *     independently, which is the divergence this baseline exists to end.
 *
 *  2. AN EXPLICIT DIRECTIVE SILENTLY REPLACES HELMET'S DEFAULT.
 *     Writing `scriptSrc: ['https://example.com']` drops `'self'` — the page's
 *     own bundle stops loading (or, worse, only some lazily-loaded chunk does,
 *     so it ships). This helper makes that structurally impossible: callers can
 *     only ADD sources to the Oxy baseline, never replace a directive, and they
 *     cannot pass their own `contentSecurityPolicy` through to Helmet at all
 *     (the option is typed `never`).
 *
 * WHAT IT PROVIDES
 * ----------------
 * `createOxySecurityHeaders(options)` returns the Helmet middleware with the
 * Oxy-wide CSP baseline applied, plus per-app extensions merged (and deduped)
 * into it. Everything Helmet does that is NOT the CSP (HSTS, frameguard,
 * referrer policy, CORP/COOP, …) is passed straight through, so an app keeps
 * full control of those.
 *
 * `buildOxyCspDirectives(extensions)` is the same resolution as a pure
 * function, for the Oxy document origins that are NOT Express — a Next.js
 * `headers()`, a Cloudflare Pages `_headers` generator — so one policy can
 * cover them without a second implementation.
 *
 * SCOPE: mount this on backends that serve HTML. A JSON-only API gains nothing
 * from a source-list CSP; harden those with the non-CSP headers instead
 * (`hsts`, `noSniff`, `frameguard`, CORP) rather than adding directives that
 * apply to no document.
 *
 * Node/Express-only: exported solely from `@oxyhq/core/server`.
 */

import type { RequestHandler } from 'express';
import helmet, { type HelmetOptions } from 'helmet';

/** CSP keyword for "this origin". Always present in every open baseline directive. */
const SELF = "'self'";

/** CSP keyword for a fully closed directive. Meaningless alongside any other source. */
const NONE = "'none'";

/**
 * Cloudflare Web Analytics. Injected at the edge into proxied HTML — no Oxy app
 * loads it, and no Oxy app should have to know these hostnames. Both are
 * required: the script host, and the host the beacon reports to.
 */
const CLOUDFLARE_INSIGHTS_SCRIPT_ORIGIN = 'https://static.cloudflareinsights.com';
const CLOUDFLARE_INSIGHTS_REPORT_ORIGIN = 'https://cloudflareinsights.com';

/**
 * Oxy platform origins. Every Oxy web origin runs the SDK, which calls the Oxy
 * API over HTTPS and Socket.IO, and resolves all canonical media through the
 * Oxy CDN (`getFileDownloadUrl` → `cloud.oxy.so`).
 */
const OXY_API_ORIGIN = 'https://api.oxy.so';
const OXY_API_WEBSOCKET_ORIGIN = 'wss://api.oxy.so';
const OXY_CDN_ORIGIN = 'https://cloud.oxy.so';

/** The CSP directives an Oxy app may extend, in Helmet's camelCase spelling. */
export type OxyCspDirective =
  | 'baseUri'
  | 'connectSrc'
  | 'defaultSrc'
  | 'fontSrc'
  | 'formAction'
  | 'frameAncestors'
  | 'frameSrc'
  | 'imgSrc'
  | 'manifestSrc'
  | 'mediaSrc'
  | 'objectSrc'
  | 'scriptSrc'
  | 'scriptSrcAttr'
  | 'scriptSrcElem'
  | 'styleSrc'
  | 'styleSrcElem'
  | 'workerSrc';

/**
 * Per-app ADDITIONS to the Oxy baseline, keyed by directive. Values are merged
 * into the baseline and deduped — they never replace it, so `'self'` (and the
 * Cloudflare beacon hosts) cannot be lost. Extending a directive the baseline
 * does not define seeds it with `'self'` first, for the same reason.
 */
export type OxyCspExtensions = Partial<Record<OxyCspDirective, readonly string[]>>;

/**
 * The Oxy-wide CSP baseline. Deliberately the floor every Oxy origin needs, not
 * a superset of what any one app allows — permissive sources an individual app
 * wants (`https:` images, `blob:` media, embed hosts, LiveKit) are that app's
 * extension, so each widening stays visible at its call site.
 *
 * `style-src` carries `'unsafe-inline'` because react-native-web injects its
 * stylesheet as inline `<style>` at runtime; without it every Oxy web app
 * renders unstyled.
 */
export const OXY_CSP_BASELINE: Readonly<Partial<Record<OxyCspDirective, readonly string[]>>> =
  Object.freeze({
    defaultSrc: Object.freeze([SELF]),
    baseUri: Object.freeze([SELF]),
    formAction: Object.freeze([SELF]),
    frameAncestors: Object.freeze([NONE]),
    objectSrc: Object.freeze([NONE]),
    scriptSrc: Object.freeze([SELF, CLOUDFLARE_INSIGHTS_SCRIPT_ORIGIN]),
    scriptSrcAttr: Object.freeze([NONE]),
    styleSrc: Object.freeze([SELF, "'unsafe-inline'"]),
    imgSrc: Object.freeze([SELF, 'data:', OXY_CDN_ORIGIN]),
    mediaSrc: Object.freeze([SELF, OXY_CDN_ORIGIN]),
    fontSrc: Object.freeze([SELF, 'data:']),
    connectSrc: Object.freeze([
      SELF,
      CLOUDFLARE_INSIGHTS_REPORT_ORIGIN,
      OXY_API_ORIGIN,
      OXY_API_WEBSOCKET_ORIGIN,
      OXY_CDN_ORIGIN,
    ]),
  });

/** `connectSrc` → `connect-src`. Total over `OxyCspDirective` (all are camelCase ASCII). */
function toHeaderDirectiveName(directive: OxyCspDirective): string {
  return directive.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * A source containing `;` or `,` would silently terminate the directive (or the
 * whole policy) and hand the rest of the string to the browser as new
 * directives. Helmet rejects these too; we reject them here so the pure builder
 * is equally safe, and so the failure names the offending directive.
 */
function assertValidSource(directive: OxyCspDirective, source: string): void {
  if (typeof source !== 'string' || source.length === 0) {
    throw new TypeError(`Oxy CSP: ${toHeaderDirectiveName(directive)} received an empty source.`);
  }
  if (source.includes(';') || source.includes(',')) {
    throw new TypeError(
      `Oxy CSP: ${toHeaderDirectiveName(directive)} source ${JSON.stringify(source)} may not contain ";" or ",".`,
    );
  }
}

/** Order-preserving, first-seen-wins dedupe. */
function dedupe(sources: readonly string[]): string[] {
  return [...new Set(sources)];
}

/**
 * Resolve the effective CSP directives: the Oxy baseline, with each app
 * extension merged in and deduped.
 *
 * Merge rules:
 *  - A baseline directive is EXTENDED, never replaced — `'self'` and the
 *    Cloudflare beacon hosts always survive.
 *  - A directive absent from the baseline is seeded with `'self'`, so adding
 *    (say) an embed host to `frame-src` cannot lock the origin out of itself.
 *  - A directive whose baseline is exactly `'none'` is CLOSED: extending it
 *    drops the sentinel, because `'none'` alongside any other source is
 *    meaningless per the CSP spec. This is how an app that must be framable
 *    opts back in with `frameAncestors: ["'self'"]`.
 *
 * @example
 * ```ts
 * buildOxyCspDirectives({ frameSrc: ['https://player.vimeo.com'] });
 * // → { ..., 'frame-src': ["'self'", 'https://player.vimeo.com'], ... }
 * ```
 */
export function buildOxyCspDirectives(extensions: OxyCspExtensions = {}): Record<string, string[]> {
  const directiveNames = new Set<OxyCspDirective>([
    ...(Object.keys(OXY_CSP_BASELINE) as OxyCspDirective[]),
    ...(Object.keys(extensions) as OxyCspDirective[]),
  ]);

  const resolved: Record<string, string[]> = {};

  for (const directive of directiveNames) {
    const extras = extensions[directive] ?? [];
    for (const source of extras) {
      assertValidSource(directive, source);
    }

    const baseline = OXY_CSP_BASELINE[directive] ?? [SELF];
    const isClosed = baseline.length === 1 && baseline[0] === NONE;
    const merged = isClosed && extras.length > 0 ? extras : [...baseline, ...extras];

    resolved[toHeaderDirectiveName(directive)] = dedupe(merged);
  }

  // Valueless directive: rewrite stray `http://` subresources to HTTPS rather
  // than failing them, which matters for federated/user-supplied URLs.
  resolved['upgrade-insecure-requests'] = [];

  return resolved;
}

export interface OxySecurityHeadersOptions {
  /**
   * Per-app additions to the Oxy CSP baseline. Merged, deduped, never
   * replacing — see {@link buildOxyCspDirectives}.
   */
  csp?: OxyCspExtensions;
  /**
   * Everything Helmet does that is not the CSP: `hsts`, `frameguard`,
   * `referrerPolicy`, `crossOriginResourcePolicy`, … Passed straight through.
   *
   * `contentSecurityPolicy` is typed `never` on purpose: the CSP is owned by
   * this helper so the baseline cannot be replaced (nor the `'self'` guarantee
   * bypassed) by an app that hands Helmet its own directive block. Extend it
   * through `csp` instead.
   */
  helmet?: HelmetOptions & { contentSecurityPolicy?: never };
}

/**
 * Build the shared Oxy security-headers middleware: Helmet with the Oxy CSP
 * baseline plus this app's extensions.
 *
 * @example
 * ```ts
 * app.use(createOxySecurityHeaders({
 *   csp: {
 *     connectSrc: ['https://api.example.com', 'wss://api.example.com'],
 *     frameSrc: ['https://player.vimeo.com'],
 *   },
 *   helmet: { crossOriginResourcePolicy: { policy: 'cross-origin' } },
 * }));
 * ```
 */
export function createOxySecurityHeaders(options: OxySecurityHeadersOptions = {}): RequestHandler {
  const { csp, helmet: helmetOptions } = options;
  const directives = buildOxyCspDirectives(csp);

  return helmet({
    ...helmetOptions,
    // `useDefaults: false`: the baseline above is the whole policy, so what the
    // browser receives is exactly what `buildOxyCspDirectives` returns — no
    // silent union with Helmet's defaults that tests would never see.
    contentSecurityPolicy: { useDefaults: false, directives },
  });
}
