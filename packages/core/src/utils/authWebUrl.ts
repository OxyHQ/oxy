/**
 * Central IdP apex constant.
 *
 * The client SSO/FedCM resolvers (`resolveCentralAuthUrl`, `CENTRAL_AUTH_URL`)
 * were removed in the device-first / legacy-final cutovers. The lone survivor is
 * `CENTRAL_IDP_APEX`, kept because it has a LIVE consumer —
 * `@oxy.so/core/server`'s CORS helper (`server/cors.ts`'s `createOxyCors`)
 * auto-allows `*.oxy.so` from it. That CORS use is permanent, so this stays
 * past the SSO/FedCM teardown.
 */

/**
 * The registrable apex (eTLD+1) of the Oxy ecosystem's central Identity
 * Provider, reachable at `auth.${CENTRAL_IDP_APEX}`. Single source of truth so
 * the CORS helper (and anything else that needs the central apex) never drifts.
 */
export const CENTRAL_IDP_APEX = 'oxy.so';

/**
 * The IdP's origin, `auth.oxy.so` — the OAuth authorize/consent surface for
 * third parties, the browser bridge (ADR 0029 D2) and the page an email
 * sign-in link opens. Official apps sign in inside their own dialog (ADR 0030).
 */
export const AUTH_WEB_ORIGIN = `https://auth.${CENTRAL_IDP_APEX}`;
