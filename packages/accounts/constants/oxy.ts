/**
 * Oxy platform integration constants for the accounts app.
 */

/**
 * Public OAuth client id for this app (the registered `ApplicationCredential`
 * publicKey). Drives the #214 app-identity flow when passed to `OxyProvider`.
 * Public value — safe to commit. Overridable per environment via
 * `EXPO_PUBLIC_OXY_CLIENT_ID`.
 */
export const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ||
  'oxy_dk_00f0e5d5a2e4697740a476d3cfc54f4490f01245d0d2dd05';

/** Registered OAuth redirect surface for this web origin (exact match). */
export const OXY_AUTH_REDIRECT_URI =
  process.env.EXPO_PUBLIC_OXY_AUTH_REDIRECT_URI || 'https://accounts.oxy.so';

/**
 * Deep link into the Commons app's delete-account flow. Account deletion is
 * key-gated (the API verifies a signature over `delete:<publicKey>:<ts>`), and
 * the private key lives in Commons — never in this management-only app. The
 * delete entry point in Accounts therefore hands off to Commons via its custom
 * scheme. Overridable per environment via `EXPO_PUBLIC_COMMONS_DELETE_URL`.
 */
export const COMMONS_DELETE_ACCOUNT_URL =
  process.env.EXPO_PUBLIC_COMMONS_DELETE_URL ?? 'commons://delete-account';
