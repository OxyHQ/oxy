/**
 * `billing_stripe_events` — every Stripe webhook delivery this API accepted, and
 * what became of it.
 *
 * ## Why a table
 *
 * The webhook used to keep no record of what it received. A renewal that never
 * granted, a subscription that froze in the wrong state, an invoice that failed
 * reconciliation: each left at most a log line, and logs are neither queryable
 * by subscription nor durable past their retention. This row is the durable
 * answer to "did Stripe tell us, and what did we do about it".
 *
 * It is NOT the idempotency guard for money. The grant paths keep their own
 * partial unique indexes on `billing_transactions`, because two deliveries of
 * two DIFFERENT events (an `invoice.paid` redelivered under a new event id, say)
 * can describe one payment, and only a key on the payment itself catches that.
 * This table records receipt, processing and result; skipping an event already
 * processed is an optimisation on top, never the thing that prevents a double
 * grant.
 *
 * ## Lifecycle
 *
 * The row is written on receipt (`outcome` null), and `processed_at` + `outcome`
 * are set when the handler returns. A handler that throws records `failed` and
 * its message, the webhook answers 500, and Stripe's redelivery runs it again.
 * `attempts` counts deliveries, replays of a finished event included. Only
 * `granted` and `duplicate` are settled — a redelivery of those is acknowledged
 * without running the handler again; every other outcome is re-evaluated, so
 * resending an event after fixing a misconfigured price is the recovery path.
 *
 * ## No foreign key to `users`
 *
 * An event is recorded before — and whether or not — it resolves to an account.
 * An event for an unknown customer is exactly the one worth keeping.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';

/**
 * What the handler did with an event.
 *
 * - `granted` — the event carried the evidence for a credit grant and it landed.
 * - `duplicate` — the grant it describes had already landed; nothing written.
 * - `synced` — a mirror (the local subscription row) was brought up to date.
 * - `stale` — the mirror already held a newer provider read; nothing written.
 * - `not_granted` — the event was understood and deliberately granted nothing;
 *   `outcome_detail` names the reason (failed invoice, reconciliation mismatch…).
 * - `ignored` — an event type or object this API does not act on.
 * - `processed` — handled by a path with no finer-grained result to report.
 * - `failed` — the handler threw; the delivery was answered 500 and will be retried.
 */
export const BILLING_STRIPE_EVENT_OUTCOMES = [
  'granted',
  'duplicate',
  'synced',
  'stale',
  'not_granted',
  'ignored',
  'processed',
  'failed',
] as const;

export type BillingStripeEventOutcome = (typeof BILLING_STRIPE_EVENT_OUTCOMES)[number];

export const billingStripeEvents = pgTable(
  'billing_stripe_events',
  {
    id: generatedId(),
    /** Stripe's event id (`evt_…`). One row per event, however often delivered. */
    stripeEventId: text().notNull(),
    type: text().notNull(),
    /** The id of `event.data.object` — the invoice, subscription, session… */
    stripeObjectId: text(),
    /** `event.created`: when Stripe generated the event, not when it arrived. */
    stripeCreatedAt: timestamptz().notNull(),
    attempts: integer().notNull().default(1),
    processedAt: timestamptz(),
    outcome: text({ enum: BILLING_STRIPE_EVENT_OUTCOMES }),
    outcomeDetail: text(),
    /** The receipt time of the FIRST delivery. */
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('billing_stripe_events_stripe_event_id_key').on(t.stripeEventId),
    // "What happened to this invoice / subscription", newest first.
    index('billing_stripe_events_object_idx').on(t.stripeObjectId, t.stripeCreatedAt),
    check(
      'billing_stripe_events_outcome_check',
      sql`${t.outcome} is null or ${t.outcome} in (${sql.raw(inList(BILLING_STRIPE_EVENT_OUTCOMES))})`,
    ),
    // A processed event says what happened; an unprocessed one has no outcome yet.
    check(
      'billing_stripe_events_processed_check',
      sql`(${t.processedAt} is null) = (${t.outcome} is null)`,
    ),
    check('billing_stripe_events_attempts_check', sql`${t.attempts} >= 1`),
  ],
);
