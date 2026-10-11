/**
 * The auth app's OWN registered OAuth client id.
 *
 * For the "Sign in with Oxy" (QR) handoff the IdP is itself a relying party:
 * it asks the user's Oxy app (Commons) to approve a sign-in on a fresh
 * device-flow session. That session must be created with a REAL registered
 * `ApplicationCredential` publicKey so the API can resolve the requesting app's
 * identity on the approval screen — distinct from the per-request `?client_id=`
 * of whatever RP the IdP happens to be authorizing.
 *
 * Public value — safe to commit. Overridable per environment via
 * `VITE_OXY_CLIENT_ID`.
 *
 * This is the real registered "Oxy Auth" `ApplicationCredential` publicKey
 * (type `public`, `active`) in the Oxy workspace, minted via
 * `packages/api/scripts/register-commons-clients.ts`.
 */
export const OXY_CLIENT_ID =
  import.meta.env.VITE_OXY_CLIENT_ID || 'oxy_dk_86e915fc05782683064b255fd5bac278a5a606bd85662202';
