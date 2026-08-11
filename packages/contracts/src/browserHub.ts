import { z } from 'zod';
import { deviceDirectorySchema } from './deviceDirectory';

/**
 * The browser DeviceSession hub at `auth.oxy.so` (issue #937, Phase 5, ADR 0003).
 *
 * Two wire surfaces live in this file and they are deliberately different
 * shapes, because they answer to different callers:
 *
 *  - The `browserHub*` schemas below the first divider are the API's
 *    (`api.oxy.so/session/browser-hub/*`), spoken ONLY by the IdP's own
 *    server/edge layer. They carry the raw handle and a bearer, so nothing that
 *    speaks them may run in a browser.
 *  - The `hub*` schemas below the second divider are the EDGE's
 *    (`auth.oxy.so/hub/*`), spoken by the IdP SPA. They carry neither: the
 *    handle stays in an `HttpOnly` cookie the script cannot read, and the
 *    device-wide bearer stays at the edge.
 *
 * That split is the whole point of the phase. A single schema covering both
 * would let a refactor move a credential across the boundary without any type
 * changing shape.
 *
 * ## What is NOT reopened here
 *
 * Relying-party origins remain zero-cookie: they keep `{deviceId,
 * deviceSecret}` + `POST /session/device/token` and set no cookie of any kind.
 * `auth.oxy.so` alone holds a handle, first-party only. There is no
 * refresh-token family and no bootstrap hop.
 */

/* -------------------------------------------------------------------------- */
/*  The cookie                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The one cookie name, `__Host-` prefixed.
 *
 * The prefix is not decoration: a browser refuses to store a `__Host-` cookie
 * that carries a `Domain` attribute or a `Path` other than `/`, or that arrives
 * without `Secure`. So the name itself is what makes "bound to `auth.oxy.so`
 * alone, readable by no other `oxy.so` host" enforced by the client rather than
 * merely intended by the server — including against a compromised sibling
 * subdomain, which is the specific attack `Domain=.oxy.so` would have opened.
 */
export const BROWSER_HUB_COOKIE_NAME = '__Host-oxy-device';

/**
 * The exact attribute set the edge sets, in the order it writes them.
 *
 * Held as data rather than as a template string so a test can assert the set
 * rather than a rendered line, and so removing one attribute is a diff to a
 * named constant instead of an edit inside a string literal.
 *
 * `Max-Age` is deliberately NOT in this list — see
 * {@link BROWSER_HUB_HANDLE_TTL_MS}, which the edge appends. Everything here is
 * a SECURITY attribute and none of them is ever conditional.
 */
export const BROWSER_HUB_COOKIE_ATTRIBUTES = ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/'] as const;

/**
 * How long a hub handle lives, server-side and in the cookie alike.
 *
 * Thirty days. The cookie's `Max-Age` is derived from this same constant so the
 * two cannot disagree: a cookie outliving its credential produces a browser that
 * believes it is signed in and is refused on every call, and a credential
 * outliving its cookie leaves an un-addressable row alive on the server.
 *
 * A hub handle is NOT a session cookie (one with no `Max-Age`, discarded when
 * the browser closes). It cannot be: the thing it identifies is the browser
 * PROFILE's device session, and a device session that evaporates when the user
 * quits their browser would send them back to a QR scan every morning — the
 * exact failure ADR 0003 exists to remove.
 */
export const BROWSER_HUB_HANDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/*  api.oxy.so/session/browser-hub/*  —  spoken by the edge, never a browser   */
/* -------------------------------------------------------------------------- */

/**
 * The raw handle, as it travels between the edge and the API.
 *
 * An opaque base64url random value and NOTHING else — no token, no user id, no
 * device id, no account id, no serialized state. The server stores only
 * `sha256(handle)`, so a dump of the column cannot address a browser.
 *
 * The minimum length is a floor against an empty or truncated value reaching a
 * hash comparison, not a statement about the entropy: that is fixed by the
 * issuer (`BROWSER_HUB_HANDLE_BYTES` in the API), and a handle is the only
 * credential in this flow, so it is 256 bits.
 */
export const browserHubHandleSchema = z.string().min(32);

/** Request body of every handle-presenting API endpoint. */
export const browserHubHandleRequestSchema = z.object({
  handle: browserHubHandleSchema,
});

/**
 * Response of `POST /session/browser-hub/establish` and `.../rotate`.
 *
 * The raw handle is returned exactly ONCE, to the edge, which puts it straight
 * into the cookie and keeps no copy. It is never logged, never re-readable, and
 * never reaches the browser's script context.
 */
export const browserHubHandleResponseSchema = z.object({
  handle: browserHubHandleSchema,
  expiresAt: z.string(),
});

/**
 * Response of `POST /session/browser-hub/resolve` — the browser's device
 * session, resolved from the handle alone.
 *
 * Carries a bearer because the edge needs one to run the authorize lane on the
 * browser's behalf. It is the ordinary short-lived access token of the device's
 * active context, and it stops at the edge.
 */
