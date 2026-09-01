#!/usr/bin/env bun
/**
 * Post-deploy smoke gate for accounts.oxy.so: every inline script the origin
 * SERVES is allowed by the CSP the origin SERVES.
 *
 * Why a live gate when the hash is derived from the build (see
 * `packages/core/scripts/writePagesHeaders.ts`)? Because derivation only
 * guarantees the two agree in `dist`. Everything between `dist` and the browser
 * is unguarded: a build that runs the generator before the export again, a
 * deploy that ships without `_headers`, or an edge rule that replaces the
 * header. All three produce a working-looking app — Expo silently falls back
 * from `hydrateRoot` to `createRoot().render()`, throwing away the
 * server-rendered markup on every visit and paying for an SSR nobody uses. The
 * only symptom is a console error nobody is looking at. That is what this turns
 * red.
 *
 * Public, unauthenticated GET only. No cookies, no secrets.
 *
 * Usage:
 *   bun run packages/accounts/scripts/smoke-csp.ts
 *   SMOKE_TARGET=https://accounts.oxy.so bun run packages/accounts/scripts/smoke-csp.ts
 */

import { cspSourcesFor, extractInlineScripts, inlineScriptCspHash } from '@oxyhq/core/server';

const TARGET = (process.env.SMOKE_TARGET || 'https://accounts.oxy.so').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 15000;

let failed = false;

/** Standard-out / standard-error are this CLI gate's intended output channel. */
function record(name: string, ok: boolean, detail: string): void {
  if (!ok) failed = true;
  const line = `  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`;
  (ok ? process.stdout : process.stderr).write(line);
}

process.stdout.write(`Accounts CSP smoke gate → ${TARGET}\n`);

const response = await fetch(`${TARGET}/`, {
  redirect: 'manual',
  signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
});
const html = await response.text();
const policy = response.headers.get('content-security-policy') ?? '';

record('serves HTML', response.status === 200 && html.length > 0, `status ${response.status}`);
record('serves a Content-Security-Policy', policy.length > 0, policy ? '' : 'header absent');

// `script-src-elem` is what the browser reports for an inline <script> element;
// it is undefined in this policy, so enforcement falls back to `script-src`.
// Read both, in that order, rather than assuming which one the policy defines.
const elemSources = cspSourcesFor(policy, 'script-src-elem');
const scriptSources = elemSources.length > 0 ? elemSources : cspSourcesFor(policy, 'script-src');

const inlineScripts = extractInlineScripts(html);

// Vacuity floor. "0 inline scripts, 0 of them blocked" is the same PASS as a
// correctly-hashed policy, so an export that stops emitting the hydration flag
// would silently retire this gate. Removing it must be a decision, not a
// side effect.
record(
  'served HTML contains at least one inline script',
  inlineScripts.length > 0,
  `found ${inlineScripts.length}`,
);

for (const [index, source] of inlineScripts.entries()) {
  const hash = inlineScriptCspHash(source);
  const allowed = scriptSources.includes(hash);
  record(
    `inline script #${index + 1} is allowed by hash`,
    allowed,
    `${hash} ${allowed ? 'present in' : 'MISSING from'} script-src`,
  );
}

// Negative control for the check above. `includes(hash)` would also be
// satisfied by a policy containing every conceivable source, or by a parser
// that returned the whole header as one token — this asserts the check can
// still say no.
record(
  'a hash the build did not derive is NOT allowed',
  !scriptSources.includes(inlineScriptCspHash('/* never shipped */')),
  'control hash correctly absent',
);

// The effect, not just the header: hydration is the reason the hash exists.
record(
  'the hydration flag Expo emits is present in the served HTML',
  html.includes('__EXPO_ROUTER_HYDRATE__'),
  '',
);

process.stdout.write(failed ? '\nAccounts CSP smoke gate FAILED\n' : '\nAccounts CSP smoke gate OK\n');
process.exit(failed ? 1 : 0);
