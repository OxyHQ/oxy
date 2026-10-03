/**
 * Atomic credit mutations. Free refresh and plain top-ups retain their guarded
 * SQL writes; deduction locks the balance and records FIFO subscription-grant
 * consumption in the same transaction. Historical/purchased balance remains
 * opaque and is spent after tracked grants, before free credits.
 * DatabaseOrTransaction preserves the caller's receipt/award rollback boundary.
 */

import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../config/postgres';
import { CREDIT_REFRESH_INTERVAL_HOURS, userCredits } from './schema/userCredits';
import { spendSubscriptionTrackedCredits } from '../services/subscriptionCreditLedger.service';

/** Which half of the balance a grant lands in. */
export type CreditKind = 'free' | 'paid';

/**
 * `amount` is a whole, non-negative number of credits.
 *
 * Both halves matter. Negative would turn a deduction into a grant that skips
 * every balance guard — a hole `deductCredits` had in Mongoose, where
 * `deductCredits(-100)` passed all three of its checks and ADDED 100 paid
 * credits. Fractional would land in a `bigint` column, and what happens then
 * depends on how the driver typed the parameter rather than on any contract:
 * bound as text it is REJECTED (`invalid input syntax for type bigint: "1.5"`),
 * bound as numeric it is silently ROUNDED UP. Neither is an answer to give a
 * caller about money, so the test is written out in `numeric` space where both
 * bindings behave identically.
 *
 * Expressed as a `WHERE` clause rather than a thrown error so a bad amount takes
 * the same "this did not apply" path a rejected balance guard does — the return
 * value is already the caller's answer.
 */
function wholeNonNegative(amount: number): SQL {
  return sql`${amount}::numeric >= 0 and ${amount}::numeric = trunc(${amount}::numeric)`;
}

/**
 * Restore the free balance to its per-account limit, at most once every
 * `CREDIT_REFRESH_INTERVAL_HOURS`.
 *
 * The Mongoose original read the row, computed the elapsed hours in JavaScript,
 * and then compare-and-set on the exact `lastRefresh` value it had read. The
 * SQL form needs neither the read nor the CAS: the elapsed-time test IS the
 * guard, evaluated against the row under lock, so two concurrent callers can
 * never both refresh — the second sees the advanced `credits_last_refresh` and
 * matches nothing.
 *
 * @returns Whether this call performed the refresh. `false` also covers "no such
 *   account", which is the same answer the Mongoose version gave.
 */
export async function refreshCreditsIfNeeded(
  db: DatabaseOrTransaction,
  userId: string
): Promise<boolean> {
  const [row] = await db
    .update(userCredits)
    .set({
      // A RESET to the limit, not an increment — matching `models/UserCredits.ts:44`.
      creditsFree: sql`${userCredits.creditsFreeLimit}`,
      creditsLastRefresh: sql`now()`,
    })
    .where(
      and(
        eq(userCredits.userId, userId),
        sql`${userCredits.creditsLastRefresh} <= now() - make_interval(hours => ${CREDIT_REFRESH_INTERVAL_HOURS})`
      )
    )
    .returning({ userId: userCredits.userId });

  return row !== undefined;
}

/**
 * Grant credits.
 *
 * A plain `$inc` in Mongoose, and a plain `+` here — an increment is already
 * atomic under the row lock, so the only guard it needs is on the amount.
 *
 * @returns Whether the grant applied. `false` means either no such account or an
 *   amount that is not a whole non-negative number of credits.
 */
export async function addCredits(
  db: DatabaseOrTransaction,
  userId: string,
  amount: number,
  kind: CreditKind
): Promise<boolean> {
  // The arithmetic runs in `numeric` and is cast back at the end: the guard has
  // already established the amount is a whole number, so the cast is exact.
  const granted: { creditsFree?: SQL; creditsPaid?: SQL } =
    kind === 'free'
      ? { creditsFree: sql`(${userCredits.creditsFree} + ${amount}::numeric)::bigint` }
      : { creditsPaid: sql`(${userCredits.creditsPaid} + ${amount}::numeric)::bigint` };

  const [row] = await db
    .update(userCredits)
    .set(granted)
    .where(and(eq(userCredits.userId, userId), wholeNonNegative(amount)))
    .returning({ userId: userCredits.userId });

  return row !== undefined;
}

/**
 * Spend paid before free. New subscription grants are attributed FIFO, then
 * the unchanged opaque legacy/purchased remainder. The balance, immutable
 * consumption rows and grant counters commit together under the balance lock.
 */
export async function deductCredits(
  db: DatabaseOrTransaction,
  userId: string,
  amount: number
): Promise<boolean> {
  return spendSubscriptionTrackedCredits(db, userId, amount);
}
