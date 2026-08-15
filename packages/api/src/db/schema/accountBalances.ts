/**
 * `account_balances` — the balance PROJECTION, and the reservation
 * serialization point.
 *
 * The `billing_ledger_entries` journal is the authority; this table is a read
 * model maintained inside the same transaction as every entry that changes it.
 * It exists for two reasons, and only the second is about speed:
 *
 *  1. **It is the lock.** A reservation takes `SELECT … FOR UPDATE` on this row
 *     before it checks anything, so two concurrent reserves against one account
 *     serialize on it. Without a single row to lock, two reservations would each
 *     read a balance, each decide it could afford the hold, and both write —
 *     under READ COMMITTED, `Promise.all` does not force statements to interleave,
 *     so that race does not even reliably show up in a test.
 *  2. Summing the whole journal on every request is not viable at inference
 *     volume.
 *
 * A projection can drift from its journal, so it gets a reconciliation gate
 * rather than trust: `schema/__tests__/inferenceLedger.test.ts` recomputes every
 * bucket from the postings and asserts equality with a non-zero floor beside it,
 * because two counts that are both zero agree for free.
 *
 * ## Sign convention — stated once, negated in exactly one place
 *
 * The journal has ONE rule: `balance(account) = Σ(destination) − Σ(source)`.
 * Three of the four buckets below are that number directly and are
 * non-negative. The fourth is not, and it is the one place a reader can go
 * wrong, so it is named for what it means rather than for the arithmetic:
 *
 *   `invoiced_outstanding = −balance(invoice_receivable)`
 *
 * An invoiced account draws FROM `invoice_receivable`, so that account's journal
 * balance goes negative by exactly what the account owes. Storing the negation
 * keeps every column here non-negative, which is what lets a row be served on
 * the wire without a sign — `exactDecimalSchema` admits no negative amount, by
 * design, because a stray sign is how a reversal becomes a second charge.
 *
 * ## Keyed on (account, currency)
 *
 * A profile declares one currency, so an account normally has one row. The key
 * is still the pair, because a currency change must not silently re-denominate
 * an existing balance: it creates a second row and leaves the first one
 * reconcilable.
 *
 * ## `ON DELETE RESTRICT`
 *
 * Same posture as `billing_profiles` and the pre-existing
 * `billing_transactions`: a balance is a financial position, and account
 * erasure needs an explicit retention decision rather than a cascade.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from '@oxyhq/db';
import { currencyCode, currencyCodeCheck, exactAmount } from './ledgerColumns';
import { users } from './users';

export const accountBalances = pgTable(
  'account_balances',
  {
    accountId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    currency: currencyCode(),

    /** Prepaid money the customer bought and has not yet spent. */
    purchasedBalance: exactAmount().notNull().default('0'),
    /**
     * Granted credit — trials, migration credits, goodwill. Held separately
     * from purchased money because it is not refundable, may expire, and is
     * spent FIRST (see `inferenceLedger.service.ts`'s draw order).
     */
    promotionalBalance: exactAmount().notNull().default('0'),
    /**
     * Currently held against in-flight requests. Shown to customers distinctly
     * from settled charges: a reservation is not money spent, and presenting the
     * two as one number makes a balance appear to drop and recover on every
     * request.
     */
    reservedBalance: exactAmount().notNull().default('0'),
    /**
     * What an `invoiced` account has drawn and not yet paid, as a NON-NEGATIVE
     * amount. See the sign convention in the header — this is the negation of
     * the `invoice_receivable` journal balance, and the only negation in the
     * system.
     */
    invoicedOutstanding: exactAmount().notNull().default('0'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.currency] }),

    // The auto-recharge sweep and the "who is nearly out" report both scan by
    // balance rather than by account.
    index('account_balances_purchased_balance_idx').on(t.purchasedBalance),

    check('account_balances_currency_check', currencyCodeCheck(t.currency)),
    // Every bucket is non-negative BY CONSTRUCTION, and these are the second
    // line behind the guarded updates in `inferenceLedger.service.ts` — exactly
    // the posture `user_credits` takes on its own credit columns. A balance
    // driven negative by some other write path fails loudly here rather than
    // being discovered in a support ticket.
    check('account_balances_purchased_check', sql`${t.purchasedBalance} >= 0`),
    check('account_balances_promotional_check', sql`${t.promotionalBalance} >= 0`),
    check('account_balances_reserved_check', sql`${t.reservedBalance} >= 0`),
    check('account_balances_invoiced_outstanding_check', sql`${t.invoicedOutstanding} >= 0`),
  ]
);
