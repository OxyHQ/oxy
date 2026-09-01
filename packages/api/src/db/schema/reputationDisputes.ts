/**
 * `reputation_disputes` — a user's challenge to one ledger entry.
 *
 * Ported from `models/ReputationDispute.ts`. Opening a dispute marks the target
 * transaction `disputed`; resolving it either `accepted` (the transaction is
 * reversed via a compensating entry) or `rejected` (it returns to `active`).
 *
 * `evidence` is a scalar array with NO default: Mongoose's `default: undefined`
 * means ABSENT, which is a nullable column with no default here — `'{}'` would
 * be a different value (an empty list the user supplied) and readers already
 * distinguish the two.
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { REPUTATION_DISPUTE_STATUSES as CONTRACT_DISPUTE_STATUSES } from '@oxyhq/contracts';
import type { ReputationDisputeStatus } from '@oxyhq/contracts';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import { reputationTransactions } from './reputationTransactions';
import { users } from './users';

/** Dispute lifecycle. */
export const REPUTATION_DISPUTE_STATUSES = [
  ...CONTRACT_DISPUTE_STATUSES,
] as const satisfies readonly ReputationDisputeStatus[];

/** `never` while the tuple covers the contract union. */
export type ReputationDisputeStatusGap = Exclude<
  ReputationDisputeStatus,
  (typeof REPUTATION_DISPUTE_STATUSES)[number]
>;

export const reputationDisputes = pgTable(
  'reputation_disputes',
  {
    id: generatedId(),
    /** `CASCADE` — a dispute about a ledger entry that no longer exists. */
    transactionId: text()
      .notNull()
      .references(() => reputationTransactions.id, { onDelete: 'cascade' }),
    /** The user raising it. `CASCADE` — their dispute goes with their account. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text().notNull(),
    status: text({ enum: REPUTATION_DISPUTE_STATUSES }).notNull().default('open'),
    /** Supporting URLs / references. Absent, not empty, when none were given. */
    evidence: text().array(),
    resolvedAt: timestamptz(),
    /**
     * Staff who resolved it. `SET NULL`: the resolver is a third party, and
     * deleting a moderator's account must not erase somebody else's dispute
     * history. NULL already reads as "no attributed resolver".
     */
    resolvedByUserId: text().references(() => users.id, { onDelete: 'set null' }),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // "This user's disputes, filtered by status". Mongo's standalone `{userId}`
    // index does not travel — a btree serves any leading prefix.
    index('reputation_disputes_user_id_status_idx').on(t.userId, t.status),
    // The staff queue reads by status alone.
    index('reputation_disputes_status_idx').on(t.status),
    // "Is this transaction under dispute?"
    index('reputation_disputes_transaction_id_idx').on(t.transactionId),

    check(
      'reputation_disputes_status_check',
      sql`${t.status} in (${sql.raw(inList(REPUTATION_DISPUTE_STATUSES))})`
    ),
    // A resolution is whole or absent. Mongo could store "resolved by nobody at
    // no time, but the status says accepted", which no reader knows how to show.
    check(
      'reputation_disputes_resolution_check',
      sql`(${t.status} in ('open', 'needs_review') and ${t.resolvedAt} is null) or (${t.status} in ('accepted', 'rejected') and ${t.resolvedAt} is not null)`
    ),
  ]
);
