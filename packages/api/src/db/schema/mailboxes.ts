/**
 * `mailboxes` — one IMAP-style folder belonging to one user.
 *
 * Ported from `models/Mailbox.ts`.
 *
 * ## The three counters are stored, and a trigger keeps them
 *
 * `total_messages`, `unseen_messages` and `size_bytes` are columns again, and
 * no application code writes them. The statement-level triggers on `messages`
 * (`mailboxCounters.ts`, migration `0206`) fold every INSERT, UPDATE, DELETE
 * and TRUNCATE into per-mailbox deltas inside the writing transaction, so a
 * write path cannot forget them. That is what the Mongo `$inc` counters lacked:
 * eighteen hand-written sites, outside a transaction, and they drifted.
 *
 * This is a reviewed exception to the contract's "denormalized counters a JOIN
 * can answer" (Nate approved stored counters on 2026-10-20, recorded in
 * `MIGRATION-CONTRACT.md`, settled decisions). The aggregate it replaces:
 *
 * ```sql
 * select mailbox_id, count(*), count(*) filter (where not seen), sum(size)
 * from messages where user_id = $1 group by mailbox_id
 * ```
 *
 * ### The measurement (D0, 2026-10-20)
 *
 * Local Postgres 17, 500 000 messages, one user holding 200 000 of them
 * (Inbox 140 000 with 20 000 unread, Archive 40 000, Sent 20 000), freshly
 * VACUUMed, warm cache, median of nine `EXPLAIN (ANALYZE, BUFFERS)` runs.
 * "serial" is `max_parallel_workers_per_gather = 0`, which is what a loaded
 * server degrades to.
 *
 * | read                     | aggregate today   | covering index*   | these columns |
 * |--------------------------|-------------------|-------------------|---------------|
 * | `listMailboxes`          | 53 ms (113 serial)| 15 ms (20 serial) | 0.08 ms       |
 * | `storedBytes` (quota)    | 49 ms (101 serial)| 12 ms (17 serial) | 0.06 ms       |
 * | `unreadCounts`           | 2.2 ms            | 2.1 ms            | 0.04 ms       |
 * | buffers, `listMailboxes` | 21 549            | 1 450             | 6             |
 *
 * \* `(user_id, mailbox_id, seen) include (size)`, 31 MB, measured with zero
 * heap fetches — its best case, right after a VACUUM. Both aggregate columns
 * grow linearly with the account; the columns do not. `storedBytes` runs on
 * every inbound delivery and every send, and `listMailboxes` is the client's
 * polling read.
 *
 * The cost moved to the writes: the trigger adds 0.16 ms to a one-row insert,
 * 0.3 ms to a 100-row flag change or move, and 0.04 ms to an update that
 * changes no counter (labels, cards, thread ids), which takes no lock.
 *
 * ### NULL means "not yet counted"
 *
 * The columns were added nullable with no default, so every mailbox that
 * existed then reads NULL until `src/scripts/backfill-mailbox-counters.ts`
 * counts it. The trigger applies `col = col + delta`, so NULL stays NULL and a
 * half-counted mailbox is never mistaken for a counted one. Mailboxes created
 * after `0207` start at the column default, 0, which is exact: a new folder is
 * empty, and the trigger was already installed by then. A reader falls back
 * to the aggregate while any of a user's counters is NULL.
 */

import { bigint, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';
import { users } from './users';

export const mailboxes = pgTable(
  'mailboxes',
  {
    id: generatedId(),
    /** A mailbox is meaningless without the account it belongs to. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Display name of the folder. */
    name: text().notNull(),
    /** Full hierarchical path, `Parent/Child`. Unique per user. */
    path: text().notNull(),
    /**
     * IMAP special-use attribute (`\Inbox`, `\Sent`, `\Trash`, …), or NULL for
     * a user-created folder. Deliberately no CHECK: the value set is open, and
     * a CHECK would reject any production row carrying a value a list forgot.
     */
    specialUse: text(),
    /** Days a message survives in this mailbox, or NULL for "keep forever". */
    retentionDays: integer(),
    /**
     * Messages in this folder. Trigger-maintained; NULL until counted. The
     * default is for folders created after the trigger existed (0207): a new
     * folder is empty, so 0 is exact. Deliberately still nullable.
     */
    totalMessages: integer().default(0),
    /** Messages in this folder with `seen = false`. Trigger-maintained; NULL until counted. */
    unseenMessages: integer().default(0),
    /**
     * Sum of `messages.size` in this folder. `bigint`, like `messages.size`.
     * Trigger-maintained; NULL until counted. Not `size`: the wire field is,
     * but a column named `size` on a folder reads as the folder's own size.
     */
    sizeBytes: bigint({ mode: 'number' }).default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('mailboxes_user_id_path_key').on(t.userId, t.path),
    // "Find this user's Inbox" — `getMailboxBySpecialUse`.
    index('mailboxes_user_id_special_use_idx').on(t.userId, t.specialUse),
    // No standalone `(user_id)` index: the unique index above leads with
    // `user_id`, and a btree serves any leading prefix.
  ],
);
