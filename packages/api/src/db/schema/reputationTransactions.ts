/**
 * `reputation_transactions` — the immutable reputation ledger.
 *
 * Ported from `models/ReputationTransaction.ts`. Entries are never deleted. A
 * correction is either a REVERSAL (the original flips to `reversed` and a new
 * `active` row with negated points and `reversed_transaction_id` pointing at it
 * is appended, so the pair nets to zero) or a VOID (the original flips to
 * `voided` and is simply excluded, with no compensating entry). A balance is
 * always re-derivable by aggregating the `active` rows.
 *
 * ## Idempotency: a plain UNIQUE, not a partial one
 *
 * Mongo's `{applicationId, sourceActionId}` index carries
 * `partialFilterExpression: { …: { $exists: true } }` on BOTH fields, because
 * Mongo treats a missing field as `null` and every manual/staff award (which has
 * neither) would collide on it. Postgres unique indexes treat NULLs as DISTINCT
 * by default, so `UNIQUE (application_id, source_action_id)` already exempts any
 * row missing either field — the same semantic with none of the machinery.
 * `CONVENTIONS.md` names this workaround and forbids carrying it over.
 *
 * ## `points` is an `integer`
 *
 * Every figure that reaches it is an integer: the `points` of a
 * `ReputationRule`, a `ModerationPolicy` severity entry, or the negation of one.
 * A fractional value would be a bug in whichever authority produced it, so a
 * `double precision` column would preserve the bug rather than the data. If one
 * exists in production the backfill fails and names the row, which is the
 * correct outcome.
 *
 * ## Who a delete takes with it
 *
 * `user_id` is the SUBJECT — the ledger is about them, so it `CASCADE`s with the
 * account. `created_by_user_id` and `reviewed_by_user_id` are OTHER people
 * (the liker, the reporter, the staff reviewer) and are `SET NULL`: NULL there
 * already means "no attributed actor", and a CASCADE would delete a stranger's
 * ledger row because a moderator exercised erasure.
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  REPUTATION_TARGET_ENTITY_TYPES as CONTRACT_TARGET_ENTITY_TYPES,
  REPUTATION_TRANSACTION_STATUSES as CONTRACT_TRANSACTION_STATUSES,
} from '@oxyhq/contracts';
import type { ReputationTargetEntityType, ReputationTransactionStatus } from '@oxyhq/contracts';
import { applicationCredentials } from './applicationCredentials';
import { applications } from './applications';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import { REPUTATION_CATEGORIES } from './reputationRules';
import { users } from './users';

/** Lifecycle status — only `active` counts toward a balance. */
export const REPUTATION_TRANSACTION_STATUSES = [
  ...CONTRACT_TRANSACTION_STATUSES,
] as const satisfies readonly ReputationTransactionStatus[];

/** `never` while the tuple covers the contract union. */
export type ReputationTransactionStatusGap = Exclude<
  ReputationTransactionStatus,
  (typeof REPUTATION_TRANSACTION_STATUSES)[number]
>;

/** Kind of entity an action targeted. */
export const REPUTATION_TARGET_ENTITY_TYPES = [
  ...CONTRACT_TARGET_ENTITY_TYPES,
] as const satisfies readonly ReputationTargetEntityType[];

/** `never` while the tuple covers the contract union. */
export type ReputationTargetEntityTypeGap = Exclude<
  ReputationTargetEntityType,
  (typeof REPUTATION_TARGET_ENTITY_TYPES)[number]
>;

export const reputationTransactions = pgTable(
  'reputation_transactions',
  {
    id: generatedId(),
    /** The subject whose balance moves. `CASCADE` — the ledger is about them. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Signed delta. Positive awards, negative penalties and reversals. */
    points: integer().notNull(),
    /** The rule/action key that produced it, e.g. `post_created`. */
    actionType: text().notNull(),
    category: text({ enum: REPUTATION_CATEGORIES }).notNull(),
    /** Reporting application. Constraint deferred until `applications` lands. */
    applicationId: text()
      .references(() => applications.id, { onDelete: 'set null' }),
    /** The specific credential used. Constraint deferred with `application_credentials`. */
    credentialId: text()
      .references(() => applicationCredentials.id, { onDelete: 'set null' }),
    /** Opaque id of the originating action in the source system — the idempotency key. */
    sourceActionId: text(),
    /** Source-system action type, e.g. `report_confirmed`. */
    sourceActionType: text(),
    /** Id of the targeted entity, in the SOURCE system's id space. */
    targetEntityId: text(),
    targetEntityType: text({ enum: REPUTATION_TARGET_ENTITY_TYPES }),
    status: text({ enum: REPUTATION_TRANSACTION_STATUSES }).notNull().default('active'),
    /**
     * Set only on a compensating reversal; names the original it reverses.
     *
     * `CASCADE`, and safe: `reverseTransaction` always writes the compensating
     * entry for the SAME subject, so the pair lives and dies with one account.
     */
    reversedTransactionId: text().references((): AnyPgColumn => reputationTransactions.id, {
      onDelete: 'cascade',
    }),
    reason: text(),
    /**
     * Free-form structured metadata from the source system. Genuinely
     * shape-less — each application decides its own keys — so `jsonb` here is
     * the intended use, not a dumping ground.
     */
    metadata: jsonb(),
    /** The actor who caused the change. `SET NULL` — see the header. */
    createdByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    /** Staff who reversed/voided/resolved it. `SET NULL` — see the header. */
    reviewedByUserId: text().references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Balance recomputation reads a user's `active` rows. Mongo's standalone
    // `{userId}` index does not travel: a btree serves any leading prefix.
    index('reputation_transactions_user_id_status_idx').on(t.userId, t.status),
    // Ledger listing, newest first.
    index('reputation_transactions_user_id_created_at_idx').on(t.userId, t.createdAt.desc()),
    // Per-application usage and auditing. Partial: the vast majority of rows are
    // not attributed to an application at all.
    index('reputation_transactions_application_id_idx')
      .on(t.applicationId)
      .where(sql`${t.applicationId} is not null`),
    // The idempotency guard. See the header on why it is not partial.
    uniqueIndex('reputation_transactions_source_action_key').on(t.applicationId, t.sourceActionId),
    // The staff dispute/review queue reads by status alone.
    index('reputation_transactions_status_idx').on(t.status),

    check(
      'reputation_transactions_category_check',
      sql`${t.category} in (${sql.raw(inList(REPUTATION_CATEGORIES))})`
    ),
    check(
      'reputation_transactions_status_check',
      sql`${t.status} in (${sql.raw(inList(REPUTATION_TRANSACTION_STATUSES))})`
    ),
    check(
      'reputation_transactions_target_entity_type_check',
      sql`${t.targetEntityType} is null or ${t.targetEntityType} in (${sql.raw(inList(REPUTATION_TARGET_ENTITY_TYPES))})`
    ),
    // A transaction cannot reverse itself.
    check(
      'reputation_transactions_reversal_not_self_check',
      sql`${t.reversedTransactionId} is null or ${t.reversedTransactionId} <> ${t.id}`
    ),
  ]
);
