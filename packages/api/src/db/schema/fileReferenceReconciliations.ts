/**
 * `file_reference_reconciliations` + `file_reference_reconciliation_items` —
 * an application's inventory of its own references for ONE `entity_type`,
 * received in pages and then diffed against `file_references` (ADR 0043 D6).
 *
 * The safety net under per-write bookkeeping: an application that missed a
 * reference (a crash between two writes, an old bug) sends what it really
 * uses — `begin` → paged `put` of `(file_id, entity_id)` → `commit` — and Oxy
 * adds what is missing and removes what is stale
 * (`services/fileReferenceReconciliation.service.ts`).
 *
 * ## One open session per (application, entity type)
 *
 * Two inventories of the same set committed concurrently would each remove
 * what the other added. `file_reference_reconciliations_open_key` makes a
 * second `begin` a unique violation the route answers 409; a session that
 * expired while open is retired (`abandoned`) by the next `begin` before it
 * inserts, so an abandoned client blocks nothing past its expiry.
 *
 * ## A commit runs under a lease
 *
 * A commit can outlast an HTTP request (a large inventory against a cold
 * cache), so it holds `lease_expires_at` — the database's clock, renewed
 * after every batch — while `committing`. The request that starts it may hand
 * it off (`background`) and the client reads the outcome back; a commit whose
 * task died (a deploy) stops renewing, and the large-upload worker resumes it
 * once the lease has passed. Every step is idempotent: the diff is recomputed.
 * `commit_dry_run` says which kind of commit is running, `commit_error` why
 * the last one failed (cleared when the next one starts).
 *
 * ## Expiry
 *
 * `expires_at` is a sliding deadline (each page extends it). Every read of a
 * session filters on it (class A of `db/expiry.ts`); the sweep deletes the row
 * a day after it, and its items with it (`CASCADE`). A committed session's
 * items are deleted by the commit itself — they are the bulk.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { applications } from './applications';

/**
 * `open` receives pages; `committing` is being diffed (one commit at a time);
 * `committed` is done; `abandoned` expired or was released by its client.
 */
export const FILE_REFERENCE_RECONCILIATION_STATUSES = [
  'open',
  'committing',
  'committed',
  'abandoned',
] as const;

export type FileReferenceReconciliationStatus =
  (typeof FILE_REFERENCE_RECONCILIATION_STATUSES)[number];

/** The statuses that hold the (application, entity type) slot. */
export const FILE_REFERENCE_RECONCILIATION_ACTIVE_STATUSES = ['open', 'committing'] as const;

/** Rows past their deadline outlive it by a day, so a late page reads "expired", not "unknown". */
export const FILE_REFERENCE_RECONCILIATION_RETENTION_SECONDS = 24 * 60 * 60;

/** What a commit reports. */
export interface FileReferenceReconciliationCounts {
  added: number;
  removed: number;
  unchanged: number;
  refused: number;
}

export const fileReferenceReconciliations = pgTable(
  'file_reference_reconciliations',
  {
    id: generatedId(),
    /** The application whose references are reconciled — the token's, never a field. */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),
    entityType: text().notNull(),
    status: text({ enum: FILE_REFERENCE_RECONCILIATION_STATUSES }).notNull().default('open'),
    /** Distinct `(file_id, entity_id)` pairs received so far. */
    itemCount: integer().notNull().default(0),
    /** Sliding: each accepted page moves it forward. */
    expiresAt: timestamptz().notNull(),
    committedAt: timestamptz(),
    /** The last commit's counts (a dry run's too, which releases the session). */
    result: jsonb().$type<FileReferenceReconciliationCounts & { dryRun: boolean }>(),
    /** While `committing`: the running commit's lease (see "A commit runs under a lease"). */
    leaseExpiresAt: timestamptz(),
    /** While `committing`: whether the running commit is a dry run. */
    commitDryRun: boolean(),
    /** Why the last commit failed; cleared when the next one starts. */
    commitError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('file_reference_reconciliations_open_key')
      .on(t.applicationId, t.entityType)
      .where(
        sql`${t.status} in (${sql.raw(
          FILE_REFERENCE_RECONCILIATION_ACTIVE_STATUSES.map((value) => `'${value}'`).join(', '),
        )})`,
      ),
    // The worker's scan for a commit whose task died.
    index('file_reference_reconciliations_committing_lease_idx')
      .on(t.leaseExpiresAt)
      .where(sql`${t.status} = 'committing'`),
    // The expiry sweep's range scan (`db/expiry.ts`).
    index('file_reference_reconciliations_expires_at_idx').on(t.expiresAt),
    check(
      'file_reference_reconciliations_status_check',
      sql`${t.status} in (${sql.raw(
        FILE_REFERENCE_RECONCILIATION_STATUSES.map((value) => `'${value}'`).join(', '),
      )})`,
    ),
    check('file_reference_reconciliations_item_count_check', sql`${t.itemCount} >= 0`),
  ],
);

export const fileReferenceReconciliationItems = pgTable(
  'file_reference_reconciliation_items',
  {
    sessionId: text()
      .notNull()
      .references(() => fileReferenceReconciliations.id, { onDelete: 'cascade' }),
    /**
     * The file the application says it uses. Deliberately no foreign key: a
     * file that does not exist is an answer (`refused`), not an insert error,
     * and a page must never fail because one id in it is stale.
     */
    fileId: text().notNull(),
    /** The entity's id in the application's own database. */
    entityId: text().notNull(),
  },
  (t) => [
    // One pair once per session; the key also leads every diff join.
    primaryKey({ columns: [t.sessionId, t.fileId, t.entityId] }),
  ],
);
