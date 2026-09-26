/**
 * Cache-key primitives for the identity-scoped HTTP GET response cache.
 *
 * Extracted from {@link HttpService} so the identity-tag derivation is a pure,
 * independently testable function with no dependency on instance/token state.
 * The HTTP service injects the live access token; everything here is
 * referentially transparent given that input.
 */

import { decodeTokenClaims } from './tokenClaims';

/**
 * Minimal JWT payload shape we read for cache scoping. The identity discriminator
 * comes from `userId` (preferred) or `id`; nothing else is consulted here.
 */
export interface CacheIdentityJwtPayload {
  userId?: string;
  id?: string;
  [key: string]: unknown;
}

/**
 * Discriminator used when there is no access token at all. Anonymous responses
 * must never collide with any authenticated identity.
 */
export const ANON_IDENTITY = 'anon';

/**
 * FNV-1a 32-bit non-cryptographic hash.
 *
 * Used by the cache-key generator for large payloads where full JSON inclusion
 * would balloon the cache map keys, and as the fallback discriminator for an
 * undecodable access token. Content-addressed: every byte of the input
 * contributes to the digest, so two inputs with the same top-level shape but
 * different field values produce different keys (the previous `keys + length`
 * heuristic collided on these).
 *
 * Trade-offs:
 *  - 32 bits is ample for an in-process cache (collision risk negligible at our
 *    key counts; we also prefix with method + url which further partitions the
 *    keyspace).
 *  - Not cryptographically secure — never use for security decisions.
 *  - Zero dependencies, branch-free hot loop, ~1 GiB/s on V8.
 */
export function fnv1a32(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h * 16777619 mod 2^32, written as shift-and-add for portability and
    // to avoid 53-bit JS number truncation in the intermediate multiply.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Derive a stable, non-sensitive identity discriminator for cache scoping.
 *
 * The GET-response cache MUST be partitioned by caller identity: endpoints with
 * optional auth (e.g. `GET /profiles/recommendations`) return different content
 * for an anonymous vs an authenticated caller, and per-user content for
 * different authenticated users. Keying solely on `method:url:data` let an
 * anonymous response be served to an authenticated caller — surfacing as
 * "Who to follow" recommending accounts the user already follows after a
 * cold-boot session restore.
 *
 * Resolution order:
 *  - no token            → {@link ANON_IDENTITY} (`'anon'`).
 *  - decodable token     → the token's `userId || id`.
 *  - undecodable token   → a short FNV-1a hash of the token, prefixed `t` so it
 *                          can never collide with `'anon'` or a real user id.
 *
 * We use the decoded user id rather than the raw JWT so the token never lands
 * in a cache key (no token leakage through any cache-key logging, no key bloat).
 * Switching into a managed account mints a REAL new session whose access token
 * carries the target account's id, so the identity tag changes naturally on a
 * switch — there is no separate acting-as discriminator to fold in.
 *
 * @param accessToken The current bearer access token, or `null` when anonymous.
 */
export function computeIdentityTag(accessToken: string | null): string {
  if (!accessToken) {
    return ANON_IDENTITY;
  }
  const decoded = decodeTokenClaims(accessToken);
  // An undecodable token is still partitioned away from anon and from other
  // tokens via a hash — never silently ANON_IDENTITY.
  return (decoded?.userId as string | undefined) || (decoded?.id as string | undefined) || `t${fnv1a32(accessToken)}`;
}
