/**
 * Environment segregation for Oxy service-token JWTs (test/live isolation).
 * Mirrors `ApplicationCredentialEnvironment` on the API's `ApplicationCredential`
 * model (`packages/api/src/models/ApplicationCredential.ts`) as an INDEPENDENT
 * literal union — `@oxy.so/core` has zero dependency on `@oxy.so/api`, so this is
 * kept in sync by hand, not by import.
 *
 * Defined here (not in `server/auth.ts` or `mixins/OxyServices.utility.ts`
 * directly) because BOTH of those files need it and neither may import from
 * the other: `server/` types import `express` (Node-only, a peer dependency
 * `mixins/` deliberately avoids so it stays safe to bundle into RN/browser
 * consumers — see the "Local request/response/socket typing" comment in
 * `OxyServices.utility.ts`). This file has zero imports, so both sides can
 * depend on it without crossing that boundary.
 */
export const OXY_SERVICE_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type OxyServiceEnvironment = (typeof OXY_SERVICE_ENVIRONMENTS)[number];
