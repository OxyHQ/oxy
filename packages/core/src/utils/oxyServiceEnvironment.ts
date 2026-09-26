/**
 * Environment segregation for Oxy service-token JWTs (test/live isolation).
 * Mirrors `ApplicationCredentialEnvironment` on the API's `ApplicationCredential`
 * model (`packages/api/src/models/ApplicationCredential.ts`) as an INDEPENDENT
 * literal union — `@oxy.so/core` has zero dependency on `@oxy.so/api`, so this is
 * kept in sync by hand, not by import.
 *
 * Defined here, with zero imports, so the server middleware and any
 * client-safe code can both depend on it without the client reaching the
 * Node-only `server/` modules.
 */
export const OXY_SERVICE_ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type OxyServiceEnvironment = (typeof OXY_SERVICE_ENVIRONMENTS)[number];
