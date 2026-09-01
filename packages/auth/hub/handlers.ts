/**
 * `auth.oxy.so/hub/*` — the IdP's minimal server/edge layer (issue #937
 * Phase 5, ADR 0003).
 *
 * The handlers are plain `(Request, HubEnv) => Promise<Response>` functions.
 * `functions/hub/*.ts` are three-line Cloudflare Pages adapters around them, so
 * the whole layer is testable with `bun test` and nothing about it depends on
 * being inside a Worker.
 *
 * ## What this layer is for, and what it deliberately is not
 *
 * It exists so `auth.oxy.so` can hold a first-party DeviceSession for the
 * browser profile and let a later official origin join over ordinary
 * Authorization Code + PKCE. It reads/sets/rotates/revokes the handle, resolves
 * the device session, and runs the authorize lane. It moves NO account
 * management here — `accounts.oxy.so` keeps that, exclusively.
 *
 * ## Two credentials cross this boundary and NEITHER reaches the browser
 *
 *  - The hub handle lives in an `HttpOnly` cookie. It is read from the `Cookie`
 *    header, forwarded to the API, and never put in a response body.
 *  - The device-wide access token is minted by the API from that handle, used
 *    here, and discarded. It is never returned to the SPA — which is the reason
 *    `/hub/authorize` exists at all instead of the SPA calling
 *    `POST /auth/oauth/authorize` itself.
 *
 * ## CSRF
 *
 * These are the cookie-bearing endpoints, so CSRF is live again for them (it
 * remains irrelevant to the bearer-authenticated writes everywhere else). Three
 * independent gates, each sufficient on its own, all failing closed — see
 * {@link guard}.
 *
 * ## What is NOT here, and must never be added
 *
 * No hidden or silent iframe; no third-party cookie; no cross-origin
 * `localStorage`; no Storage Access API; no popup created without a gesture; no
 * `prompt=none` lane (there is no `prompt` field on the request at all); no
 * FedCM; and no redirect issued by the edge. Every one of these handlers answers
 * with JSON, so nothing here can navigate a browser anywhere.
 */

import {
  browserHubHandleResponseSchema,
  browserHubResolveResponseSchema,
  browserHubRevokeResponseSchema,
  deviceActivateResponseSchema,
  deviceSessionSyncSchema,
  hubActivateRequestSchema,
  hubAuthorizeRequestSchema,
  hubClaimRequestSchema,
  oauthAuthorizeCodeResponseSchema,
  oauthConsentDecisionSchema,
  type BrowserHubResolveResponse,
  type HubAuthorizeResult,
  type HubSession,
} from '@oxyhq/contracts';
import { z } from 'zod';
import { clearedHubCookieHeader, hubCookieHeader, readHubHandle } from './cookie';
import { apiGet, apiPost, type HubEnv, type UpstreamFailure } from './upstream';

/**
 * The header a caller must send.
 *
 * A cross-origin `fetch` carrying a non-safelisted header triggers a CORS
 * preflight, and this layer answers no `OPTIONS` and sends no
 * `Access-Control-Allow-*` — so the preflight fails and the real request is
 * never made. HTML forms, `<img>`, `<script>` and `navigator.sendBeacon` cannot
 * set it at all. That makes it a gate no cross-site context can pass, which is
 * the classic double-submit defence without a token to manage.
 */
const HUB_REQUEST_HEADER = 'x-oxy-hub';

/** The only `Sec-Fetch-Site` value a legitimate hub call can carry. */
const SAME_ORIGIN = 'same-origin';

/**
 * The claim response's ONE field this layer uses.
 *
 * `POST /auth/session/claim` also returns `deviceSecret`, `sessionId`, the
 * `deviceId` and the user. The edge asks for none of them and stores none of
 * them: the whole point of establishing a hub is that the browser's durable
 * credential becomes the handle, so a second one materialising here — even
 * briefly, even server-side — would be the dual authority this phase exists to
 * avoid. Zod strips unknown keys, so the extra fields are dropped at the parse
 * rather than carried along and forgotten.
 */
const claimResponseSchema = z.object({ accessToken: z.string().min(1) });

function jsonResponse(body: unknown, init?: { status?: number; setCookie?: string }): Response {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    // A hub answer describes who is signed in on this browser right now. It must
    // never sit in a shared cache, a back/forward cache or a proxy.
    'cache-control': 'no-store',
    // `_headers` covers static assets on Cloudflare Pages, not Function
    // responses — so the framing and sniffing guards are restated here rather
    // than assumed.
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    // The response varies by cookie by construction; say so, for any cache that
    // ignores `no-store`.
    vary: 'Cookie',
  });
  if (init?.setCookie) headers.append('set-cookie', init.setCookie);
  return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers });
}

