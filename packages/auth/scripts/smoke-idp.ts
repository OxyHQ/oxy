/**
 * Post-deploy smoke gate for auth.oxy.so (third-party OAuth IdP).
 *
 * Runs AFTER the `oxy-auth` Cloudflare Pages deploy and hits the LIVE host using
 * ONLY public, unauthenticated endpoints (no cookies, no secrets). It asserts the
 * post-FedCM-deletion contract so a broken deploy turns the workflow RED instead
 * of silently breaking sign-in for the whole ecosystem.
 *
 * The IdP is now a pure static SPA — it enumerates device accounts through the
 * SAME device-first SDK path every app uses (`useDeviceSwitcher`), so there
 * is no bespoke chooser-feed Pages Function to probe anymore.
 *
 * What it catches:
 *   - SPA renders blank / build totally broken   → `/`, `/login`, `/signup`, `/authorize` lose the SPA root marker.
 *   - `/authorize` not routed at all             → a PKCE-bound authorize URL stops answering 200 with the SPA shell.
 *   - FedCM manifest NOT removed                  → `/.well-known/web-identity` still serves the FedCM config JSON.
 *
 * What it CANNOT catch, despite an earlier comment here claiming otherwise: a
 * client-side render failure such as #784. See {@link checkAuthorizeWithPkce}.
 *
 * Usage:
 *   bun run packages/auth/scripts/smoke-idp.ts
 *   SMOKE_TARGET=https://auth.oxy.so bun run packages/auth/scripts/smoke-idp.ts
 *
 * Exit code is non-zero if ANY assertion fails. No external dependencies — uses
 * only `fetch` and the standard runtime so it runs identically in CI and locally.
 */

/** Host under test. Configurable so it can target a custom-domain too. */
const PRIMARY_TARGET = (process.env.SMOKE_TARGET || 'https://auth.oxy.so').replace(/\/+$/, '');

const REQUEST_TIMEOUT_MS = 15000;
/** The single DOM marker the Vite SPA mounts into (`packages/auth/index.html`). */
const SPA_ROOT_MARKER = 'id="root"';

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

/** Standard-out / standard-error are this CLI gate's intended output channel. */
function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

function logError(line: string): void {
  process.stderr.write(`${line}\n`);
}

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  log(`  [${tag}] ${name}${detail ? ` — ${detail}` : ''}`);
}

interface FetchOutcome {
  status: number;
  contentType: string;
  body: string;
  headers: Headers;
  error?: string;
}

async function probe(url: string, init?: RequestInit): Promise<FetchOutcome> {
  try {
    const res = await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await res.text();
    return {
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      body,
      headers: res.headers,
    };
  } catch (err) {
    return { status: 0, contentType: '', body: '', headers: new Headers(), error: err instanceof Error ? err.message : String(err) };
  }
}

