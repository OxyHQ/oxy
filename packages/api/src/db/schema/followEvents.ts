/**
 * `follow_events` — the transactional outbox.
 *
 * Every mutation writes its event in the SAME transaction as the state change
 * it describes. That is the whole design: an event that could be written
 * separately is an event that can be missing, and a missing event means a
 * federation delivery that never happens, a notification that never arrives, or
 * a projection that quietly disagrees with the graph forever.
 *
 * Nothing here is delivered inline. A worker reads the table, so a slow remote
 * server or a dead notification service cannot fail the user's follow.
 *
 * ## Idempotency
 *
 * `eventId` is stable and consumer-facing. A consumer that sees it twice — a
 * redelivery, a retry, a worker that died between acting and acknowledging —
 * must be able to recognise it as the same event, so the ids are deterministic
 * rather than random where the cause is deterministic.
 *
 * ## What is NOT in here
 *
 * No visible-notification decision. That is policy, and it belongs to whoever
 * projects these events — a follow created from Syra notifies in Syra, and an
 * application that begins consuming an existing relationship notifies nobody.
 * Encoding "should notify" in the event would freeze that policy at write time
 * and make it un-fixable for events already written.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { appGrants } from './appGrants';
import { applications } from './applications';
import { createdAt, generatedId, timestamptz } from '@oxyhq/db';
import { users } from './users';

/**
 * What happened. Deliberately verbs about the RELATIONSHIP, not about the
 * transport: `follow.removed` is the same event whether the user pressed
 * unfollow, the follow expired, or an inbound undo arrived — the cause travels
 * separately, so a consumer that only cares "this is over" needs one branch.
 */
export const FOLLOW_EVENT_TYPES = [
  'follow.created',
  'follow.removed',
  'follow.requested',
  'follow.accepted',
  'follow.rejected',
  'follow.context_enabled',
  'follow.context_disabled',
] as const;

export type FollowEventType = (typeof FOLLOW_EVENT_TYPES)[number];

/** Why it happened. What lets a consumer tell an expiry from a decision. */
export const FOLLOW_EVENT_CAUSES = [
  'user_action',
  'expired',
  'federation_inbound',
  'reconciliation',
  'migration',
] as const;

export type FollowEventCause = (typeof FOLLOW_EVENT_CAUSES)[number];

export const followEvents = pgTable(
  'follow_events',
  {
    id: generatedId(),
    /** Stable, consumer-facing identity. UNIQUE — it is the dedupe key. */
    eventId: text().notNull(),
    type: text({ enum: FOLLOW_EVENT_TYPES }).notNull(),
    cause: text({ enum: FOLLOW_EVENT_CAUSES }).notNull(),
    /**
     * Whose graph changed. `CASCADE`: a deleted user's history is not
     * deliverable, and keeping it would leave events naming nobody.
     */
    actorUserId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The relationship this is about, as a plain id with NO foreign key.
     *
     * Deliberate: the event must outlive the row. `follow.removed` describes a
     * relationship that no longer exists, and a `CASCADE` would delete the
     * event that says so at the exact moment a consumer needs it.
     */
    relationshipId: text().notNull(),
    /** Same reasoning — the target's URI, denormalized so the event is self-contained. */
    targetUri: text().notNull(),
    targetKind: text().notNull(),
    /** Where the user was. `SET NULL` — provenance, never authority. */
    originApplicationId: text().references(() => applications.id, { onDelete: 'set null' }),
    /** Which consent authorised it. `SET NULL` on revoke; see the relationship table. */
    grantId: text().references(() => appGrants.id, { onDelete: 'set null' }),
    /**
     * The application a context event is about. Only set for
     * `context_enabled` / `context_disabled`, where "which app" IS the event.
     */
    contextApplicationId: text().references(() => applications.id, { onDelete: 'set null' }),
    /** Bounded extra detail. Never required to interpret the event. */
    payload: jsonb().$type<Record<string, unknown>>(),
    /**
     * When the worker finished with it. NULL means still to be processed.
     *
     * Written ONLY after the side effect succeeded. An event acknowledged before
     * its effect is an event silently lost, and nothing downstream can tell the
     * difference between "delivered" and "marked delivered".
     */
    processedAt: timestamptz(),
    /**
     * ## The claim, as three columns
     *
     * A worker leases an event rather than holding a row lock for as long as it
     * takes to act on it: a lock lives inside a transaction, so keeping one
     * across the side effect means a database connection is pinned for the
     * duration of a remote delivery. The lease is what lets the claiming
     * transaction commit immediately and the work happen outside it.
     */
    /** When the current claim was taken. NULL means unclaimed. */
    claimedAt: timestamptz(),
    /**
     * Which worker holds it. Checked on acknowledgement, so a worker whose lease
     * expired mid-flight cannot mark an event another worker has since taken —
     * the second worker is the one that will report an outcome for it.
     */
    claimedBy: text(),
    /**
     * How many times this event has been CLAIMED, not how many times a handler
     * has thrown. A process killed mid-handler never gets to record a failure,
     * so counting at failure time lets an event that crashes its worker retry
     * forever across restarts. Counting at claim time bounds it, at the cost of
     * spending an attempt on an event that was interrupted by a deploy.
     */
    attempts: integer().notNull().default(0),
    /**
     * Dead letter. Set once an event has exhausted its attempts, or when it can
     * never succeed (an event type no handler knows). A dead-lettered event is
     * never claimed again and is deliberately NOT marked processed — its effect
     * did not happen, and a queue that hides that is worse than one that stops.
     */
    failedAt: timestamptz(),
    /** Why the last attempt failed. Bounded; provenance for whoever triages it. */
    lastError: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('follow_events_event_id_key').on(t.eventId),
    // The repo's convention for a closed value set, which 0016 skipped: the
    // drizzle `enum` above is a COMPILE-TIME claim, and nothing stopped a
    // repair script or a future service from writing a type no consumer knows.
    //
    // A second line of defence, not a replacement for the worker's own guard:
    // this constrains what can be WRITTEN from now on, and says nothing about a
    // row that predates it — so `followOutbox.worker.ts` still dead-letters a
    // type it has no handler for rather than trusting the column.
    check(
      'follow_events_type_check',
      sql`${t.type} in ('follow.created', 'follow.removed', 'follow.requested', 'follow.accepted', 'follow.rejected', 'follow.context_enabled', 'follow.context_disabled')`
    ),
    check(
      'follow_events_cause_check',
      sql`${t.cause} in ('user_action', 'expired', 'federation_inbound', 'reconciliation', 'migration')`
    ),
    // The worker's read: claimable, oldest first. Partial, so the index stays
    // the size of the backlog rather than the size of all history — which is the
    // difference between a queue and a table that used to be one.
    //
    // Dead letters are excluded for the same reason, and it is not cosmetic:
    // they are by definition the OLDEST unprocessed rows, so leaving them in a
    // `created_at`-ordered index makes every future claim scan past all of them
    // first, forever.
    index('follow_events_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.processedAt} is null and ${t.failedAt} is null`),
    // The dead-letter read. Without it the only way to find the events that
    // stopped is a scan of all history, and a marker nobody can find is not a
    // marker.
    index('follow_events_dead_letter_idx')
      .on(t.failedAt)
      .where(sql`${t.failedAt} is not null`),
    // "What happened to this relationship" — reconciliation and support.
    index('follow_events_relationship_idx').on(t.relationshipId),
    index('follow_events_actor_idx').on(t.actorUserId, t.createdAt),
  ]
);
