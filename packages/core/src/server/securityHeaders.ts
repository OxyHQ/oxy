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
 *  3. A STATIC EXPO EXPORT SHIPS AN INLINE SCRIPT THE BASELINE FORBIDS.
 *     `web.output: 'static'` makes Expo Router emit
 *     `<script type="module">globalThis.__EXPO_ROUTER_HYDRATE__=true;</script>`,
 *     which is what tells the client entry to call `hydrateRoot` instead of
 *     `createRoot().render()`. Nothing in app code puts it there, so — like the
 *     Cloudflare beacon above — an app cannot allowlist it from the app side.
 *     Measured on `accounts.oxy.so` 2026-08-21: blocked, so every visit threw
 *     away the server-rendered markup and re-rendered from scratch, with only a
 *     console error to show for it. The hashes are therefore DERIVED from the
 *     built output rather than hand-written (see {@link extractInlineScripts}):
 *     a hash pasted into config is correct exactly until the build changes one
 *     byte, and then it fails the same silent way.
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

import { createHash } from 'node:crypto';
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

/**
 * Serialize resolved CSP directives into the single-line header value browsers
 * and Cloudflare `_headers` expect. Valueless directives (e.g.
 * `upgrade-insecure-requests`) emit the name alone.
 */
export function formatOxyCspPolicy(directives: Record<string, string[]>): string {
  return Object.entries(directives)
    .map(([name, sources]) => (sources.length === 0 ? name : `${name} ${sources.join(' ')}`))
    .join('; ');
}

/**
 * The source list one directive carries in a serialized policy, or `[]` when
 * the policy does not name that directive. The inverse of
 * {@link formatOxyCspPolicy}, and the reason it lives here rather than beside
 * either caller: the post-deploy gate parses the policy the ORIGIN serves while
 * the unit test parses the one the middleware renders, so a copy in each would
 * let the header shape change with the test still green and the gate reading
 * `[]` — reporting every script blocked, which reads as a broken app rather
 * than as a broken parser.
 *
 * A directive present with no sources (`upgrade-insecure-requests`) and a
 * directive absent entirely both answer `[]`. Callers that need to tell those
 * apart are asking a different question than "what is allowed here".
 */
export function cspSourcesFor(policy: string, directive: string): string[] {
  const segment = policy
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry === directive || entry.startsWith(`${directive} `));
  return segment === undefined ? [] : segment.split(/\s+/).slice(1);
}

/**
 * Index of the `>` that closes a tag whose attribute region starts at `from`,
 * or `-1` if the document ends first. Quote-aware: a `>` inside an attribute
 * VALUE does not close the tag.
 *
 * No HTML any Oxy build currently emits contains such an attribute, so this is
 * not load-bearing today — it is here because the same scanner reads the SERVED
 * document in the post-deploy gate, and what an edge injects into that document
 * is not ours to constrain. Getting it wrong is not a parse error: the body
 * window shifts, the hash is computed over the wrong bytes, and the script is
 * blocked exactly as if no hash had been derived at all.
 */
function findTagEnd(html: string, from: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = from; index < html.length; index += 1) {
    const character = html[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return index;
  }
  return -1;
}

/**
 * Every inline `<script>` body in an HTML document, in document order. A
 * `<script src=…>` is a URL the source list already governs and is skipped.
 *
 * Scanned rather than matched with one regex because the two failure modes are
 * not symmetric: an EXTRA body costs a redundant hash nobody notices, while a
 * MISSED body silently reinstates the exact breakage this exists to prevent.
 * So the scan errs toward finding them — it walks the open tag quote-aware
 * instead of letting a `>` inside an attribute value truncate it.
 *
 * The type attribute is deliberately not consulted. Whether a given `type`
 * executes is a browser decision (and it changes: `importmap` and
 * `speculationrules` were both once inert), and pinning the exact bytes of a
 * data block we ship ourselves weakens nothing.
 */
