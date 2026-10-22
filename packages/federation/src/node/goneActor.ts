/**
 * A DELETED local actor, as the fediverse is told about it.
 *
 * Two halves, following Mastodon's account deletion:
 *
 *  1. Once, the app sends `Delete{actor}`: the actor deletes itself, signed with
 *     its own key, to every follower's (shared) inbox. That is
 *     `DeliveryService.federateActorDelete`, built by {@link buildActorDeleteActivity}.
 *  2. From then on the actor's URLs answer `410 Gone` instead of `404`. That is
 *     what a server that missed the Delete, or never acts on one, reads as
 *     permanent: Mastodon deletes its copy of an account whose WebFinger answers
 *     410, and Lemmy, PieFed and Mbin mark a community or person deleted when a
 *     refetch answers 410 or a `Tombstone`. A 404 tells all of them nothing, so
 *     they keep the ghost profile and keep delivering to it.
 *
 * The routers ask the app's `isActorGone(username)` only after `resolveUser`
 * found nobody, so a live account is never answered as gone.
 */

import { AP_CONTEXT } from '../apContext';

/** Does `username` name a local actor that was deleted? Asked only for a username that resolved to nobody. */
export type IsActorGone = (username: string) => Promise<boolean>;

/** The body of a `410 Gone` for a deleted object: a bare `Tombstone` naming it. */
export function goneTombstone(id: string): Record<string, unknown> {
  return { '@context': AP_CONTEXT, id, type: 'Tombstone' };
}

/**
 * The actor's `Delete` of itself. The id is DETERMINISTIC (no timestamp), the
 * shape Mastodon sends (`<actor>#delete`), so a retried run re-sends the same
 * activity and a delivery queue that dedupes on activity id + inbox sends each
 * inbox one copy.
 */
export function buildActorDeleteActivity(actorUri: string): Record<string, unknown> {
  return {
    '@context': AP_CONTEXT,
    id: `${actorUri}#delete`,
    type: 'Delete',
    actor: actorUri,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    object: actorUri,
  };
}
