/**
 * Credit Balance Mutations — the guarded writes `user_credits` depends on
 *
 * `models/UserCredits.ts` declares three instance methods, and two of them are
 * OPTIMISTIC-CONCURRENCY updates rather than plain writes: `refreshCreditsIfNeeded`
 * compare-and-sets on `credits.lastRefresh`, and `deductCredits` runs a
 * `$gte`-guarded `$inc`. Porting either as a read-modify-write would lose that
 * silently — two racing deductions would both read the same balance, both decide
 * they could afford it, and both write. The balance would go negative, or one
 * spend would vanish, with nothing in the code to show why.
 *
 * So the guard travels INTO the statement. Every function here is one
 * `UPDATE ... WHERE <guard>` whose success is decided by whether it matched a
 * row, never by a value the caller read earlier. Under READ COMMITTED — the
 * default — a concurrent `UPDATE` on the same row blocks on the row lock and
 * then RE-EVALUATES its `WHERE` against the committed new version, so the loser
 * of a race matches nothing and returns `false`. That is the whole mechanism.
 *
 * This module lives beside `db/expiry.ts` for the same reason that one does: it
 * is a database MECHANISM with no DDL counterpart, defined once so no call site
 * has to re-derive it, and it is not a service, controller or route.
 *
 * The CHECK constraints on `user_credits` are the second line. If some other
 * write path ever drives a balance negative, it fails loudly there instead of
 * being discovered in a support ticket.
 *
 * Every function takes `DatabaseOrTransaction`, not `Database`. A grant is
 * frequently one half of a pair — `handleCheckoutCompleted` writes the receipt
 * that CLAIMS the charge and then grants against it — and those two must commit
 * or roll back together. Typed as `Database` these would refuse a `tx` and
 * silently push the grant outside the caller's transaction, which is precisely
 * the atomicity the pairing exists to buy.
 */

import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { DatabaseOrTransaction } from '../config/postgres';
import { CREDIT_REFRESH_INTERVAL_HOURS, userCredits } from './schema/userCredits';

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
 * Spend credits, paid balance first, then free.
 *
 * The Mongoose original split the amount in JavaScript from a possibly-stale
 * `this.credits`, then issued one of two guarded updates. Here the split is
 * computed in the statement from the row's own values — `least(credits_paid,
 * amount)` — so the caller never holds a number that can go stale, and there is
 * exactly one statement to reason about instead of three branches.
 *
 * All `SET` expressions read the pre-update row, so the two subtractions are
 * consistent with each other and with the guard.
 *
 * @returns Whether the full amount was spent. `false` means insufficient
 *   balance, no such account, or an amount that is not a whole non-negative
 *   number of credits — and NOTHING was spent, since the guard is part of the
 *   same statement.
 */
export async function deductCredits(
  db: DatabaseOrTransaction,
  userId: string,
  amount: number
): Promise<boolean> {
  const fromPaid = sql`least(${userCredits.creditsPaid}, ${amount}::numeric)`;

  const [row] = await db
    .update(userCredits)
    .set({
      creditsPaid: sql`(${userCredits.creditsPaid} - ${fromPaid})::bigint`,
      creditsFree: sql`(${userCredits.creditsFree} - (${amount}::numeric - ${fromPaid}))::bigint`,
    })
    .where(
      and(
        eq(userCredits.userId, userId),
        wholeNonNegative(amount),
        // The guard the whole module exists for. Evaluated against the row under
        // lock, so a concurrent spend that got there first is already reflected.
        sql`${userCredits.creditsPaid} + ${userCredits.creditsFree} >= ${amount}::numeric`
      )
    )
    .returning({ userId: userCredits.userId });

  return row !== undefined;
}
