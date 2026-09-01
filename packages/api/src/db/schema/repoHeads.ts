/**
 * `repo_heads` — the O(1) chain-head pointer, one row per account.
 *
 * Ported from `models/RepoHead.ts`. Continuity verification is
 * `env.prev === head.head_record_id && env.seq === head.seq + 1`, which is a
 * constant-time check ONLY because the head is materialized here instead of
 * being derived by scanning the append-only ledger.
 *
 * ## One row per USER, not per (subject, collection)
 *
 * The Mongoose model's unique index is on `userId` alone and
 * `oxyRecordStore.getHead` looks the head up by `{ userId }` — the chain is
 * per-SUBJECT, and one account owns exactly one subject DID. `nsid`/`rkey`
 * partition records WITHIN that one chain for last-writer-wins materialization;
 * they do not fork it. Splitting the head per collection would fork `seq` and
 * break the single monotone sequence the whole design rests on.
 *
 * ## The head advance must be atomic with the append
 *
 * `oxyRecordStore.append` writes the `signed_records` row and this row in one
 * transaction. If they can diverge, the chain forks: a head pointing at a record
 * that was never stored makes every later `prev` check fail, and a head left
 * behind lets a second device re-use a `seq` that is already taken. Postgres has
 * real transactions, so the session-less fallback in `withTransaction` (which
 * silently re-runs the pair NON-atomically when the deployment has no replica
 * set) is DELETED on port rather than translated — see the migration contract.
 *
 * The `head_record_id` foreign key is the second half of that guarantee: a head
 * can only ever point at a record that exists.
 */

import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { signedRecords } from './signedRecords';
import { users } from './users';

export const repoHeads = pgTable(
  'repo_heads',
  {
    id: generatedId(),
    /** The account that owns this chain. Exactly one head per account. */
    userId: text()
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The subject DID the chain is about. */
    subjectDid: text().notNull(),
    /** `seq` of the head (latest) record. */
    seq: integer().notNull(),
    /**
     * Content address of the head record.
     *
     * `CASCADE`: without its record there is no head — the pointer would name a
     * content address nothing can produce. The only deleter is the account
     * erasure that removes this row anyway.
     */
    headRecordId: text()
      .notNull()
      .references(() => signedRecords.recordId, { onDelete: 'cascade' }),
    /** Chained records appended so far. */
    recordCount: integer().notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('repo_heads_seq_check', sql`${t.seq} >= 0`),
    check('repo_heads_record_count_check', sql`${t.recordCount} >= 0`),
  ]
);
