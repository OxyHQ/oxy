/**
 * `subscriptions` — the legacy plan record, predating the Stripe cutover.
 *
 * Ported from `models/Subscription.ts`. Stripe writes to
 * `billing_subscriptions`; this table may still hold rows from before that
 * change, and `subscriptionPlan.ts:39` reads it as a fallback so premium gates
 * stay accurate for anyone who never migrated.
 *
 * ## The TTL index does NOT travel — it was a data-loss bug
 *
 * Mongo declared `SubscriptionSchema.index({ endDate: 1 }, { expireAfterSeconds: 0 })`.
 * A Mongo TTL index DELETES the document. On a subscription that means the
 * record of what the user bought, when it started, and what it entitled them to
 * is destroyed the moment the period closes — while the `status` enum has an
 * `expired` value that is plainly what the author meant. So this table is
 * deliberately NOT registered in `db/expiry.ts`: that registry deletes rows,
 * which is exactly the behaviour being removed.
 *
 * ## What replaces it: expiry is DERIVED, `status` is a projection
 *
 * The authoritative facts are `end_date` and a `status` of `active`/`canceled`.
 * `expired` is derivable — `status <> 'canceled' and end_date <= now()` — so:
 *
 *   - **Every read filters expiry itself.** The ported query is
 *     `where user_id = $1 and status = 'active' and end_date > now()`. This is
 *     class (A) in `db/expiry.ts`'s taxonomy: correctness never depends on a job
 *     having run, which is the property the TTL index quietly did NOT have
 *     either (Mongo's TTL monitor lags ~60s, so an expired subscription stayed
 *     readable and premium-granting for up to a minute).
 *   - **A projection job materializes `status = 'expired'`** for the reads and
 *     dashboards that group by status, via
 *     `update subscriptions set status = 'expired' where status = 'active' and end_date <= now()`.
 *     `subscriptions_active_end_date_idx` exists to make that predicate a range
 *     scan rather than a table scan — the same obligation Mongo's TTL index
 *     carried. Scheduling it belongs with the call-site port, alongside the
 *     BullMQ repeatable jobs; nothing reads this table from Postgres yet.
 *
 * A `GENERATED ALWAYS` column cannot express this: the expression would have to
 * read `now()`, which is not IMMUTABLE.
 *
 * ## `ON DELETE CASCADE`
 *
 * Unlike the wallet and the two ledgers, a subscription row is an ENTITLEMENT,
 * not money. The record of what was PAID lives in `billing_transactions`, which
 * is retained. An entitlement with no account to entitle is unusable and
 * unreconcilable, so it goes with the account.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

/** Plan tiers. `basic` is the free floor, so it is also the default. */
export const SUBSCRIPTION_PLANS = ['basic', 'pro', 'business'] as const;

/**
 * `expired` is a materialized projection of `end_date <= now()`, never a fact a
 * writer asserts on its own — see the header.
 */
export const SUBSCRIPTION_STATUSES = ['active', 'canceled', 'expired'] as const;

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: generatedId(),
    /** `CASCADE` — an entitlement with no account behind it entitles nothing. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    plan: text({ enum: SUBSCRIPTION_PLANS }).notNull().default('basic'),
    status: text({ enum: SUBSCRIPTION_STATUSES }).notNull().default('active'),
    startDate: timestamptz().notNull().defaultNow(),
    /** The period deadline. Expiry is derived from it; nothing deletes on it. */
    endDate: timestamptz().notNull(),
    autoRenew: boolean().notNull().default(true),
    paymentMethod: text(),
    latestInvoice: text(),

    // ---- entitlements ------------------------------------------------------
    // A nested object with a fully known shape: six real columns, not `jsonb`.
    // The serializer reassembles them into the `features` object the wire
    // contract promises (`utils/subscriptionResponse.ts:86`).
    featureAnalytics: boolean().notNull().default(false),
    featurePremiumBadge: boolean().notNull().default(false),
    featureUnlimitedFollowing: boolean().notNull().default(false),
    featureHigherUploadLimits: boolean().notNull().default(false),
    featurePromotedPosts: boolean().notNull().default(false),
    featureBusinessTools: boolean().notNull().default(false),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Every read leads with the owner: `findOne({userId, status, plan})`
    // (`subscriptionPlan.ts:39`), `findOne({userId})`
    // (`subscription.controller.ts:30`), and
    // `findOneAndUpdate({userId, status: {$ne: 'canceled'}})` (`:63`). Mongo's
    // standalone `{userId}` is redundant against this, and its `{status}` index
    // is dropped: no query filters this table by status alone.
    index('subscriptions_user_id_status_idx').on(t.userId, t.status),
    // The replacement for the TTL index: the range scan the expiry projection
    // runs, narrowed to the only rows it can act on.
    index('subscriptions_active_end_date_idx')
      .on(t.endDate)
      .where(sql`${t.status} = 'active'`),

    check(
      'subscriptions_plan_check',
      sql`${t.plan} in (${sql.raw(SUBSCRIPTION_PLANS.map((value) => `'${value}'`).join(', '))})`
    ),
    check(
      'subscriptions_status_check',
      sql`${t.status} in (${sql.raw(SUBSCRIPTION_STATUSES.map((value) => `'${value}'`).join(', '))})`
    ),
  ]
);
