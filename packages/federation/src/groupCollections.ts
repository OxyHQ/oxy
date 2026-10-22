/**
 * How a local `Group` (an Oxy community) publishes its outbox and followers:
 * the shapes Lemmy itself serves and reads back, not the paged
 * `OrderedCollection` + `first` link every other local actor serves.
 *
 * Lemmy deserializes a community's collections into fixed structs that know
 * nothing of paging (`crates/apub/apub/src/protocol/collections/`):
 *  - outbox → `GroupOutbox { orderedItems: Vec<Announce> }`, `orderedItems`
 *    REQUIRED inline. A summary with only `first` fails to parse, so a server
 *    discovering the community backfills nothing. PieFed reads the same inline
 *    `orderedItems` and nothing else.
 *  - followers → `GroupFollowers { type: "Collection", totalItems, items }`,
 *    read for the subscriber count. Lemmy serves `items: []`, so the follower
 *    list stays private; this does the same.
 *
 * Mastodon reads `totalItems` from either shape, so a `Group` followed from
 * Mastodon keeps its counts. `Person`, `Organization` and `Service` actors keep
 * the paged shape Mastodon walks.
 */

import { LOCAL_ACTOR_TYPE_BY_ACCOUNT_KIND, localActorTypeForAccountKind } from './actorObject';
import { AP_CONTEXT } from './apContext';

/** How many of its latest `Announce`s a `Group`'s outbox lists inline (Lemmy's own size). */
export const GROUP_OUTBOX_SIZE = 50;

/**
 * Whether a local account of this kind is announced as a `Group`
 * ({@link LOCAL_ACTOR_TYPE_BY_ACCOUNT_KIND}) and so serves the Group
 * collections: moderators, and the outbox and followers in the shapes above.
 */
export function isGroupActorKind(kind: unknown): boolean {
  return localActorTypeForAccountKind(kind) === LOCAL_ACTOR_TYPE_BY_ACCOUNT_KIND.community;
}

/**
 * A `Group`'s outbox: one unpaged `OrderedCollection` of its latest
 * `Announce { Create }` activities, newest first. Each item's own `@context` is
 * dropped; the collection's covers it.
 */
export function groupOutboxCollection(params: {
  id: string;
  totalItems: number;
  orderedItems: readonly Record<string, unknown>[];
}): Record<string, unknown> {
  return {
    '@context': AP_CONTEXT,
    id: params.id,
    type: 'OrderedCollection',
    totalItems: params.totalItems,
    orderedItems: params.orderedItems.map(({ '@context': _context, ...item }) => item),
  };
}

/** A `Group`'s followers: the count, and an empty `items` list. */
export function groupFollowersCollection(params: {
  id: string;
  totalItems: number;
}): Record<string, unknown> {
  return {
    '@context': AP_CONTEXT,
    id: params.id,
    type: 'Collection',
    totalItems: params.totalItems,
    items: [],
  };
}