/**
 * The three CSRF gates, in the order they are cheapest to fail.
 *
 * 1. **Method.** Every endpoint here is `POST`. A `GET` that carried the cookie
 *    could be triggered by a bare navigation or an `<img>` tag.
 * 2. **`Origin` exactly equal to this deployment's own origin.** Browsers attach
 *    `Origin` to every non-`GET` request, same-origin included, and a page
 *    cannot forge it. Absent is REFUSED, not waved through: the only callers are
 *    browsers, so a missing `Origin` here is an anomaly rather than the `curl`
 *    case the API's own guard tolerates.
 * 3. **`Sec-Fetch-Site: same-origin`** when the browser sends it, and the custom
 *    header always. Redundant with (2) by design — each gate independently
 *    blocks the whole cross-site class, and the cost of all three is three
 *    string comparisons.
 */
function guard(request: Request): Response | null {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, { status: 405 });
  }

  const expected = new URL(request.url).origin;
  if (request.headers.get('origin') !== expected) {
    return jsonResponse({ error: 'bad_origin' }, { status: 403 });
  }

  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite !== null && secFetchSite !== SAME_ORIGIN) {
    return jsonResponse({ error: 'bad_origin' }, { status: 403 });
  }

  if (request.headers.get(HUB_REQUEST_HEADER) !== '1') {
    return jsonResponse({ error: 'bad_origin' }, { status: 403 });
  }

  return null;
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

const SIGNED_OUT: HubSession = { status: 'signed_out' };

/** Resolve the browser's device session from the cookie, or say why not. */
async function resolveFromCookie(
  request: Request,
  env: HubEnv
): Promise<
  | { ok: true; handle: string; resolved: BrowserHubResolveResponse }
  // `clearCookie` distinguishes the two failures that must be handled
  // differently: a handle the server no longer knows is dead and its cookie is
  // litter, while a live handle whose device has nothing signed in is a perfectly
  // good credential the browser must keep.
  | { ok: false; clearCookie: boolean }
> {
  const handle = readHubHandle(request);
  if (!handle) return { ok: false, clearCookie: false };

  const resolved = await apiPost(
    env,
    '/session/browser-hub/resolve',
    { handle },
    (value) => browserHubResolveResponseSchema.safeParse(value)
  );
  if (!resolved.ok) {
    return { ok: false, clearCookie: resolved.code === 'invalid_handle' };
  }
  return { ok: true, handle, resolved: resolved.data };
}

function sessionResponse(resolved: BrowserHubResolveResponse, setCookie?: string): Response {
  const body: HubSession = { status: 'active', directory: resolved.directory };
  return jsonResponse(body, setCookie ? { setCookie } : undefined);
}

function signedOutResponse(clearCookie: boolean): Response {
  return jsonResponse(SIGNED_OUT, clearCookie ? { setCookie: clearedHubCookieHeader() } : undefined);
}

/**
 * POST /hub/session — what the SPA is allowed to know about this browser.
 *
 * Returns the DIRECTORY and no credential. The bearer that produced it was
 * minted, used to fetch the directory, and dropped inside the API call above.
 */
export async function handleHubSession(request: Request, env: HubEnv): Promise<Response> {
  const rejected = guard(request);
  if (rejected) return rejected;

  const outcome = await resolveFromCookie(request, env);
  if (!outcome.ok) return signedOutResponse(outcome.clearCookie);
  return sessionResponse(outcome.resolved);
}

/**
 * POST /hub/claim — establish the hub from an approved Commons request.
 *
 * The SPA hands over the secret `sessionToken` of an `AuthSession` it created
 * and Commons has approved. The edge spends it here, server-side, in three
 * steps, and keeps nothing:
 *
 *   1. claim the session          → a bearer for the newly authenticated person
 *   2. register it on the device  → the person becomes a principal of this
 *                                   browser's DeviceSession, with their personal
 *                                   context active if none was
 *   3. establish the hub handle   → written straight into `__Host-oxy-device`
 *
 * The `deviceSecret` step 1 also mints is deliberately discarded, unparsed. On a
 * browser the handle is the ONLY durable credential; a second one persisted
 * anywhere would be exactly the dual authority ADR 0003 forbids.
 *
 * Steps 2 and 3 are not transactional and cannot be: a failure at 3 leaves the
 * person signed in on the device with no hub cookie, which is the pre-hub status
 * quo and is recoverable by retrying. A failure at 2 leaves an authenticated
 * session that no device lists, which the ordinary sign-in lane already
 * tolerates.
 */
