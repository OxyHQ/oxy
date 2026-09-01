/**
 * Oxy platform integration constants for the Commons app.
 */

/**
 * Public OAuth client id for Commons (the registered `ApplicationCredential`
 * publicKey). Passed to `OxyProvider` so the device sign-in / `/auth/session/*`
 * flows resolve the correct registered Application identity.
 *
 * Public value — safe to commit. Overridable per environment via
 * `EXPO_PUBLIC_OXY_CLIENT_ID`.
 *
 * This is the real registered "Commons by Oxy" `ApplicationCredential` publicKey
 * (type `public`, `active`) in the Oxy workspace, minted via
 * `packages/api/scripts/register-commons-clients.ts`.
 */
export const OXY_CLIENT_ID =
  process.env.EXPO_PUBLIC_OXY_CLIENT_ID ||
  'oxy_dk_f65326da2a0d106bf98e873ce19b0ca9094d6c0c1f845a18';
