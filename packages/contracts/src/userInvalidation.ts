/**
 * Canonical contract for the Oxy user-invalidation broadcast.
 *
 * Oxy owns identity, but consumers cache it: Mention keeps a Redis summary per
 * post author, and every backend using `@oxyhq/core` holds the SDK's own GET
 * response cache. Both go stale the moment a profile is edited, and neither has
 * any way to find out — the writer is a different process in a different repo.
 * This is the signal that tells them.
 *
 * The channel name and the payload shape are wire contracts between oxy-api (the
 * publisher) and every consuming backend (the subscribers), so they live here
 * rather than in either side. A hand-typed copy of the channel name fails as
 * "the invalidation never arrives" — silently, because pub/sub has no delivery
 * receipt and a message nobody is listening for is indistinguishable from a
 * message nobody sent.
 *
 * DELIVERY IS AT-MOST-ONCE, AND THAT IS THE DESIGN. Every consumer's cache still
 * carries its own TTL, so a dropped message degrades to exactly the behaviour
 * before this signal existed and never to something worse. That property is what
 * makes a bare Redis PUBLISH sufficient here and an outbox, retries, delivery
 * receipts and payload signatures unnecessary. Do not treat a received event as
 * authoritative for anything except "re-read this user from Oxy".
 *
 * PRIVACY — the payload carries NO user data, only an id, a reason and a
 * timestamp. The channel rides the shared Valkey that every Oxy backend can
 * subscribe to, so anything placed on it is readable by every service in the
 * ecosystem. Never add a name, handle, email, avatar or any profile field: a
 * subscriber that wants the new values re-reads them from Oxy through its normal
 * authenticated path, where the usual authorization applies.
 *
 * Platform-agnostic — zod only, no react/react-native/expo.
 */

import { z } from 'zod';

/** Redis pub/sub channel carrying user-invalidation events. */
export const OXY_USER_INVALIDATION_CHANNEL = 'oxy:user:invalidate';

/**
 * Why a user record changed, as classified by the writer in oxy-api.
 *
 * - `profile` — anything a consumer renders or caches as IDENTITY: display name,
 *   username, avatar, bio, verification, federation fields, account status. This
 *   is the DEFAULT for every writer, so a site that forgets to classify itself
 *   over-invalidates (correct, marginally slower) rather than under-invalidates
 *   (silently wrong). Keep that asymmetry if you add a reason.
 * - `graph` — follow-edge churn only (follower/following counts). High frequency,
 *   and bulk follow/unfollow moves up to 200 edges in one call. Nothing renders
 *   identity from it and a stale count is harmless to ranking, so it is NOT
 *   broadcast — see {@link OXY_PUBLISHED_USER_CHANGE_REASONS}.
 */
export const OXY_USER_CHANGE_REASONS = ['profile', 'graph'] as const;

export type OxyUserChangeReason = (typeof OXY_USER_CHANGE_REASONS)[number];

/**
 * The reasons that are actually put on the wire.
 *
 * A reason absent from this list is a local cache eviction in oxy-api and
 * nothing more: no message is published at all, rather than a message every
 * subscriber receives and discards. The distinction matters at bulk-follow
 * scale, where the discarded variant is a 200-message burst on a channel every
 * Oxy backend is subscribed to.
 *
 * This is deliberately a shared list rather than a check inside the publisher:
 * a subscriber needs to know what it can receive, and the schema below rejects
 * anything else, so publisher and subscriber cannot drift into disagreeing about
 * which events exist. Adding a reason therefore forces an explicit decision about
 * whether it broadcasts.
 */
export const OXY_PUBLISHED_USER_CHANGE_REASONS = ['profile'] as const;

export type PublishedOxyUserChangeReason =
  (typeof OXY_PUBLISHED_USER_CHANGE_REASONS)[number];

/** Whether a change of this kind is broadcast to consumers at all. */
export function isPublishedOxyUserChangeReason(
  reason: OxyUserChangeReason,
): reason is PublishedOxyUserChangeReason {
  return (OXY_PUBLISHED_USER_CHANGE_REASONS as readonly string[]).includes(reason);
}

/**
 * A single user-invalidation event.
 *
 * `at` is the publisher's epoch-ms clock, carried for diagnosis (measuring
 * end-to-end propagation, spotting a wedged subscriber) — never for ordering or
 * conflict resolution. Two Oxy tasks publish from unsynchronised clocks, and the
 * event says only "re-read this user", which is idempotent and order-independent.
 */
export const oxyUserInvalidationEventSchema = z.object({
  /** The Oxy user whose record changed. */
  userId: z.string().min(1),
  /** Why it changed. Only broadcast reasons appear on the wire. */
  reason: z.enum(OXY_PUBLISHED_USER_CHANGE_REASONS),
  /** Publisher's epoch-ms timestamp. Diagnostic only. */
  at: z.number().int().nonnegative(),
});

export type OxyUserInvalidationEvent = z.infer<typeof oxyUserInvalidationEventSchema>;
