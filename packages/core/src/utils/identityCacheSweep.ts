/**
 * THE enumeration of `OxyServices` GET-cache keys that can carry a single
 * account's identity, and the one sweep that clears them.
 *
 * WHY THIS IS ONE LIST
 * --------------------
 * An Oxy account is readable under SEVERAL cache keys, and a write that only
 * busts the key it happens to know about leaves every other one serving the
 * pre-write snapshot for up to its TTL — from the caller's OWN in-memory cache,
 * with a perfectly healthy server. That failure has already shipped twice with
 * two different sets of keys:
 *
 *   - `updateAccount` busted `GET:/accounts/<id>` and the account lists, but a
 *     profile screen reads `GET:/profiles/username/<name>` and
 *     `GET:/users/<id>`, so a channel's new picture stayed invisible for the
 *     full 5-minute profile TTL.
 *   - `updateProfile` busted four of the six keys below, missing
 *     `GET:/auth/lookup/` (the login-flow avatar/display-name lookup) and
 *     `GET:/profiles/resolve` (handle resolution) — two independently-drifted
 *     copies of a list that has to agree.
 *
 * So the list lives here, once, and every writer calls
 * {@link evictOxyIdentityCache}. Adding a new identity read means adding its key
 * HERE and every writer inherits it.
 *
 * WHERE THE LINE IS DRAWN
 * -----------------------
 * These are the SINGLE-PROFILE reads — the account is the subject of the
 * response and is addressable by id, handle, or session. Reads that merely
 * CONTAIN an account among many (`GET:/profiles/search`,
 * `GET:/users/<other>/followers`, `GET:/profiles/<other>/similar`) are
 * deliberately NOT swept: an account cannot be located in them without the very
 * lookup being invalidated, so sweeping them means sweeping the whole namespace
 * on every identity change — a real cost on a backend consuming the
 * cross-service invalidation signal, for a surface where a stale thumbnail
 * expires on its own in ~2 minutes.
 *
 * WHY PREFIXES RATHER THAN EXACT KEYS
 * -----------------------------------
 * Only the by-id key can be built from a user id. The handle-keyed and
 * session-keyed entries cannot — deriving a handle from an id needs the lookup
 * we are invalidating, and the SDK never tracks active session ids centrally.
 * Prefix sweeping is also what makes a USERNAME CHANGE correct: the entry under
 * the OLD handle is unreachable by construction (nothing in the write response
 * carries it), and a sweep targeted at the new handle alone would leave the old
 * one serving the pre-rename profile until its TTL. Over-eviction costs a
 * refetch; under-eviction serves wrong data.
 *
 * Platform-neutral by construction (no imports, no `OxyServices` reference) so
 * the client mixins and the Node-only `@oxyhq/core/server` invalidation
 * subscriber can share it without either pulling in the other.
 */

/**
 * The cache-eviction surface of an `OxyServices` instance. Declared
 * structurally so this module stays free of any client import.
 */
export interface OxyIdentityCacheEvictor {
  clearCacheEntry(key: string): void;
  clearCacheByPrefix(prefix: string): number;
}

/**
 * Cache-key PREFIXES under which an account's identity can be served, for the
 * reads whose key cannot be derived from a user id. Swept wholesale.
 */
export const OXY_IDENTITY_CACHE_PREFIXES: readonly string[] = [
  // `getUserBySession` — keyed by session id, which the SDK never enumerates.
  'GET:/session/user/',
  // `getCurrentUser` (and `GET:/users/me/graph`, harmlessly included).
  'GET:/users/me',
  // `lookupUsername` — the pre-session login lookup; carries avatar + display name.
  'GET:/auth/lookup/',
  // `getProfileByUsername` — keyed by handle, including the pre-rename handle.
  'GET:/profiles/username/',
  // `resolveProfile` — keyed by fediverse handle in the query payload.
  'GET:/profiles/resolve',
];

/**
 * Build the exact cache key `getUserById` reads under. The only identity key
 * derivable from a user id, so the only one that does not need a prefix sweep.
 */
export function oxyUserByIdCacheKey(userId: string): string {
  return `GET:/users/${userId}`;
}

/**
 * Sweep an `OxyServices` GET response cache of everything that could carry the
 * given account's identity.
 *
 * @param oxy    - Anything exposing the SDK's two eviction methods.
 * @param userId - The account whose by-id entry to drop. Optional: a caller
 *                 that does not know the id still clears every handle-, session-
 *                 and self-keyed entry, which is the majority of the surface.
 */
export function evictOxyIdentityCache(oxy: OxyIdentityCacheEvictor, userId?: string): void {
  for (const prefix of OXY_IDENTITY_CACHE_PREFIXES) {
    oxy.clearCacheByPrefix(prefix);
  }
  if (userId) {
    oxy.clearCacheEntry(oxyUserByIdCacheKey(userId));
  }
}
