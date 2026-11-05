/**
 * The rate-limit bucket a LIVE service principal is charged to.
 *
 * Every Oxy service in the cluster leaves through one NAT address, so a limiter
 * keyed on the caller's address pools all of them into one bucket: one app's
 * burst becomes every other app's 429, and nothing in Oxy's own logs says so.
 * A route that has already resolved WHICH application credential is calling
 * charges that credential instead, and keeps the address bucket for callers it
 * could not resolve.
 *
 * Application AND credential, because either alone is wrong: the credential id
 * alone would let two applications' handles collide in a shared namespace, and
 * the application alone would let one runaway credential spend its siblings'
 * budget. An attested caller's `wl_…` handle is its credential id here.
 *
 * Deliberately NOT in `middleware/rateLimiter.ts`: dozens of route suites mock
 * that module wholesale with only `rateLimit`, and a key function living beside
 * it would silently become `undefined` under every one of those mocks.
 */
export interface RateLimitedServicePrincipal {
  readonly appId: string;
  readonly credentialId: string;
}

/** Exact live service credential bucket; never a shared NAT/IP bucket. */
export function serviceRateLimitKey(service: RateLimitedServicePrincipal | undefined): string {
  return service ? `${service.appId}:${service.credentialId}` : 'missing-service-principal';
}
