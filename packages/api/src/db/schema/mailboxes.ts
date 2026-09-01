/**
 * `mailboxes` — one IMAP-style folder belonging to one user.
 *
 * Ported from `models/Mailbox.ts`.
 *
 * ## The three counters do not travel
 *
 * Mongo stored `totalMessages`, `unseenMessages` and `size` on the mailbox and
 * kept them current with **eighteen separate `$inc` sites** in
 * `email.service.ts` (399, 583, 608, 611, 654, 740, 855, 1061, 1117, 1149,
 * 1152, 1180, 1183, 1273, 1995, 2557, 2572 …). That is the exact shape
 * `CONVENTIONS.md` refuses to inherit: a cached aggregate that exists only
 * because the store cannot JOIN, maintained by hand, outside a transaction, in
 * twenty-one places — so it drifts, and nothing notices.
 *
 * Postgres computes all three from `messages`, and the DTO is unchanged
 * because the numbers are the same numbers:
 *
 * ```sql
 * select m.*,
 *        coalesce(s.total, 0)  as total_messages,
 *        coalesce(s.unseen, 0) as unseen_messages,
 *        coalesce(s.bytes, 0)  as size
 * from mailboxes m
 * left join (
 *   select mailbox_id,
 *          count(*)                          as total,
 *          count(*) filter (where not seen)  as unseen,
 *          sum(size)                         as bytes
 *   from messages where user_id = $1 group by mailbox_id
 * ) s on s.mailbox_id = m.id
 * where m.user_id = $1
 * ```
 *
 * `messages_mailbox_id_received_at_idx` serves the count and the sum;
 * `messages_unseen_idx` (partial, `where not seen`) makes the unseen count an
 * index-only scan over just the unread rows. Re-adding a stored counter is
 * purely additive and needs a MEASUREMENT first — never inheritance.
 */

import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
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
     * a user-created folder. Deliberately no CHECK: Mongo declared no enum, and
     * a CHECK would reject any production row carrying a value this list forgot.
     */
    specialUse: text(),
    /** Days a message survives in this mailbox, or NULL for "keep forever". */
    retentionDays: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('mailboxes_user_id_path_key').on(t.userId, t.path),
    // "Find this user's Inbox" — `getMailboxBySpecialUse`.
    index('mailboxes_user_id_special_use_idx').on(t.userId, t.specialUse),
    // Mongo also declared a standalone `{userId: 1}`. Dropped: the unique index
    // above leads with `user_id`, and a btree serves any leading prefix.
  ]
);
