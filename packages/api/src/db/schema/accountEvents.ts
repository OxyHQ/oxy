/**
 * `account_events` and `account_event_deliveries` — telling relying parties
 * that a person deleted their Oxy account (OxyHQ/Mention#1169).
 *
 * Deleting an Oxy account used to stop at Oxy's own tables. Every application
 * the person had used — Mention holding their posts, follows and federated
 * actor — kept serving that data, because nothing told it the account was gone.
 * The GDPR right to erasure (Art. 17(2), Art. 19) obliges the controller to pass
 * the erasure on to whoever it disclosed the personal data to; these two tables
 * are how Oxy does that.
 *
 * ## One event, two ways to receive it
 *
 * - **Push.** `accountEventWebhook.worker.ts` POSTs a signed Security Event Token
 *   to each recipient application's `webhook_url`, at least once, with
 *   exponential backoff, dead-lettering after a bounded number of attempts.
 * - **Pull.** `GET /internal/account-events` serves the same signed tokens to the
 *   recipient application with its service token, so a relying party that missed
 *   a push (down for days, no webhook configured, a dead-lettered delivery)
 *   reconciles from a cursor. The pull feed is the safety net, and it is why a
 *   delivery row exists for every recipient even when it has no webhook.
 *
 * ## Written in the SAME transaction as the deletion
 *
 * The event and its delivery rows are inserted in the transaction that deletes
 * (or archives) the account. An event therefore exists if and only if the
 * deletion committed: never an erasure request for an account that survived a
 * failed delete, never a deletion nobody hears about.
 *
 * ## `user_id` carries no foreign key, deliberately
 *
 * The row it names is gone — that is the whole point of the event. It is the
 * one datum relying parties need to find what to erase, and it is swept after
 * `ACCOUNT_EVENT_RETENTION_SECONDS` (`db/expiry.ts`).
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';
import { applications } from './applications';

/** Closed set of account lifecycle events relying parties are told about. */
export const ACCOUNT_EVENT_TYPES = ['account.deleted'] as const;

export type AccountEventType = (typeof ACCOUNT_EVENT_TYPES)[number];

/**
 * How long an event stays readable from the pull feed. Thirty days: longer than
 * the push retry window (about three and a half days) by a wide margin, so a
 * relying party that reconciles even weekly cannot miss one. After that the
 * deleted account's id is dropped too — keeping it longer serves nobody.
 */
export const ACCOUNT_EVENT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const accountEvents = pgTable(
  'account_events',
  {
    /** The event id: the SET's `jti`, the consumer's idempotency key, and the pull cursor (uuidv7, time-ordered). */
    id: generatedId(),
    type: text({ enum: ACCOUNT_EVENT_TYPES }).notNull(),
    /** The deleted account. No foreign key: see the header. */
    userId: text().notNull(),
    /**
     * The handle the account had when it was deleted, read before the row is
     * removed or archived. Relying parties that address the person by handle —
     * Mention's ActivityPub actor is `/ap/users/<username>` — need it to sign
     * and send the actor `Delete` once the Oxy profile no longer resolves. Null
     * for an account that never had one.
     */
    username: text(),
    /**
     * `true` when the account row was archived rather than removed because
     * financial records must be kept. The person still deleted their account and
     * every relying party must still erase; the flag is informational.
     */
    retained: boolean().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('account_events_type_check', sql`${t.type} in (${sql.raw(inList(ACCOUNT_EVENT_TYPES))})`),
    // The expiry sweep's range predicate (`db/expiry.ts`).
    index('account_events_created_at_idx').on(t.createdAt),
  ]
);

export const accountEventDeliveries = pgTable(
  'account_event_deliveries',
  {
    id: generatedId(),
    /** `CASCADE`: a delivery means nothing without its event, and the event's sweep retires it. */
    eventId: text()
      .notNull()
      .references(() => accountEvents.id, { onDelete: 'cascade' }),
    /** `CASCADE`: an application that is gone has nobody left to tell. */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    /** Push attempts made so far. */
    attempts: integer().notNull().default(0),
    /** Earliest time the next push may be tried; the backoff lives here. */
    nextAttemptAt: timestamptz()
      .notNull()
      .default(sql`now()`),
    claimedAt: timestamptz(),
    claimedBy: text(),
    /** The receiver acknowledged with a 2xx. */
    deliveredAt: timestamptz(),
    /**
     * The push path is finished without an acknowledgement: attempts exhausted,
     * or the application has no webhook to push to. The pull feed still serves
     * the event, which is why this is not a loss.
     */
    failedAt: timestamptz(),
    lastStatus: integer(),
    lastError: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('account_event_deliveries_event_id_application_id_key').on(t.eventId, t.applicationId),
    check('account_event_deliveries_attempts_check', sql`${t.attempts} >= 0`),
    // The worker's claim: due, unfinished deliveries in due order.
    index('account_event_deliveries_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.deliveredAt} is null and ${t.failedAt} is null`),
    // The pull feed: one application's events after a cursor.
    index('account_event_deliveries_application_id_event_id_idx').on(t.applicationId, t.eventId),
  ]
);

export type AccountEventRow = typeof accountEvents.$inferSelect;
export type AccountEventDeliveryRow = typeof accountEventDeliveries.$inferSelect;
