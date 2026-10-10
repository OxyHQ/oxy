/**
 * `messages` — one stored email.
 *
 * Ported from `models/Message.ts`, the second-richest model in the package
 * (fourteen indexes, four `select: false` bodies, three embedded arrays and a
 * weighted text index). Each of those became something different, and the
 * reason is on the declaration.
 *
 * ## What became a child table, and why not `jsonb`
 *
 * - `to` / `cc` / `bcc` → `message_recipients`, ONE table with a `kind`
 *   discriminator. `jsonb` would have destroyed recipient search: "who did I
 *   mail" and "which messages went to this address" are ordinary reads, and a
 *   `jsonb` array can only answer them with a containment operator over an
 *   index that cannot also carry the ordering the UI renders.
 * - `attachments` → `message_attachments`. `file_id` is a REFERENCE, so it is
 *   a real, indexed foreign key to `files`.
 *
 * ## What stayed on this row, and why not a child table
 *
 * - `from` is required and `from.address` is indexed, so it is two columns.
 *   A single-valued sub-document is a column pair, not a table.
 * - `replyTo` is the same shape, optional.
 * - `flags` is six booleans; three of them are indexed. Six columns.
 * - `highlights` is display-only — never filtered, never sorted, never joined —
 *   so `jsonb` is the honest type rather than a table nobody queries.
 * - `card.data` is genuinely `Mixed`; the rest of the card has a known shape and
 *   is therefore columns.
 *
 * ## The four hidden bodies
 *
 * `text`, `html`, `headers` and `encrypted_body` were `select: false`. Drizzle
 * returns every column it is asked for, so they are in `protectedColumns.ts` —
 * `db.select(publicColumns(messages)).from(messages)` cannot return them and a
 * serializer that reads one fails `tsc`. `search_vector` is protected too, for a
 * reason that is easy to miss: it is derived FROM `text`, and
 * a `tsvector` carries every lexeme with its position, so shipping it hands back
 * a reconstructable copy of the body the other guard exists to withhold.
 *
 * `headers` is the ONE place third-party SMTP `Received:` IPs are retained
 * (owner-approved, `AGENTS.md` "No User IPs At Rest"). It is stored whole and
 * never stripped — and no other column here holds an IP.
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
} from 'drizzle-orm/pg-core';
import { MESSAGE_CARD_TYPES } from '@oxy.so/contracts';
import { createdAt, generatedId, timestamptz, tsvector, updatedAt } from '@oxy.so/db';
import { mailboxes } from './mailboxes';
import { users } from './users';

/** Structured data cards the AI extractor can emit. The vocabulary is the wire contract's. */
export { MESSAGE_CARD_TYPES };

/**
 * One RFC 5322 address as the mail subsystem passes it around: the optional
 * display name and the address itself.
 *
 * Declared here rather than on `message_recipients` because it is not one
 * table's shape — it is what `from_name`/`from_address` and
 * `reply_to_name`/`reply_to_address` hold on THIS row, what each
 * `message_recipients` row holds, and what the SMTP transport takes. `name` is
 * optional-undefined while the columns are nullable; the read path coalesces.
 */
export interface EmailAddress {
  name?: string;
  address: string;
}

/**
 * One extracted key/value the client renders as a chip.
 *
 * Display-only: nothing filters, sorts or joins on it, which is what makes
 * `jsonb` the right type here and the wrong type for the recipients.
 */
export interface MessageHighlight {
  readonly type: string;
  readonly value: string;
  readonly label: string;
}

/**
 * Text-search configuration: English. A LITERAL: the one-argument `to_tsvector`
 * reads `default_text_search_config` at runtime and is therefore STABLE, which
 * Postgres refuses in a generated column.
 */
const SEARCH_CONFIGURATION = 'english';

/**
 * `subject` weighted ten times `text`.
 *
 * Postgres weights are fixed multipliers — A = 1.0, B = 0.4, C = 0.2, D = 0.1 —
 * so A over D is exactly the 10:1 ratio. B or C would silently re-rank every
 * search result.
 *
 * `"text"` is quoted because it is also a type name; unquoted, the expression
 * is at the mercy of the parser resolving an identifier that could be either.
 * The names are spelled in SQL rather than interpolated because a generated
 * expression is built before the table object exists — `__tests__/messages.
 * test.ts` asserts the column actually populates from both fields, so a name
 * that drifts fails loudly instead of indexing nothing.
 */
const SEARCH_VECTOR_EXPRESSION = sql.raw(
  `setweight(to_tsvector('${SEARCH_CONFIGURATION}', coalesce(subject, '')), 'A') || ` +
    `setweight(to_tsvector('${SEARCH_CONFIGURATION}', coalesce("text", '')), 'D')`,
);

