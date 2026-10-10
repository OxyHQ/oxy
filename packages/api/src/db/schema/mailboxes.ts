/**
 * `mailboxes` — one IMAP-style folder belonging to one user.
 *
 * Ported from `models/Mailbox.ts`.
 *
 * ## The three counters are not stored
 *
 * `totalMessages`, `unseenMessages` and `size` are not columns. Stored on the
 * mailbox they would be a cached aggregate maintained by hand at every write
 * site in `email.service.ts`, outside a transaction — so it drifts, and nothing
 * notices. `CONVENTIONS.md` refuses that shape.
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
