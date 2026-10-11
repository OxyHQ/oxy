/**
 * The durable record of Stripe webhook deliveries — `billing_stripe_events`.
 *
 * The webhook route calls `recordStripeEventReceived` before it runs any
 * handler and `recordStripeEventOutcome` after, so every accepted delivery leaves
 * a row saying what arrived, how often, and what was done with it. See the
 * table's header for why this is a record and not the money guard.
 */

import { eq, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import { getDb } from '../config/postgres';
import {
  type BillingStripeEventOutcome,
  billingStripeEvents,
} from '../db/schema/billingStripeEvents';

/** What a webhook handler reports back for the event ledger. */
export interface StripeEventResult {
  outcome: Exclude<BillingStripeEventOutcome, 'failed'>;
  detail?: string;
}

/** Longest `outcome_detail` stored; a stack trace is a log's job, not a row's. */
const MAX_DETAIL_LENGTH = 1000;

function objectIdOf(event: Stripe.Event): string | null {
  const id = (event.data.object as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}

/**
 * Outcomes after which a redelivery has nothing left to do: the grant the event
 * evidences has landed. Every other outcome is re-evaluated on redelivery —
 * after a misconfigured price or currency is fixed, resending the event is the
 * recovery path (`docs/runbooks/stripe-renewal-grants.md`), and re-running a
 * mirror sync or a refusal is harmless by construction.
 */
const SETTLED_OUTCOMES: ReadonlySet<string> = new Set(['granted', 'duplicate']);

/**
 * Record a delivery. Returns `true` when the handler should run, `false` when
 * the event already reached a settled outcome.
 *
 * Two concurrent deliveries of one new event both get `true`. That is safe by
 * construction — every grant is guarded by its own unique index — and it is the
 * price of not holding a lock across a Stripe API call.
 */
export async function recordStripeEventReceived(event: Stripe.Event): Promise<boolean> {
  const [row] = await getDb()
    .insert(billingStripeEvents)
    .values({
      stripeEventId: event.id,
      type: event.type,
      stripeObjectId: objectIdOf(event),
      stripeCreatedAt: new Date(event.created * 1000),
    })
    .onConflictDoUpdate({
      target: billingStripeEvents.stripeEventId,
      set: { attempts: sql`${billingStripeEvents.attempts} + 1` },
    })
    .returning({
      processedAt: billingStripeEvents.processedAt,
      outcome: billingStripeEvents.outcome,
    });

  return row.outcome === null || !SETTLED_OUTCOMES.has(row.outcome);
}

export async function recordStripeEventOutcome(
  eventId: string,
  outcome: BillingStripeEventOutcome,
  detail?: string,
): Promise<void> {
  await getDb()
    .update(billingStripeEvents)
    .set({
      processedAt: new Date(),
      outcome,
      outcomeDetail: detail ? detail.slice(0, MAX_DETAIL_LENGTH) : null,
    })
    .where(eq(billingStripeEvents.stripeEventId, eventId));
}