/** Parse a JSON body, returning `null` (never throwing) on invalid JSON. */
function parseJson(body: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(body) as unknown;
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A SPA HTML page MUST be 200 and contain the SPA root marker. */
async function checkSpaPage(hostBase: string, path: string): Promise<void> {
  const out = await probe(`${hostBase}${path}`, { headers: { Accept: 'text/html' } });
  if (out.error) {
    record(`SPA ${path}`, false, `request failed: ${out.error}`);
    return;
  }
  if (out.status !== 200) {
    record(`SPA ${path}`, false, `expected 200, got ${out.status}`);
    return;
  }
  if (!out.body.includes(SPA_ROOT_MARKER)) {
    record(`SPA ${path}`, false, `missing SPA root marker (${SPA_ROOT_MARKER}) — build broken?`);
    return;
  }
  record(`SPA ${path}`, true, '200 + root marker present');
}

/**
 * A PKCE-bound authorize URL must still be SERVED. That is all this proves, and
 * it is worth being precise about, because this check was once believed to cover
 * the blank-page bug in #784 and covers none of it:
 *
 *  - the marker it looks for lives in `index.html`, which the static host
 *    returns for every route whether or not React then dies on the client;
 *  - `oxy_dk_smoke_client` is not a registered application, and the authorize
 *    page redirects an unresolvable client to `/login` well before it reaches
 *    the Commons lane. Using a REAL client id here would not help either — it
 *    would create a live authorization request against production on every
 *    deploy — so the substitution is deliberate, not an oversight.
 *
 * The render itself is covered where it can actually be observed, against a real
 * production bundle: `lib/__tests__/authorize-surface-bundle.test.ts`.
 */
async function checkAuthorizeWithPkce(hostBase: string): Promise<void> {
  const params = new URLSearchParams({
    client_id: 'oxy_dk_smoke_client',
    redirect_uri: 'https://app.example.com/callback',
    response_type: 'code',
    scope: 'openid profile',
    state: 'smoke-state',
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
  });
  const path = `/authorize?${params.toString()}`;
  await checkSpaPage(hostBase, path);
}

/**
 * The FedCM manifest MUST be GONE. `GET /.well-known/web-identity` no longer has
 * a handler, so it falls through to the SPA (or 404) — anything EXCEPT a valid
 * `200 application/json` FedCM config with `provider_urls` is a pass. A regression
 * that re-adds the endpoint (200 JSON + provider_urls) fails.
 */
async function checkWebIdentityGone(hostBase: string): Promise<void> {
  const out = await probe(`${hostBase}/.well-known/web-identity`, { headers: { Accept: 'application/json' } });
  if (out.error) {
    record('web-identity removed', false, `request failed: ${out.error}`);
    return;
  }
  const json = out.contentType.includes('application/json') ? parseJson(out.body) : null;
  if (out.status === 200 && json && Array.isArray(json.provider_urls)) {
    record('web-identity removed', false, 'FedCM manifest is STILL served (provider_urls present) — endpoint not deleted');
    return;
  }
  record('web-identity removed', true, `no FedCM manifest (status ${out.status}, ${out.contentType || 'no content-type'})`);
}

/** Shared Oxy Pages security headers must include the Cloudflare beacon on both halves. */
async function checkSecurityHeaders(hostBase: string): Promise<void> {
  const out = await probe(`${hostBase}/`, { headers: { Accept: 'text/html' } });
  if (out.error) {
    record('security headers', false, `request failed: ${out.error}`);
    return;
  }
  const csp = out.headers.get('content-security-policy') || '';
  if (!csp) {
    record('security headers', false, 'missing Content-Security-Policy header');
    return;
  }
  const missing: string[] = [];
  if (!csp.includes('static.cloudflareinsights.com')) missing.push('static.cloudflareinsights.com (script-src)');
  if (!csp.includes('cloudflareinsights.com')) missing.push('cloudflareinsights.com (connect-src)');
  if (!csp.includes("script-src 'self'")) missing.push("'self' in script-src");
  if (out.headers.get('x-frame-options')?.toUpperCase() !== 'DENY') {
    missing.push('X-Frame-Options: DENY');
  }
  if (missing.length > 0) {
    record('security headers', false, `missing: ${missing.join('; ')}`);
    return;
  }
  record('security headers', true, 'CSP baseline + X-Frame-Options present');
}

async function run(): Promise<void> {
  log(`\nauth.oxy.so smoke gate — target: ${PRIMARY_TARGET}\n`);

  await checkSpaPage(PRIMARY_TARGET, '/login');
  await checkSpaPage(PRIMARY_TARGET, '/signup');
  await checkSpaPage(PRIMARY_TARGET, '/authorize');
  await checkAuthorizeWithPkce(PRIMARY_TARGET);
  await checkWebIdentityGone(PRIMARY_TARGET);
  await checkSecurityHeaders(PRIMARY_TARGET);

  const failed = results.filter((r) => !r.ok);
  log(`\n${failed.length === 0 ? 'OK' : 'FAILED'}: ${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    logError(`\n${failed.length} assertion(s) failed:`);
    for (const f of failed) {
      logError(`  - ${f.name}: ${f.detail}`);
    }
    process.exit(1);
  }
}

run().catch((err) => {
  logError(`auth smoke gate crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