export async function handleHubClaim(request: Request, env: HubEnv): Promise<Response> {
  const rejected = guard(request);
  if (rejected) return rejected;

  const parsedBody = hubClaimRequestSchema.safeParse(await readJsonBody(request));
  if (!parsedBody.success) {
    return jsonResponse({ error: 'invalid_request' }, { status: 400 });
  }

  const claimed = await apiPost(
    env,
    '/auth/session/claim',
    { sessionToken: parsedBody.data.sessionToken },
    (value) => claimResponseSchema.safeParse(value)
  );
  if (!claimed.ok) return upstreamFailure(claimed);
  const bearer = claimed.data.accessToken;

  const registered = await apiPost(
    env,
    '/session/device/add',
    {},
    (value) => deviceSessionSyncSchema.safeParse(value),
    bearer
  );
  if (!registered.ok) return upstreamFailure(registered);

  const established = await apiPost(
    env,
    '/session/browser-hub/establish',
    {},
    (value) => browserHubHandleResponseSchema.safeParse(value),
    bearer
  );
  if (!established.ok) return upstreamFailure(established);

  const resolved = await apiPost(
    env,
    '/session/browser-hub/resolve',
    { handle: established.data.handle },
    (value) => browserHubResolveResponseSchema.safeParse(value)
  );
  if (!resolved.ok) return upstreamFailure(resolved);

  return sessionResponse(resolved.data, hubCookieHeader(established.data.handle));
}

/**
 * POST /hub/rotate — replace the handle this browser holds.
 *
 * A sensitive-transition control, exposed so the SPA can invoke it after one
 * (adding a second person to the browser, for instance) without the page ever
 * seeing either the old handle or the new one.
 */
export async function handleHubRotate(request: Request, env: HubEnv): Promise<Response> {
  const rejected = guard(request);
  if (rejected) return rejected;

  const handle = readHubHandle(request);
  if (!handle) return signedOutResponse(false);

  const rotated = await apiPost(
    env,
    '/session/browser-hub/rotate',
    { handle },
    (value) => browserHubHandleResponseSchema.safeParse(value)
  );
  if (!rotated.ok) return signedOutResponse(rotated.code === 'invalid_handle');

  const resolved = await apiPost(
    env,
    '/session/browser-hub/resolve',
    { handle: rotated.data.handle },
    (value) => browserHubResolveResponseSchema.safeParse(value)
  );
  if (!resolved.ok) return upstreamFailure(resolved);

  return sessionResponse(resolved.data, hubCookieHeader(rotated.data.handle));
}

/**
 * POST /hub/revoke — sign out of `auth.oxy.so`.
 *
 * Clears the hub credential server-side and the cookie in the same response.
 * The browser's DeviceSession, its principals and every app already joined to it
 * are untouched; revoking the whole device is `POST /session/device/signout`
 * with `{ all: true }`, which sweeps the hub columns as part of the same
 * transaction.
 *
 * The cookie is cleared even when the upstream call fails. The alternative —
 * leaving a cookie the user asked to be rid of because a network hop was down —
 * is the wrong side to fail on, and the handle is single-purpose: a cookie-less
 * browser cannot present it again from any surface.
 */
export async function handleHubRevoke(request: Request, env: HubEnv): Promise<Response> {
  const rejected = guard(request);
  if (rejected) return rejected;

  const handle = readHubHandle(request);
  if (handle) {
    await apiPost(env, '/session/browser-hub/revoke', { handle }, (value) =>
      browserHubRevokeResponseSchema.safeParse(value)
    );
  }
  return signedOutResponse(true);
}

/**
 * POST /hub/activate — make one `principal acting as account` globally active.
 *
 * The IdP's account chooser needs this: which context a joining application is
 * handed is the user's choice, and the choice is a device-wide one (ADR 0002).
 * The edge forwards the `contextId` with the browser's own bearer, so the
 * server's authorization checks apply unchanged and the SPA still holds no
 * token.
 */
export async function handleHubActivate(request: Request, env: HubEnv): Promise<Response> {
  const rejected = guard(request);
  if (rejected) return rejected;

  const parsedBody = hubActivateRequestSchema.safeParse(await readJsonBody(request));
  if (!parsedBody.success) {
    return jsonResponse({ error: 'invalid_request' }, { status: 400 });
  }

  const outcome = await resolveFromCookie(request, env);
  if (!outcome.ok) return signedOutResponse(outcome.clearCookie);

  const activated = await apiPost(
    env,
    '/session/device/activate',
    { contextId: parsedBody.data.contextId },
    // The activation response carries the post-transition directory AND a
    // bearer for the newly active context. Only the directory leaves this
    // function; the bearer stops here, like every other one.
    (value) => deviceActivateResponseSchema.safeParse(value),
    outcome.resolved.accessToken
  );
  if (!activated.ok) return upstreamFailure(activated);

  const body: HubSession = { status: 'active', directory: activated.data.directory };
  return jsonResponse(body);
}