export const browserHubResolveResponseSchema = z.object({
  accessToken: z.string().min(1),
  expiresAt: z.string(),
  directory: deviceDirectorySchema,
});

/**
 * Why a handle did not resolve. A CLOSED set, and deliberately coarse.
 *
 *  - `invalid_handle`    — unknown, expired, or revoked. One code for all
 *                          three: distinguishing them would tell a caller
 *                          holding a guessed value whether it ever existed.
 *  - `no_active_session` — the handle is good and the device has nothing live
 *                          to mint for. The credential is NOT revoked; the
 *                          browser re-authenticates and keeps its cookie.
 */
export const browserHubErrorSchema = z.enum(['invalid_handle', 'no_active_session']);

/** Response of `POST /session/browser-hub/revoke`. Idempotent by construction. */
export const browserHubRevokeResponseSchema = z.object({
  revoked: z.boolean(),
});

/* -------------------------------------------------------------------------- */
/*  auth.oxy.so/hub/*  —  spoken by the IdP SPA                                */
/* -------------------------------------------------------------------------- */

/**
 * What the SPA is allowed to know about the hub session.
 *
 * `signed_out` covers "no cookie", "cookie present but the handle no longer
 * resolves" and "resolved, but the device has nothing live" — from the script's
 * side those are one state, and collapsing them here is what stops a UI from
 * branching on a distinction it must not act on.
 *
 * `active` carries the DIRECTORY and no credential. A switcher renders from it;
 * nothing in it can be spent against the API. The bearer that produced it never
 * left the edge.
 */
export const hubSessionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('signed_out') }),
  z.object({ status: z.literal('active'), directory: deviceDirectorySchema }),
]);

/** Request body of `POST /hub/claim` — the Commons approval lane's handoff. */
export const hubClaimRequestSchema = z.object({
  /**
   * The secret `sessionToken` of an approved `AuthSession`, held only by the
   * page that created it. The edge spends it server-side: the access token and
   * device secret the claim yields are consumed to establish the hub and are
   * then discarded, so neither is ever returned to the script.
   */
  sessionToken: z.string().min(1),
});

/** Request body of `POST /hub/activate` — pick the globally active context. */
export const hubActivateRequestSchema = z.object({
  contextId: z.string().min(1),
});

/**
 * Request body of `POST /hub/authorize` — a later official origin joining.
 *
 * There is no `prompt` field, and that is not an omission. `'none'` is absent
 * from `buildOAuthAuthorizeUrl`'s union in `@oxyhq/core` precisely so a silent
 * loop cannot be rebuilt in one line, and this endpoint would be the second
 * place to rebuild it. A caller that needs a login or consent prompt gets one
 * by not passing `approve`.
 */
export const hubAuthorizeRequestSchema = z.object({
  clientId: z.string().min(1),
  redirectUri: z.string().url(),
  state: z.string().optional(),
  codeChallenge: z.string().min(1),
  /** S256 only. `plain` is refused before the request leaves the edge. */
  codeChallengeMethod: z.literal('S256'),
  scope: z.string().optional(),
  /**
   * The user's explicit answer on the consent screen.
   *
   * Absent or `false` means "tell me whether consent is needed"; the edge then
   * returns `consent_required` and mints nothing. Only `true` may mint, and only
   * the consent screen's own button sends it — which is why the decision of
   * WHETHER consent is required is re-read from the server on both passes rather
   * than remembered from the first.
   */
  approve: z.boolean().optional(),
});

/**
 * Result of `POST /hub/authorize`.
 *
 * `signed_out` is the honest answer for a browser with no hub session: the SPA
 * runs the ordinary Commons-first authentication and tries again. It is never a
 * redirect the edge performs on the browser's behalf — no automatic chain
 * across Oxy origins, and nothing here can be hidden inside an iframe.
 */
export const hubAuthorizeResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('signed_out') }),
  z.object({
    status: z.literal('consent_required'),
    reason: z.enum(['new', 'scope_changed']),
    userConsentScopes: z.array(z.string()).optional(),
  }),
  z.object({
    status: z.literal('code'),
    code: z.string().min(1),
    state: z.string().nullable(),
    redirectUri: z.string(),
    expiresIn: z.number().int().positive(),
  }),
]);

export type BrowserHubHandleRequest = z.infer<typeof browserHubHandleRequestSchema>;
export type BrowserHubHandleResponse = z.infer<typeof browserHubHandleResponseSchema>;
export type BrowserHubResolveResponse = z.infer<typeof browserHubResolveResponseSchema>;
export type BrowserHubError = z.infer<typeof browserHubErrorSchema>;
export type BrowserHubRevokeResponse = z.infer<typeof browserHubRevokeResponseSchema>;
export type HubSession = z.infer<typeof hubSessionSchema>;
export type HubClaimRequest = z.infer<typeof hubClaimRequestSchema>;
export type HubActivateRequest = z.infer<typeof hubActivateRequestSchema>;
export type HubAuthorizeRequest = z.infer<typeof hubAuthorizeRequestSchema>;
export type HubAuthorizeResult = z.infer<typeof hubAuthorizeResultSchema>;
