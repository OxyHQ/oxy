/**
 * `email_unsubscribed_senders` — senders a user has unsubscribed from.
 *
 * The subscriptions view lists every sender with three or more received
 * messages, and an unsubscribe used to record nothing. The sender therefore
 * stayed in the list, looked like the unsubscribe had failed, and every retry
 * fired another one-click POST, GET or `mailto:` message at the sender. A row
 * here is what lets the list say "unsubscribed" and lets a repeat request
 * return the first result instead of contacting the sender again.
 *
 * Not `email_suppressions`: that table stops this platform SENDING to an
 * address. This one records what a user asked of a sender that mails THEM —
 * reusing it would refuse the user's own outbound mail to that sender.
 */

import { sql } from 'drizzle-orm';
import { check, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import { users } from './users';

/**
 * How the unsubscribe was carried out — the `method` the endpoint reports.
 * `blocked` means the sender's mail was moved to Spam, either because the user
 * asked for that or because no List-Unsubscribe route worked.
 */
export const EMAIL_UNSUBSCRIBE_METHODS = ['one-click', 'http', 'mailto', 'blocked'] as const;
export type EmailUnsubscribeMethod = (typeof EMAIL_UNSUBSCRIBE_METHODS)[number];

export const emailUnsubscribedSenders = pgTable(
  'email_unsubscribed_senders',
  {
    id: generatedId(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The sender, lower-cased and trimmed — the same normalisation
     * `messages.from_address` is stored with, so the two compare with `=`.
     */
    senderAddress: text().notNull(),
    /** The most recent successful method; `blocked` once the user blocks. */
    method: text({ enum: EMAIL_UNSUBSCRIBE_METHODS }).notNull(),
    /** When the user FIRST unsubscribed. A later block does not move it. */
    unsubscribedAt: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // The unique constraint leads with `user_id`, so it also serves the
  // per-user reads; no separate index.
  (t) => [
    unique('email_unsubscribed_senders_user_id_sender_address_key').on(t.userId, t.senderAddress),
    check(
      'email_unsubscribed_senders_method_check',
      sql`${t.method} in (${sql.raw(EMAIL_UNSUBSCRIBE_METHODS.map((v) => `'${v}'`).join(', '))})`,
    ),
  ],
);
