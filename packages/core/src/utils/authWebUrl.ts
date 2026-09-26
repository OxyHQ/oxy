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
 * The IdP's origin, `auth.oxy.so` — the OAuth authorize/consent surface and the
 * one origin that asserts Oxy passkeys: where a person signs in, creates,
 * recovers or deletes a web account, in the window an app opens (ADR 0029).
 * Apps open it; they never run the passkey themselves.
 */
export const AUTH_WEB_ORIGIN = `https://auth.${CENTRAL_IDP_APEX}`;
