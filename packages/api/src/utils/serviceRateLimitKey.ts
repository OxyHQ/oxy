import type { Request } from 'express';
import { hashedIpKey } from './ipKey';

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

/** A credential public key: its alphabet, at a length a Redis key can carry. */
const PUBLIC_KEY_SHAPE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The key-pair mint is charged to the CREDENTIAL it names, not to the address
 * it came from.
 *
 * Keyed on the address, this was ten mints per five minutes for every service
 * behind the cluster's NAT together — the same pooling the workload mint was
 * moved off on 2026-09-19, left in place for the key pair — so one service's
 * deploy spent another's next hourly token. Keyed on the `apiKey`, a service's budget is its
 * own, and a guess against a given credential is bounded no matter how many
 * addresses it is spread across, which an address key never did. The secret is
 * 32 random bytes; this budget is a bound on a runaway, not the thing keeping a
 * secret secret.
 *
 * The key is the presented `apiKey`, UNVERIFIED — this runs before the lookup,
 * so a flood of invented keys would each get a fresh bucket. That is what the
 * mint's per-address ceiling (`serviceTokenAddressLimiter`, `routes/auth.ts`)
 * is for. The `apiKey` is the credential's PUBLIC key (`apiSecret` is the
 * secret), so it is used as-is rather than hashed: a hash of a public value
 * protects nothing and reads to a scanner as a weakly hashed password. Only a
 * key of the credential alphabet and a bounded length gets a bucket of its own,
 * which keeps the Redis key bounded; anything else — absent, oversized or
 * malformed, all of which the handler refuses — falls back to its address.
 */
export function serviceTokenMintRateLimitKey(req: Request): string {
  const apiKey = (req.body as { apiKey?: unknown } | undefined)?.apiKey;
  if (typeof apiKey !== 'string' || !PUBLIC_KEY_SHAPE.test(apiKey)) return `addr:${hashedIpKey(req)}`;
  return `key:${apiKey}`;
}
