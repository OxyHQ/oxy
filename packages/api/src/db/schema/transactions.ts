/**
 * `transactions` — the FairCoin ledger: one row per movement of wallet value.
 *
 * Ported from `models/Transaction.ts`. Distinct from `billing_transactions`,
 * which is the Stripe money trail; this table is the internal FairCoin wallet
 * and its amounts are decimal FairCoin, not currency minor units.
 *
 * `amount` is `numeric(38, 8)` for the same reason `wallets.balance` is — see
 * `wallets.ts`. The two must share `WALLET_AMOUNT`: a debit compared against a
 * balance of a different scale starts rounding at the comparison.
 *
 * ## `ON DELETE RESTRICT` on BOTH party columns
 *
 * A transfer row belongs to two accounts. Cascading either side would delete a
 * record out of the OTHER person's history — erasing A must never mutate B's
 * ledger — so `user_id` cascades nowhere. `user_id` is also `required: true` in
 * Mongoose, so `SET NULL` (retain-and-anonymize) is not available without
 * weakening the constraint for every live row.
 *
 * `recipient_id` is nullable and therefore COULD take `SET NULL`, and it still
 * does not: NULL here already MEANS "this movement had no counterparty" — a
 * deposit, withdrawal or purchase. `SET NULL` would silently rewrite a transfer
 * into one of those, which is the same trap `CONVENTIONS.md` records for
 * `push_tokens.application_id`. Under `RESTRICT` the ledger is retained and the
 * erasure has to settle it, which is the correct obligation for a financial
 * record.
 */

import { sql } from 'drizzle-orm';
import { check, index, numeric, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { users } from './users';
import { WALLET_AMOUNT } from './wallets';

/**
 * What moved the value. `deposit` has no writer in this codebase today but is
 * read by `payment.controller.ts:32`, so the value travels with the data.
 */
export const TRANSACTION_TYPES = ['deposit', 'withdrawal', 'transfer', 'purchase'] as const;

/** Lifecycle. A withdrawal is created `pending` and approved out of band. */
export const TRANSACTION_STATUSES = ['pending', 'completed', 'failed', 'cancelled'] as const;

export const transactions = pgTable(
  'transactions',
  {
    id: generatedId(),
    /** Whose movement this is — the payer on a transfer. `RESTRICT`; see the header. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    type: text({ enum: TRANSACTION_TYPES }).notNull(),
    /** Exact decimal FairCoin. Never parse it into a double to do arithmetic. */
    amount: numeric(WALLET_AMOUNT).notNull(),
    status: text({ enum: TRANSACTION_STATUSES }).notNull().default('pending'),
    description: text(),
    /** The payee on a transfer; NULL means the movement had no counterparty. */
    recipientId: text().references(() => users.id, { onDelete: 'restrict' }),
    /** What was bought, in the CONSUMING application's id space — see `deferredForeignKeys.ts`. */
    itemId: text(),
    itemType: text(),
    /** An identifier from whatever settled the movement off-platform. */
    externalReference: text(),
    completedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The wallet history is `find({$or: [{userId}, {recipientId}]})` ordered by
    // `createdAt` descending (`wallet.controller.ts:138-146`), and the payments
    // list is `find({userId, type: {$in: [...]}})` with the same sort
    // (`payment.controller.ts:30`). These two indexes serve the SELECTION and
    // the SORT together — a btree scans backwards, so ascending `created_at`
    // answers `order by created_at desc` without a second index.
    //
    // They replace FIVE Mongo indexes. The standalone `{userId}` and
    // `{recipientId}` are redundant (a btree serves any leading prefix), and
    // `{userId, status}` / `{recipientId, status}` are dropped outright: no
    // query in the codebase filters this table by status. `{userId, type}` is
    // dropped too — the payments query's type filter is a cheap residual once
    // the index has narrowed to one account's rows, and dropping it is what
    // buys the sort the Mongo index could not serve.
    index('transactions_user_id_created_at_idx').on(t.userId, t.createdAt),
    index('transactions_recipient_id_created_at_idx')
      .on(t.recipientId, t.createdAt)
      .where(sql`${t.recipientId} is not null`),

    check(
      'transactions_type_check',
      sql`${t.type} in (${sql.raw(TRANSACTION_TYPES.map((value) => `'${value}'`).join(', '))})`
    ),
    check(
      'transactions_status_check',
      sql`${t.status} in (${sql.raw(TRANSACTION_STATUSES.map((value) => `'${value}'`).join(', '))})`
    ),
    // Mongoose's `min: 0`. Direction is carried by `type`, never by the sign of
    // the amount, so a negative row would be unreadable by every consumer.
    //
    // Deliberately the ONLY value constraint added here. A "recipient is not
    // self" CHECK would look right — `wallet.controller.ts:193` refuses one —
    // but Mongoose never enforced it, so it could reject rows that already
    // exist and turn a cosmetic invariant into a failed backfill on financial
    // data nobody can audit first.
    check('transactions_amount_check', sql`${t.amount} >= 0`),
  ]
);