export const messages = pgTable(
  'messages',
  {
    id: generatedId(),
    /** The mailbox owner. Deleting the account deletes their mail. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The folder the message currently sits in. `CASCADE` matches what
     * `deleteMailbox` already does by hand (`email.service.ts:445`: delete the
     * messages, then the mailbox) — the difference is that Postgres cannot
     * forget the first step.
     */
    mailboxId: text()
      .notNull()
      .references(() => mailboxes.id, { onDelete: 'cascade' }),
    /** RFC 5322 `Message-ID`. Not a row id — see `deferredForeignKeys.ts`. */
    messageId: text().notNull(),

    // ---- from / reply-to ---------------------------------------------------
    /** Display name of the sender, or NULL when the header carried only an address. */
    fromName: text(),
    /** Sender address, stored lower-cased and trimmed by the CALL SITE (see below). */
    fromAddress: text().notNull(),
    replyToName: text(),
    replyToAddress: text(),

    /**
     * NOT NULL with no DEFAULT. `''` for a missing subject is an APPLICATION
     * default — and `''` is deliberately not available as a column default here
     * (`schemaInvariants.test.ts`, "never defaults a column to the empty
     * string"). A subjectless message still stores `''`, exactly as today; the
     * writer supplies it, and an insert that forgets fails loudly instead of
     * inventing a value.
     */
    subject: text().notNull(),

    // ---- bodies (PROTECTED — see protectedColumns.ts) ----------------------
    /** Plain-text body. */
    text: text(),
    /** HTML body. */
    html: text(),
    /**
     * Every RFC 5322 header, as received. The shape is a flat string→string
     * dictionary with arbitrary keys, which is
     * genuinely shape-less and therefore `jsonb` rather than columns.
     */
    headers: jsonb().$type<Record<string, string>>().notNull().default({}),
    /** Body ciphertext when `encrypted` is true. */
    encryptedBody: text(),

    // ---- flags (six booleans; three are indexed) ---------------------------
    seen: boolean().notNull().default(false),
    starred: boolean().notNull().default(false),
    answered: boolean().notNull().default(false),
    forwarded: boolean().notNull().default(false),
    draft: boolean().notNull().default(false),
    pinned: boolean().notNull().default(false),

    /**
     * Label NAMES, not label ids — `email.service.ts:1445` pulls by
     * `label.name`, so the value here is the user-visible string a `labels` row
     * happens to carry. A native `text[]` with a GIN index answers the
     * membership read.
     */
    labels: text().array().notNull().default([]),

    // ---- extracted card ---------------------------------------------------
    /** Non-NULL exactly when a card was extracted; the CHECK below states that. */
    cardType: text({ enum: MESSAGE_CARD_TYPES }),
    /** Genuinely shape-less — it differs per card type. */
    cardData: jsonb().$type<Record<string, unknown>>(),
    cardConfidence: doublePrecision(),
    cardExtractedAt: timestamptz(),

    /** Display-only chips. Empty by default, so this is NOT NULL. */
    highlights: jsonb().$type<MessageHighlight[]>().notNull().default([]),

    encrypted: boolean().notNull().default(false),
    spamScore: doublePrecision(),
    spamAction: text(),

    /**
     * Total message size in bytes. `bigint` rather than `integer` for every byte
     * count in this schema: a backfill must never fail on a row whose stored
     * size is larger than the transport that produced it should have allowed.
     */
    size: bigint({ mode: 'number' }).notNull(),

    /**
     * The `Message-ID` the RELAY gave a message we sent, when it replaced ours.
     *
     * SES rewrites `Message-ID` to `<id@region.amazonses.com>`, so a recipient's
     * reply names THAT id in `In-Reply-To`, never `message_id`. Carrying it as a
     * thread key is what lets the answer join the conversation it answers.
     * NULL for received mail and for relays that keep our header.
     */
    relayMessageId: text(),
    /**
     * For received mail that is the sender's OWN outbound message coming back
     * (they addressed themselves, or were on the recipient list): the Sent row
     * it is a copy of, matched by the `X-Oxy-Sent-Id` header we stamp on send.
     * A conversation shows that message once, not twice. `SET NULL`: deleting the
     * Sent copy leaves this one an ordinary message.
     */
    sentCopyOf: text().references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),

    /** RFC `In-Reply-To`. */
    inReplyTo: text(),
    /** RFC `References`, ordered oldest-first. Empty by default. */
    references: text().array().notNull().default([]),
    /** The `+tag` part when the message arrived at `user+tag@oxy.so`. */
    aliasTag: text(),

    /** When set, the message is hidden until this instant. */
    snoozedUntil: timestamptz(),
    /**
     * Where to put it back when the snooze ends.
     *
     * `SET NULL`, never `CASCADE`: cascading would delete the MESSAGE because
     * the folder it used to live in was removed. NULL then means what it
     * already means — no return address — and the unsnooze falls back to the
     * Inbox, which is the same answer it gives for a message that was never
     * snoozed from anywhere.
     */
    snoozedFromMailbox: text().references(() => mailboxes.id, { onDelete: 'set null' }),
    /** When set, the message is a draft queued to send at this instant. */
    scheduledAt: timestamptz(),
    /** Optimistic-concurrency revision for drafts; starts at one for every message. */
    draftRevision: integer().notNull().default(1),

    readReceiptRequested: boolean().notNull().default(false),
    readReceiptSent: boolean().notNull().default(false),

    /** The `Date:` header of the original message. */
    date: timestamptz().notNull(),
    /** When this server accepted it. */
    receivedAt: timestamptz().notNull().defaultNow(),

    /** GENERATED — the weighted full-text search vector. */
    searchVector: tsvector().generatedAlwaysAs(SEARCH_VECTOR_EXPRESSION),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // ---- indexes ------------------------------------------------------------
    // (1) The primary listing read. EVERY list sorts pinned-then-date
    // (`email.service.ts`), so `pinned` sits in the middle: the same index
    // answers the filter AND the sort; nothing orders by `date` alone.
    index('messages_user_id_mailbox_id_pinned_date_idx').on(
      t.userId,
      t.mailboxId,
      t.pinned.desc(),
      t.date.desc(),
    ),
    // (2) + (3) + (4) Threading: by Message-ID, by In-Reply-To, and by any
    // entry of References. The third is a GIN containment read.
    index('messages_user_id_message_id_idx').on(t.userId, t.messageId),
    index('messages_user_id_in_reply_to_idx').on(t.userId, t.inReplyTo),
    index('messages_user_id_relay_message_id_idx')
      .on(t.userId, t.relayMessageId)
      .where(sql`${t.relayMessageId} is not null`),
    index('messages_references_idx').using('gin', t.references),
    // (5) Unread. Only `seen = false` is ever queried
    // (`email.service.ts:466`, `emailInbound.ts:148`). A partial index over the
    // unread rows alone is smaller, serves the same reads, AND makes the unseen
    // count that replaced `mailboxes.unseen_messages` an index-only scan.
    index('messages_unseen_idx')
      .on(t.userId, t.mailboxId, t.pinned.desc(), t.date.desc())
      .where(sql`not ${t.seen}`),
    // (6) Starred. Same reasoning: only `starred = true` is queried
    // (`email.service.ts:463`, `:2087`), and the list sorts pinned-then-date.
    index('messages_starred_idx')
      .on(t.userId, t.pinned.desc(), t.date.desc())
      .where(sql`${t.starred}`),
    // (7) The weighted text index.
    index('messages_search_vector_idx').using('gin', t.searchVector),
    // (8) Label membership.
    index('messages_labels_idx').using('gin', t.labels),
    // (9) Alias-tag filtering.
    index('messages_user_id_alias_tag_idx').on(t.userId, t.aliasTag),
    // (10) Subscription aggregation — group a user's mail by sender.
    index('messages_user_id_from_address_date_idx').on(t.userId, t.fromAddress, t.date.desc()),
    // (11) Pinned-then-date listing when no mailbox is fixed (starred/label
    // views). Not redundant with (1), which requires a `mailbox_id` equality.
    index('messages_user_id_pinned_date_idx').on(t.userId, t.pinned.desc(), t.date.desc()),
    // (12) + (13) The two cron sweeps. Partial on `is not null`: only the rows
    // carrying the field are ever swept.
    index('messages_snoozed_until_idx')
      .on(t.snoozedUntil)
      .where(sql`${t.snoozedUntil} is not null`),
    index('messages_scheduled_at_idx').on(t.scheduledAt).where(sql`${t.scheduledAt} is not null`),
    // (14) Retention/cleanup, and the aggregate that replaced
    // `mailboxes.total_messages` / `.size`.
    index('messages_mailbox_id_received_at_idx').on(t.mailboxId, t.receivedAt),
    // The attachment lookup by file is `message_attachments_file_id_idx` on the
    // child table. No standalone `(user_id)` or `(mailbox_id)` index — (1) and
    // (14) lead with them.

    check(
      'messages_card_type_check',
      sql`${t.cardType} is null or ${t.cardType} in (${sql.raw(
        MESSAGE_CARD_TYPES.map((value) => `'${value}'`).join(', '),
      )})`,
    ),
    // A card is whole or absent. Flattened to columns, "the card exists" and
    // "the card has a type" are different statements unless this says so.
    check(
      'messages_card_complete_check',
      sql`${t.cardType} is not null or (${t.cardData} is null and ${t.cardConfidence} is null and ${t.cardExtractedAt} is null)`,
    ),
    // A size is never negative.
    check('messages_size_check', sql`${t.size} >= 0`),
    check('messages_draft_revision_check', sql`${t.draftRevision} >= 1`),
    // `replyTo` was a whole sub-document: it had an address or it did not exist.
    check(
      'messages_reply_to_complete_check',
      sql`${t.replyToAddress} is not null or ${t.replyToName} is null`,
    ),
    // CALL-SITE OBLIGATION (`CONVENTIONS.md`, "Normalization that lives at the
    // call site"): `from_address`, `reply_to_address` and every
    // `message_recipients.address` are stored lower-cased and trimmed.
    // Postgres has no setter; the MIME parse path
    // (`emailInbound.ts`) and the compose path (`email.service.ts`) must
    // normalize before writing, or address matching quietly becomes
    // case-sensitive. Deliberately not a CHECK — a CHECK would reject a
    // production row stored before normalization and turn a silent
    // normalization into a 500.
  ],
);
