/**
 * `billing_subscriptions` — the local mirror of a Stripe subscription.
 *
 * Ported from `models/BillingSubscription.ts`. Written only by the Stripe
 * webhook (`routes/billing.ts:403`), keyed on `stripe_subscription_id`.
 *
 * ## `plan_price_minor_units`, not `plan_price`
 *
 * The value Stripe deals in, and the value this column has always held, is
 * MINOR UNITS — `2999` is $29.99 (`billing.ts:75`). An integer count of minor
 * units is exact by construction, so this needs no `numeric`: it is `bigint`,
 * not because the number is large but because a money column must never carry a
 * ceiling that a growing balance can silently hit, and `integer` tops out around
 * $21M. The name carries the unit because the one thing that goes wrong with a
 * minor-unit column is a reader that divides by 100 twice, or not at all — and
 * `plan_price` reads like currency to everyone who has not opened Stripe's docs.
 * The wire contract is unaffected: the serializer emits `plan.price`.
 *
 * `plan_credits_per_month` is a whole count of API credits, so it is a `bigint`
 * for the same reason and with no unit ambiguity to name.
 *
 * ## `ON DELETE CASCADE`
 *
 * This row is a MIRROR. Stripe holds the authoritative subscription and retains
 * it independently of anything here, so nothing is lost by dropping the local
 * copy with the account — unlike `billing_transactions`, which is this
 * database's own record of money charged and is therefore retained.
 *
 * That leaves a real obligation the FK cannot state: an account with a LIVE
 * Stripe subscription must have it cancelled at Stripe before the account is
 * erased, or Stripe keeps billing a customer who no longer exists.
 * `billing_transactions` blocking the same delete under `RESTRICT` is what
 * forces a human to look; this constraint alone would not.
 */

import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

/**
 * Stripe's subscription statuses — ALL of them, because this table is a mirror.
 *
 * Mongoose declared only the five this platform sells, and that enum was never
 * enforced: the webhook writes through `findOneAndUpdate` WITHOUT
 * `runValidators`, so Mongo happily stored `incomplete`, `incomplete_expired`
 * and `paused` whenever Stripe sent them. A CHECK constraint IS enforced, so
 * porting the narrow list would convert a silent write into a failed webhook —
 * Stripe would retry forever and the mirror would freeze at its previous value.
 *
 * That stale value is the part that matters, and it is an ENTITLEMENT bug rather
 * than a bookkeeping one: a subscription that Stripe moved to `paused` would
 * stay `active` here, and `subscriptionPlan.ts` would keep granting premium to
 * someone who is no longer paying. A mirror has to be able to represent
 * whatever it mirrors.
 *
 * Only `active` and `trialing` ever count as live — see `LIVE_SUBSCRIPTION_STATUSES`
 * in `routes/billing.ts` — so widening the set grants nothing new; it only stops
 * the mirror from lying.
 */
export const BILLING_SUBSCRIPTION_STATUSES = [
  'active',
  'canceled',
  'incomplete',
  'incomplete_expired',
  'past_due',
  'paused',
  'trialing',
  'unpaid',
] as const;

/** Stripe's default currency for this platform's plans. */
export const DEFAULT_BILLING_CURRENCY = 'usd';

export const billingSubscriptions = pgTable(
  'billing_subscriptions',
  {
    id: generatedId(),
    /**
     * An untyped `String` in Mongoose — a logical reference to `User` that
     * nothing enforced. It is a real foreign key here. See the migration report
     * for the orphan audit this makes mandatory before the backfill.
     */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    stripeCustomerId: text().notNull(),
    /** Stripe's id for the subscription. The upsert key for the whole table. */
    stripeSubscriptionId: text().notNull(),
    stripePriceId: text().notNull(),
    /**
     * Optional in Mongoose but written on every webhook, so NOT NULL with the
     * same default the model declared.
     */
    status: text({ enum: BILLING_SUBSCRIPTION_STATUSES }).notNull().default('active'),
    currentPeriodStart: timestamptz().notNull(),
    currentPeriodEnd: timestamptz().notNull(),
    cancelAtPeriodEnd: boolean().notNull().default(false),

    // ---- plan snapshot -----------------------------------------------------
    // A nested object with a fully known shape: real columns, not `jsonb`. It is
    // a SNAPSHOT taken at webhook time, not a join — the catalogue it came from
    // (`billing.ts:74`) is a code constant with no table behind it, and the
    // price a subscriber pays must not change under them when that constant does.
    planName: text().notNull(),
    planCreditsPerMonth: bigint({ mode: 'number' }).notNull(),
    /** Minor units of `plan_currency` — 2999 is $29.99. See the header. */
    planPriceMinorUnits: bigint({ mode: 'number' }).notNull(),
    planCurrency: text().notNull().default(DEFAULT_BILLING_CURRENCY),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The upsert key (`billing.ts:404`, `:474`).
    unique('billing_subscriptions_stripe_subscription_id_key').on(t.stripeSubscriptionId),
    // "This user's live subscription" — `findOne({userId, status: {$in: [...]}})`
    // at `billing.ts:194`, `:216`, `subscriptionPlan.ts:28`,
    // `subscription.controller.ts:26`, `:50`. Mongo's standalone `{userId}` is
    // redundant against it: a btree serves any leading prefix.
    index('billing_subscriptions_user_id_status_idx').on(t.userId, t.status),
    // Mongo's `{stripeCustomerId: 1}` is DROPPED. Nothing reads this table by
    // Stripe customer — the webhook resolves the account through
    // `user_credits.stripe_customer_id` (`billing.ts:387`) and then keys on
    // `stripe_subscription_id`. An index nothing queries is write cost, and
    // `CONVENTIONS.md` says to drop the ones that do not earn their keep.

    check(
      'billing_subscriptions_status_check',
      sql`${t.status} in (${sql.raw(BILLING_SUBSCRIPTION_STATUSES.map((value) => `'${value}'`).join(', '))})`
    ),
  ]
);