/**
 * POST /hub/authorize — a later official origin joining the browser's session.
 *
 * The whole point of the phase: when the hub session exists, an official app
 * that has never seen this browser gets an authorization code without a QR, a
 * password or a passkey ceremony. The code is minted by the ordinary
 * `POST /auth/oauth/authorize` — the same exact-match redirect validation, the
 * same PKCE binding, the same single-use hashed code, the same `AppGrant`
 * recording — with the browser's own bearer, so nothing about the OAuth
 * guarantees is special-cased here.
 *
 * ## Consent is re-read from the server on BOTH passes
 *
 * The first pass asks `GET /auth/oauth/consent` and, when the answer is "ask",
 * returns `consent_required` and mints nothing. The user's "Allow" comes back as
 * `approve: true` — and the consent decision is fetched AGAIN rather than
 * remembered, because remembering it would mean the first response's verdict
 * decided the second request's authority. The registry-based trust rule
 * (`isTrustedApplication`) is the server's throughout; the edge never decides
 * that an app may skip consent.
 *
 * ## `prompt=none` cannot be expressed here
 *
 * There is no `prompt` field on {@link hubAuthorizeRequestSchema}, so a silent
 * loop has nothing to travel in. The IdP's refusal of an `authorize?prompt=none`
 * that arrives by other means is unchanged and stays a visible terminal screen.
 */
export async function handleHubAuthorize(request: Request, env: HubEnv): Promise<Response> {
  const rejected = guard(request);
  if (rejected) return rejected;

  const parsedBody = hubAuthorizeRequestSchema.safeParse(await readJsonBody(request));
  if (!parsedBody.success) {
    return jsonResponse({ error: 'invalid_request' }, { status: 400 });
  }
  const { clientId, redirectUri, state, codeChallenge, scope, approve } = parsedBody.data;

  const outcome = await resolveFromCookie(request, env);
  if (!outcome.ok) {
    const body: HubAuthorizeResult = { status: 'signed_out' };
    return jsonResponse(
      body,
      outcome.clearCookie ? { setCookie: clearedHubCookieHeader() } : undefined
    );
  }
  const bearer = outcome.resolved.accessToken;

  const consentQuery = new URLSearchParams({ clientId, redirectUri });
  if (scope) consentQuery.set('scope', scope);
  const consent = await apiGet(
    env,
    `/auth/oauth/consent?${consentQuery.toString()}`,
    (value) => oauthConsentDecisionSchema.safeParse(value),
    bearer
  );
  if (!consent.ok) return upstreamFailure(consent);

  if (consent.data.consentRequired && approve !== true) {
    const body: HubAuthorizeResult = {
      status: 'consent_required',
      reason: consent.data.reason,
      ...(consent.data.userConsentScopes ? { userConsentScopes: consent.data.userConsentScopes } : {}),
    };
    return jsonResponse(body);
  }

  const issued = await apiPost(
    env,
    '/auth/oauth/authorize',
    {
      clientId,
      redirectUri,
      ...(state === undefined ? {} : { state }),
      codeChallenge,
      codeChallengeMethod: 'S256',
      ...(scope === undefined ? {} : { scope }),
    },
    (value) => oauthAuthorizeCodeResponseSchema.safeParse(value),
    bearer
  );
  if (!issued.ok) return upstreamFailure(issued);

  const body: HubAuthorizeResult = {
    status: 'code',
    code: issued.data.code,
    state: issued.data.state,
    redirectUri: issued.data.redirectUri,
    expiresIn: issued.data.expiresIn,
  };
  return jsonResponse(body);
}

/**
 * Report an upstream failure without becoming a proxy for it.
 *
 * The API's own code travels (the SPA has to tell "you may not use this client"
 * apart from "the network is down"), but the status is collapsed to one of two:
 * anything the API called a client error is 400 here, and everything else is
 * 502. Passing an upstream 401 through would make the SPA's own fetch layer
 * treat the IdP as having rejected ITS credentials, which it has not — the
 * browser's credential is the cookie, and its verdict is carried by the typed
 * `signed_out` body instead.
 */
function upstreamFailure(result: UpstreamFailure): Response {
  const status = result.status >= 400 && result.status < 500 ? 400 : 502;
  return jsonResponse({ error: result.code }, { status });
}
