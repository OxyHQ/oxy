/**
 * `reminders` — a user's follow-up notes, optionally hung off a message.
 *
 * Ported from `models/Reminder.ts`.
 */

import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';
import { messages } from './messages';
import { users } from './users';

export const reminders = pgTable(
  'reminders',
  {
    id: generatedId(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    text: text().notNull(),
    /** When to surface it. */
    remindAt: timestamptz().notNull(),
    completed: boolean().notNull().default(false),
    pinned: boolean().notNull().default(false),
    /** When set, the reminder is suppressed until this instant. */
    snoozedUntil: timestamptz(),
    /**
     * The message this reminder was created from, if any.
     *
     * `SET NULL`, not `CASCADE`: the reminder is the USER's note and deleting a
     * mail must not delete it. NULL already means "not attached to a message",
     * which is exactly what a deleted message leaves behind.
     */
    relatedMessageId: text().references(() => messages.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // "This user's open reminders, soonest first."
    // Mongo's standalone `{userId}` is dropped: this leads with `user_id`.
    index('reminders_user_id_completed_remind_at_idx').on(t.userId, t.completed, t.remindAt),
    // The delivery cron. Mongo declared `{completed, remindAt}` `sparse`, which
    // on a COMPOUND index skips only documents missing EVERY indexed field —
    // both are always present, so it indexed everything and the `sparse` flag
    // did nothing. The predicate the cron actually uses is `completed = false`,
    // so that is what this index carries.
    index('reminders_due_idx')
      .on(t.remindAt)
      .where(sql`not ${t.completed}`),
  ]
);
