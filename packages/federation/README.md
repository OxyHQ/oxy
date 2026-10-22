# Oxy federation

## Authorizing outbound delivery

`createDeliveryService({ authorizeDelivery })` optionally checks live application
policy before signing or queueing an activity. It receives `activity` and the
trusted `senderAccountId` supplied by the app or persisted delivery job. Never
infer that identity from an activity URL or a key ID. Follower fanout checks once
for the batch; each later worker delivery checks again.

Return `true` to allow or `false` for a definitive refusal. A refusal throws
`DeliveryAuthorizationDeniedError`: a durable worker should mark the job
suppressed (or permanently failed), without marking it delivered or retrying it.
Other thrown errors are transient authority failures and should follow the
worker's normal bounded retry policy. Neither path signs or sends the activity.
Do not catch an authority failure and retry through an unguarded transport.

Without the optional hook, delivery behavior is unchanged. `sendUndoFollow`'s
boolean reports local relationship removal; it does not confirm remote delivery.

## Discovery response caching

`createWebfingerRouter({ httpCacheTtlSeconds })` controls HTTP caching of fresh,
cached and instance WebFinger responses. The default remains 3600 seconds.
`createActorRouter` accepts the same option for human and instance actor
responses, retaining its existing 1800-second default.
Use `0` for `Cache-Control: no-store` when live privacy decisions must govern
each request. Only whole seconds from 0 through 86400 are accepted. This does
not change the injected JRD cache: applications must also authorize its reads
and their user resolver against current policy. It cannot retract documents
already cached by remote consumers before this setting changes.

## Deleted actors

When a local account is deleted, tell the fediverse once and then answer as
gone, the way Mastodon handles account deletion:

1. Call `deliveryService.federateActorDelete(oxyUserId, username)` BEFORE
   deleting the account's accepted follower rows, since they are its
   recipients. It sends the actor's `Delete` of itself (`<actor>#delete`, a
   deterministic id, so a retried run does not fan out twice) to each follower
   shared inbox, signed with the actor's own key. The key must therefore still
   be signable at send time; Oxy keeps it after the account is gone.
2. Pass `isActorGone(username)` to `createActorRouter` and
   `createWebfingerRouter`. It is asked only for a username `resolveUser` found
   nobody for. True answers `410 Gone` instead of 404 on the actor (with a
   `Tombstone` body), its inbox, its collections and WebFinger. Mastodon deletes
   an account whose WebFinger answers 410; Lemmy, PieFed and Mbin mark an actor
   deleted when a refetch answers 410. A 404 tells none of them anything.

The app's own content routes (outbox, posts) can answer the same way with
`goneTombstone(id)`.

## Community collections

A local `Group` (an account whose kind is `community`, see
`isGroupActorKind`) serves its outbox and followers in the shapes Lemmy
deserializes, because Lemmy and PieFed read neither paging nor `first`:

- **Outbox:** one `OrderedCollection` with its latest `GROUP_OUTBOX_SIZE` (50)
  `Announce { Create }` activities inline in `orderedItems`. The outbox is an
  app content route; build it with `groupOutboxCollection`.
- **Followers:** `createActorRouter` serves a `Collection` with `totalItems` and
  `items: []`, the count without the list, as Lemmy does
  (`groupFollowersCollection`).

Every other actor keeps the paged `OrderedCollection` that Mastodon walks.
