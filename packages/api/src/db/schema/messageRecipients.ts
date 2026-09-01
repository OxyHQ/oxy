/**
 * `message_recipients` — the `to`, `cc` and `bcc` of one message.
 *
 * Ported from the three `[EmailAddressSchema]` arrays in `models/Message.ts`.
 *
 * ## One table, not three
 *
 * The three arrays hold the SAME entity — an addressee — differing only in which
 * header carried it. Three tables would be three identical schemas, three
 * indexes, and a three-way UNION at every read that asks "was this address a
 * recipient". A `kind` discriminator says the one thing that actually differs.
 *
 * ## Not `jsonb`
 *
 * `jsonb` would make "which messages went to this address" a containment scan
 * and "who do I mail most" impossible to index at all. Recipient search is an
 * ordinary read, so recipients are ordinary rows.
 *
 * ## `ord` is data, not decoration
 *
 * A `To:` header is an ORDERED list and the client renders it in that order.
 * SQL has no implicit row order, so the position is a column — and it is
 * unique per (message, kind), which is what makes the ordering total.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { generatedId } from '@oxyhq/db';
import { messages } from './messages';

/** Which header carried the address. */
export const MESSAGE_RECIPIENT_KINDS = ['to', 'cc', 'bcc'] as const;

export const messageRecipients = pgTable(
  'message_recipients',
  {
    id: generatedId(),
    messageId: text()
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    kind: text({ enum: MESSAGE_RECIPIENT_KINDS }).notNull(),
    /** Position within its own header, 0-based. */
    ord: integer().notNull(),
    /** Display name, or NULL when the header carried only an address. */
    name: text(),
    /**
     * The address. Mongoose stored it `lowercase: true, trim: true`; that is
     * application behaviour with no Postgres counterpart, so the MIME parse and
     * compose paths must re-apply it — see the same note on `messages`.
     */
    address: text().notNull(),
  },
  (t) => [
    // Rebuild one message's headers in order.
    unique('message_recipients_message_id_kind_ord_key').on(t.messageId, t.kind, t.ord),
    // "Which messages went to this address" — the read `jsonb` could not serve.
    index('message_recipients_address_idx').on(t.address),
    check(
      'message_recipients_kind_check',
      sql`${t.kind} in (${sql.raw(
        MESSAGE_RECIPIENT_KINDS.map((value) => `'${value}'`).join(', ')
      )})`
    ),
    check('message_recipients_ord_check', sql`${t.ord} >= 0`),
  ]
);