export function extractInlineScripts(html: string): string[] {
  const lowered = html.toLowerCase();
  const bodies: string[] = [];
  const openTag = /<script\b/gi;

  let match = openTag.exec(html);
  while (match !== null) {
    const attributesStart = match.index + match[0].length;
    const attributesEnd = findTagEnd(html, attributesStart);
    if (attributesEnd < 0) break;

    const bodyStart = attributesEnd + 1;
    const bodyEnd = lowered.indexOf('</script', bodyStart);
    if (bodyEnd < 0) break;

    if (!/\bsrc\s*=/i.test(html.slice(attributesStart, attributesEnd))) {
      bodies.push(html.slice(bodyStart, bodyEnd));
    }

    openTag.lastIndex = bodyEnd;
    match = openTag.exec(html);
  }

  return bodies;
}

/**
 * The `'sha256-…'` source that allows one inline script, hashed over its exact
 * bytes as CSP specifies — no trimming, no normalization. One byte of
 * whitespace either way is a different hash and the script stays blocked.
 */
export function inlineScriptCspHash(source: string): string {
  return `'sha256-${createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

/**
 * Ceiling on how many derived inline-script hashes may enter one `_headers`
 * block. Nothing in an Oxy app authors an inline script, so the realistic
 * count is the ONE Expo Router hydration flag — deduped across every route's
 * HTML, because it is byte-identical in all of them.
 *
 * The ceiling exists because one future change breaks that: a route loader
 * makes Expo emit a SECOND inline script, `__EXPO_ROUTER_LOADER_DATA__`, whose
 * bytes differ per route. The hashes stay CORRECT (they are derived from the
 * same build that ships), but the count becomes the route count and the policy
 * grows without bound on every response. That is a decision to take
 * deliberately, so it arrives as a red build rather than a quietly enormous
 * header.
 */
const MAX_INLINE_SCRIPT_HASHES = 8;

export interface OxyPagesHeadersOptions {
  /** Per-app additions merged into {@link OXY_CSP_BASELINE}. */
  csp?: OxyCspExtensions;
  /**
   * Emit `Strict-Transport-Security` (default `true`). Cloudflare Pages serves
   * HTTPS only, so static deploys should keep this on.
   */
  hsts?: boolean;
  /**
   * The BUILT HTML documents this `_headers` will be served alongside. Every
   * inline script found in them is allowed by hash, added to `script-src`.
   *
   * Passing the built output — rather than hand-writing a hash into
   * `oxy.pages-headers.json` — is the whole point: a pasted hash is correct
   * until the generator changes one byte of that script, and then the script is
   * blocked again with nothing but a console error to show for it.
   */
  html?: readonly string[];
}

/**
 * Build a Cloudflare Pages `_headers` block for an Oxy HTML origin. Uses the
 * same CSP resolution as {@link createOxySecurityHeaders} plus the non-CSP
 * hardening headers Helmet would add on an Express HTML backend.
 *
 * Adding a hash to `script-src` does not narrow it: per CSP Level 3 a hash is
 * an additional source, so `'self'` and the beacon host keep matching external
 * scripts. (It WOULD neutralize `'unsafe-inline'` in the same directive — which
 * is why this hashes scripts only. `style-src` keeps `'unsafe-inline'` for
 * react-native-web's runtime stylesheet, and a style hash would silently switch
 * that off and render every Oxy web app unstyled.)
 */
export function buildOxyPagesHeaders(options: OxyPagesHeadersOptions = {}): string {
  const hashes = [
    ...new Set((options.html ?? []).flatMap(extractInlineScripts).map(inlineScriptCspHash)),
  ];
  if (hashes.length > MAX_INLINE_SCRIPT_HASHES) {
    throw new RangeError(
      `Oxy CSP: ${hashes.length} distinct inline scripts in the built HTML exceeds the ${MAX_INLINE_SCRIPT_HASHES}-hash ceiling. A per-route inline data block (e.g. an Expo Router loader) is the likely cause; allow it deliberately rather than by raising this.`,
    );
  }

  const csp = formatOxyCspPolicy(
    buildOxyCspDirectives(
      hashes.length === 0
        ? options.csp
        : { ...options.csp, scriptSrc: [...(options.csp?.scriptSrc ?? []), ...hashes] },
    ),
  );
  const lines = [
    '/*',
    `  Content-Security-Policy: ${csp}`,
    '  X-Frame-Options: DENY',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
  ];
  if (options.hsts !== false) {
    lines.push('  Strict-Transport-Security: max-age=31536000; includeSubDomains; preload');
  }
  lines.push('');
  return lines.join('\n');
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
