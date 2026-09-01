/**
 * `user_credits` — one API-credit balance per account.
 *
 * Ported from `models/UserCredits.ts`.
 *
 * ## The primary key IS the account id
 *
 * `UserCredits._id` is a String holding the user id, and the row is created by
 * upserting on it (`routes/credits.ts:13`). That makes this a 1:1 extension of
 * `users`, so its key is `user_id`: a plain `text().primaryKey()` with a real
 * foreign key and NO generator, because the value is always supplied by the
 * caller. Same shape as `link_previews.id`, the exception `CONVENTIONS.md`
 * records — a table whose id comes from somewhere else says so by having no
 * default.
 *
 * ## Credits are integer counts, so `bigint`, not `numeric` and never a float
 *
 * A credit is indivisible: every writer moves whole credits
 * (`billing.ts:366`, `:461`; usage rounds up at `credits.ts:76`). `bigint`
 * rather than `integer` for the same reason the money columns are: a spendable
 * balance must not carry a ceiling it can silently grow into.
 *
 * ## The concurrency guarantee lives in `db/credits.ts`
 *
 * `refreshCreditsIfNeeded` and `deductCredits` were OPTIMISTIC-CONCURRENCY
 * updates in Mongoose, not plain writes — a compare-and-set on `lastRefresh` and
 * a `$gte`-guarded `$inc`. A read-modify-write port would lose that silently and
 * let two racing deductions both succeed. The guarded statements are in
 * `db/credits.ts`; the CHECKs below are the second line, catching any OTHER
 * write path that would drive a balance negative.
 *
 * Those CHECKs are the one place this table adds a constraint Mongoose did not
 * have. That is deliberate: a negative credit balance is the exact failure the
 * guarded updates exist to prevent, so if the backfill finds one it should stop
 * and name it rather than carry it across — the same posture `CONVENTIONS.md`
 * records for two accounts whose usernames differ only by case.
 *
 * ## `ON DELETE CASCADE`
 *
 * Unlike the wallet and the two ledgers, credits are a non-transferable
 * entitlement to API usage and this row is a 1:1 extension of the account — it
 * cannot outlive it or be reconciled without it. The record of the PAYMENT that
 * bought them is retained in `billing_transactions`, which does not cascade.
 */

import { sql } from 'drizzle-orm';
import { bigint, check, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';

/** Free credits a new account starts with, and the ceiling a refresh restores. */
export const DEFAULT_FREE_CREDITS = 1000;
/** Displayed as the daily allowance. Read by the client, not by the refresh. */
export const DEFAULT_DAILY_CREDIT_REFRESH = 300;
/** How long a free balance must go untouched before a refresh may restore it. */
export const CREDIT_REFRESH_INTERVAL_HOURS = 24;

export const userCredits = pgTable(
  'user_credits',
  {
    /**
     * The account. Primary key AND foreign key — the Mongo `_id` was the user
     * id verbatim, so there is no second identifier to invent.
     */
    userId: text()
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),

    // ---- balance -----------------------------------------------------------
    // A nested object with a fully known shape: real columns, not `jsonb`.
    /** Refreshed back up to `credits_free_limit` at most once every 24h. */
    creditsFree: bigint({ mode: 'number' }).notNull().default(DEFAULT_FREE_CREDITS),
    /** The ceiling a refresh restores `credits_free` to. Per-account, so a column. */
    creditsFreeLimit: bigint({ mode: 'number' }).notNull().default(DEFAULT_FREE_CREDITS),
    creditsDailyRefresh: bigint({ mode: 'number' })
      .notNull()
      .default(DEFAULT_DAILY_CREDIT_REFRESH),
    /** The compare-and-set column that makes a refresh happen at most once. */
    creditsLastRefresh: timestamptz().notNull().defaultNow(),
    /** Purchased credits. Spent BEFORE free credits — see `db/credits.ts`. */
    creditsPaid: bigint({ mode: 'number' }).notNull().default(0),

    /** Resolves a Stripe webhook back to the account (`billing.ts:387`). */
    stripeCustomerId: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Mongo's sparse `{stripeCustomerId: 1}`, PARTIAL here for the same reason
    // (most accounts have never touched Stripe) and additionally UNIQUE, which
    // Mongo's was not. `billing.ts:387` resolves the account for a subscription
    // webhook with `findOne({stripeCustomerId})` — a `findOne` IS a uniqueness
    // assumption, and if two accounts shared a customer id that webhook would
    // credit whichever row came back first. Stating it here means the backfill
    // fails and names the pair instead, which is the correct outcome: the
    // application cannot tell them apart today either.
    uniqueIndex('user_credits_stripe_customer_id_key')
      .on(t.stripeCustomerId)
      .where(sql`${t.stripeCustomerId} is not null`),

    // The second line behind `db/credits.ts`'s guards — see the header.
    check('user_credits_credits_free_check', sql`${t.creditsFree} >= 0`),
    check('user_credits_credits_paid_check', sql`${t.creditsPaid} >= 0`),
  ]
);
