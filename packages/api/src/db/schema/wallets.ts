/**
 * `wallets` — one FairCoin balance per account.
 *
 * Ported from `models/Wallet.ts`.
 *
 * ## The balance is `numeric`, never a float
 *
 * Mongo stored it as a `Number`, i.e. an IEEE-754 double, which cannot
 * represent `0.1` — ten deposits of `0.1` minus `1` leaves `2.2e-16` in a
 * double and exactly `0` in `numeric`. A residue like that in a wallet ledger is
 * silent, compounds, and cannot be reconciled after the fact, so the column is
 * `numeric(38, 8)`: exact decimal arithmetic in the database, and postgres.js
 * hands it back as a STRING rather than re-introducing a double on the way out.
 *
 * `scale: 8` because FairCoin's smallest unit is 1e-8, the same convention
 * Bitcoin's satoshi follows; `precision: 38` leaves 30 integer digits, which is
 * past any conceivable supply and still inside the width Postgres stores
 * compactly. `transactions.amount` uses the same pair — see `WALLET_AMOUNT`.
 *
 * The alternative, integer minor units, was rejected here: it would multiply
 * every stored value by 1e8 during the backfill and force every read to divide,
 * changing the wire contract (`balance` is a JSON number today) for a table
 * whose values map across 1:1 as decimals.
 *
 * ## `ON DELETE RESTRICT`, deliberately
 *
 * `DELETE /users/me` (`routes/users.ts:1517`) hard-deletes the account after
 * purging mail, identity backups, sessions and the social graph — and touches
 * NOTHING financial, so today every deleted account leaves its wallet behind in
 * Mongo with no constraint to notice. Postgres forces the choice, and `CASCADE`
 * is the wrong half of it: a wallet holds a BALANCE, that balance is not
 * derivable from `transactions` (a withdrawal debits nothing until approved),
 * and destroying it destroys value with no audit trail and no way back.
 * `RESTRICT` converts that silent loss into a loud "settle this account first",
 * which is a step the deletion path has to grow. `SET NULL` is not available:
 * `user_id` is the wallet's owner identity, NOT NULL and unique.
 */

import { sql } from 'drizzle-orm';
import { check, numeric, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, generatedId } from '@oxyhq/db';
import { users } from './users';

/**
 * The decimal shape of every FairCoin amount in this schema — a wallet balance
 * and a ledger amount must be the same type or a comparison between them starts
 * rounding. Imported by `transactions.ts`.
 */
export const WALLET_AMOUNT = { precision: 38, scale: 8 } as const;

export const wallets = pgTable(
  'wallets',
  {
    id: generatedId(),
    /** One wallet per account. `RESTRICT` — see the header. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Exact decimal. Read as a string; never parse it into a double to do arithmetic. */
    balance: numeric(WALLET_AMOUNT).notNull().default('0'),
    /**
     * The last withdrawal payout address the owner supplied
     * (`wallet.controller.ts:429`). Not unique: two people may legitimately
     * withdraw to one exchange address.
     */
    address: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('wallets_user_id_key').on(t.userId),
    // Mongo built a sparse index on `address` (a bare `sparse: true` does that).
    // Dropped: no query in the codebase reads a wallet by address — it is only
    // ever written, and read back as part of the owner's own wallet.
    //
    // Mongoose's `min: 0`. Every debit path already refuses to overdraw
    // (`wallet.controller.ts:232`, `:330`, `:427`); this is what stops a write
    // path that forgets to.
    check('wallets_balance_check', sql`${t.balance} >= 0`),
  ]
);
