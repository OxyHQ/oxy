/**
 * `storage_object_deletions` — S3 objects owed a delete because the account
 * that uploaded them was deleted (OxyHQ/Mention#1178).
 *
 * `files.owner_user_id` CASCADEs, so `DELETE /users/me` has always removed the
 * account's asset ROWS — and with them the only record of where the bytes are.
 * Nothing deleted the objects: a deleted person's photos and videos stayed in the
 * media bucket, and a public one stayed reachable on the CDN at its
 * content-addressed key. This table is the durable to-do list that closes that.
 *
 * ## Written in the SAME transaction as the deletion
 *
 * `recordAccountStorageDeletion` reads the account's asset keys and inserts one
 * row per target in the transaction that deletes (or archives) the account, so
 * the keys are captured before the cascade drops them, and a deletion that
 * rolls back owes nothing. `accountStorageDeletion.worker.ts` then deletes the
 * objects, at least once, under a lease, with backoff and no dead letter: a
 * permanent failure (a revoked IAM grant) keeps retrying every six hours and
 * converges once it is fixed, rather than silently abandoning the bytes.
 *
 * ## One row per target, not per file
 *
 * A target is the BASE key (without the CDN `public/` prefix — the worker
 * deletes both spellings, since a public asset may also carry a legacy
 * backfilled copy) of either one object (`kind = 'object'`: the original) or a
 * variant directory (`kind = 'prefix'`: `variants/<y>/<m>/<pp>/<sha256>/`, which
 * holds every rendition AND the HLS segments no `file_variants` row lists).
 *
 * `sha256` is the content hash the target belongs to. Storage is content-
 * addressed and upload dedup is global, so the worker refuses to delete a
 * target a LIVE asset with the same hash still uses (someone re-uploaded the
 * same bytes after the deletion) and records `outcome = 'retained_shared'`.
 *
 * ## `account_id` carries no foreign key, deliberately
 *
 * On a hard delete the account row is gone before the worker runs — the same
 * reason `account_events.user_id` has none. Completed rows are swept after
 * {@link STORAGE_OBJECT_DELETION_RETENTION_SECONDS} (`db/expiry.ts`); an
 * unfinished row is never swept.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from '@oxy.so/db';

/** Why the objects are owed a delete. One reason today; a closed set so a new one is a decision. */
export const STORAGE_OBJECT_DELETION_REASONS = ['account.deleted'] as const;

/** `object`: one key. `prefix`: every key under a variant directory. */
export const STORAGE_OBJECT_DELETION_KINDS = ['object', 'prefix'] as const;

/** `deleted`: the objects are gone. `retained_shared`: a live asset with the same content still uses them. */
export const STORAGE_OBJECT_DELETION_OUTCOMES = ['deleted', 'retained_shared'] as const;

export type StorageObjectDeletionKind = (typeof STORAGE_OBJECT_DELETION_KINDS)[number];
export type StorageObjectDeletionOutcome = (typeof STORAGE_OBJECT_DELETION_OUTCOMES)[number];

/**
 * How long a COMPLETED row is kept: thirty days, the same window as the
 * account event it follows. Long enough to answer "were this person's files
 * deleted, and when"; after that the deleted account's id goes too.
 */
export const STORAGE_OBJECT_DELETION_RETENTION_SECONDS = 30 * 24 * 60 * 60;

function inList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(', ');
}

export const storageObjectDeletions = pgTable(
  'storage_object_deletions',
  {
    id: generatedId(),
    reason: text({ enum: STORAGE_OBJECT_DELETION_REASONS }).notNull(),
    /** The deleted account whose uploads these were. No foreign key: see the header. */
    accountId: text().notNull(),
    kind: text({ enum: STORAGE_OBJECT_DELETION_KINDS }).notNull(),
    /** The base key (or directory, ending in `/`), without the `public/` prefix. */
    target: text().notNull(),
    /** The content hash the target stores; the shared-content guard reads it. */
    sha256: text().notNull(),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamptz()
      .notNull()
      .default(sql`now()`),
    claimedAt: timestamptz(),
    claimedBy: text(),
    completedAt: timestamptz(),
    outcome: text({ enum: STORAGE_OBJECT_DELETION_OUTCOMES }),
    lastError: text(),
    createdAt: createdAt(),
  },
  (t) => [
    // Recording the same account twice (a retried request) owes each target once.
    unique('storage_object_deletions_account_id_kind_target_key').on(t.accountId, t.kind, t.target),
    check('storage_object_deletions_reason_check', sql`${t.reason} in (${sql.raw(inList(STORAGE_OBJECT_DELETION_REASONS))})`),
    check('storage_object_deletions_kind_check', sql`${t.kind} in (${sql.raw(inList(STORAGE_OBJECT_DELETION_KINDS))})`),
    check(
      'storage_object_deletions_outcome_check',
      sql`${t.outcome} is null or ${t.outcome} in (${sql.raw(inList(STORAGE_OBJECT_DELETION_OUTCOMES))})`,
    ),
    // Finished exactly when it has an outcome.
    check('storage_object_deletions_completed_check', sql`(${t.completedAt} is null) = (${t.outcome} is null)`),
    check('storage_object_deletions_attempts_check', sql`${t.attempts} >= 0`),
    // The worker's claim: unfinished rows in due order.
    index('storage_object_deletions_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.completedAt} is null`),
    // The expiry sweep's range predicate (`db/expiry.ts`).
    index('storage_object_deletions_completed_at_idx').on(t.completedAt),
  ]
);

export type StorageObjectDeletionRow = typeof storageObjectDeletions.$inferSelect;
