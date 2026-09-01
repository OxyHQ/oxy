/**
 * THE enumeration of `OxyServices` GET-cache keys that serve the ACCOUNT FOREST
 * — the caller's accessible accounts, as lists and as individual detail rows —
 * and the one sweep that clears them.
 *
 * WHY THIS IS NOT A METHOD ON THE ACCOUNTS MIXIN
 * ---------------------------------------------
 * `AccountNode.account` is a whole `User`, so a forest read embeds the very
 * profile the identity reads serve. That makes an IDENTITY write a writer of
 * these keys too: `updateProfile` edits the caller's own personal account,
 * which is a row in `GET /accounts` and is its own `GET /accounts/<id>`. Leave
 * those cached and the account switcher keeps drawing the pre-edit name and
 * picture for the full TTL, against a perfectly healthy server.
 *
 * The mixins compose into one class at runtime but are typed one at a time, so
 * the user mixin cannot call a method the accounts mixin owns. The key list
 * therefore lives here, once, and every writer calls {@link
 * evictOxyAccountForestCache} — exactly like the identity key list in
 * `identityCacheSweep`, which the accounts mixin already calls for the
 * mirror-image case (an account write staling the identity reads). The
 * alternative — a second hand-written copy of these keys in the other mixin —
 * is the drift that shipped the two stale-profile bugs `identityCacheSweep`
 * documents.
 *
 * WHY THE LIST NEEDS A PREFIX AND THE DETAIL DOES NOT
 * --------------------------------------------------
 * `listAccounts({tree?})` keys the flat list as `GET:/accounts` and every
 * option variant as `GET:/accounts?<query>` (the query string is part of the
 * URL, hence of the key), and a writer cannot enumerate which variants a caller
 * has read. The detail key, by contrast, is derivable from the account id the
 * writer already holds.
 *
 * The `GET:/accounts?` prefix matches ONLY the query-string list variants —
 * never `GET:/accounts/<id>` or its `…/members`, `…/credentials`, `…/children`
 * sub-resources, which are the accounts mixin's own business and stay there.
 */

import type { OxyIdentityCacheEvictor } from './identityCacheSweep';

/**
 * The cache-eviction surface of an `OxyServices` instance. Reused from
 * `identityCacheSweep` rather than re-declared: it is the SDK's one published
 * name for these two methods, and a second identical interface would be one
 * more shape to keep in step.
 */
export type OxyAccountCacheEvictor = OxyIdentityCacheEvictor;

/** The cache key `listAccounts()` reads under with no options. */
export const OXY_ACCOUNT_LIST_CACHE_KEY = 'GET:/accounts';

/**
 * The prefix covering every option-carrying `listAccounts(opts)` variant
 * (`?tree=true`, …), none of which a writer can enumerate.
 */
export const OXY_ACCOUNT_LIST_CACHE_QUERY_PREFIX = 'GET:/accounts?';

/**
 * Prefix covering every per-account sub-resource cache key
 * (`GET:/accounts/<id>`, `…/members`, `…/credentials`, `…/children`). A
 * membership mutation on an ancestor must sweep ALL of these, not only the
 * account named in the path: descendant member rosters embed inherited rows
 * resolved from that ancestor, and the writer cannot enumerate which descendant
 * ids a caller has already read. The trailing slash deliberately excludes the
 * forest list keys (`GET:/accounts`, `GET:/accounts?…`) documented above.
 */
export const OXY_ACCOUNT_PER_ACCOUNT_CACHE_PREFIX = 'GET:/accounts/';

/**
 * Build the exact cache key `getAccount(accountId)` reads under.
 */
export function oxyAccountDetailCacheKey(accountId: string): string {
  return `GET:/accounts/${encodeURIComponent(accountId)}`;
}

/**
 * Sweep an `OxyServices` GET response cache of the account forest.
 *
 * @param oxy       - Anything exposing the SDK's two eviction methods.
 * @param accountId - The account whose detail row to drop as well. Optional: a
 *                    writer that changed the SHAPE of the forest rather than one
 *                    account in it (create, archive, ownership transfer) has no
 *                    detail row to name, and clears only the lists.
 */
export function evictOxyAccountForestCache(
  oxy: OxyAccountCacheEvictor,
  accountId?: string,
): void {
  oxy.clearCacheEntry(OXY_ACCOUNT_LIST_CACHE_KEY);
  oxy.clearCacheByPrefix(OXY_ACCOUNT_LIST_CACHE_QUERY_PREFIX);
  if (accountId) {
    oxy.clearCacheEntry(oxyAccountDetailCacheKey(accountId));
  }
}
