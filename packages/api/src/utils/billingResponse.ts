/**
 * Wire serializers for the two Stripe-facing tables.
 *
 * `GET /billing/subscription`, `POST /billing/subscription/cancel` and
 * `GET /billing/transactions` used to hand a raw Mongoose document to
 * `res.json()`. Two things about that shape are contract and one is not:
 *
 *   - **`_id` IS contract.** `packages/console/src/hooks/use-billing.ts` declares
 *     `_id: string` on both `Subscription` and `Transaction`. It is the row key
 *     the console renders lists by, so it is emitted here from the drizzle `id`.
 *   - **The MINOR-UNIT renames are invisible.** `billing_transactions.amount` and
 *     `billing_subscriptions.plan.price` were renamed in the schema to
 *     `amount_minor_units` / `plan_price_minor_units` so a reader cannot mistake
 *     minor units for currency. That rename stops HERE: the wire keeps `amount`
 *     and `plan.price`, with the same values it always carried.
 *   - **`__v` is NOT contract.** It is Mongoose's version counter, has no
 *     Postgres counterpart, and no consumer in this repo reads it. It does not
 *     travel.
 *
 * Written as explicit DTO types rather than `Record<string, unknown>` so a
 * missing field, an undeclared one, or a `Date` where the wire promised a string
 * fails `tsc` and names the field — the same posture the reputation serializers
 * take.
 */

import type { billingSubscriptions } from '../db/schema/billingSubscriptions';
import type { billingTransactions } from '../db/schema/billingTransactions';

type BillingSubscriptionRow = typeof billingSubscriptions.$inferSelect;
type BillingTransactionRow = typeof billingTransactions.$inferSelect;

/** `GET /billing/subscription` and the `subscription` field of the cancel result. */
export interface BillingSubscriptionResponse {
  _id: string;
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  status: BillingSubscriptionRow['status'];
  currentPeriodStart: string;
  currentPeriodEnd: string;
  cancelAtPeriodEnd: boolean;
  plan: {
    name: string;
    creditsPerMonth: number;
    /** Minor units — 2999 is $29.99. Named `price` because that is the wire name. */
    price: number;
    currency: string;
  };
  createdAt: string;
  updatedAt: string;
}

/** One entry of `GET /billing/transactions`. */
export interface BillingTransactionResponse {
  _id: string;
  userId: string;
  stripeCustomerId?: string;
  stripePaymentIntentId?: string;
  stripeSubscriptionId?: string;
  type: BillingTransactionRow['type'];
  /** Minor units — see the header. */
  amount: number;
  currency: string;
  credits: number;
  status: BillingTransactionRow['status'];
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Mongoose omitted an unset optional field entirely rather than emitting
 * `null`, and the consumer types declare these as `?:`. A drizzle nullable
 * column reads back as `null`, so the two are reconciled here.
 */
function optional(value: string | null): string | undefined {
  return value ?? undefined;
}

export function toBillingSubscriptionResponse(
  row: BillingSubscriptionRow
): BillingSubscriptionResponse {
  return {
    _id: row.id,
    userId: row.userId,
    stripeCustomerId: row.stripeCustomerId,
    stripeSubscriptionId: row.stripeSubscriptionId,
    stripePriceId: row.stripePriceId,
    status: row.status,
    currentPeriodStart: row.currentPeriodStart.toISOString(),
    currentPeriodEnd: row.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    plan: {
      name: row.planName,
      creditsPerMonth: row.planCreditsPerMonth,
      price: row.planPriceMinorUnits,
      currency: row.planCurrency,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toBillingTransactionResponse(
  row: BillingTransactionRow
): BillingTransactionResponse {
  return {
    _id: row.id,
    userId: row.userId,
    stripeCustomerId: optional(row.stripeCustomerId),
    stripePaymentIntentId: optional(row.stripePaymentIntentId),
    stripeSubscriptionId: optional(row.stripeSubscriptionId),
    type: row.type,
    amount: row.amountMinorUnits,
    currency: row.currency,
    credits: row.credits,
    status: row.status,
    description: optional(row.description),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
