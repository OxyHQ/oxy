/**
 * `message_attachments` — one file attached to one message.
 *
 * Ported from the `attachments` array in `models/Message.ts`.
 *
 * Mongo indexed `attachments.fileId` for the reverse lookup "which messages
 * reference this file", which is the tell that this was always a RELATION
 * wearing an embedded array's clothes. Here it is a real foreign key.
 *
 * ## `ON DELETE no action` on `file_id`, deliberately
 *
 * `name`, `content_type` and `size` are MIRRORED from the `files` row at link
 * time (`schemas/email.schemas.ts:102`), so this table is not merely a pointer —
 * it is what the message says it carries.
 *
 * - `CASCADE` would delete the attachment when the file row went, and the
 *   message would silently lose an attachment it still claims to have.
 * - `RESTRICT` is checked immediately, so deleting an ACCOUNT — which cascades
 *   into both `files` and `messages` — could fail purely on the order Postgres
 *   happened to visit them.
 * - `no action` is checked at END of statement, which refuses a bare
 *   `delete from files` while a message still references the row, and permits
 *   an account deletion that removes both sides in the same statement.
 *
 * That matches how deletion actually works: `assetService` moves a file to
 * `status = 'deleted'` (a tombstone) rather than removing the row, so this
 * constraint fires only for a purge — which is exactly when someone should be
 * stopped from silently emptying an attachment out of stored mail.
 */

import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { generatedId } from '@oxyhq/db';
import { files } from './files';
import { messages } from './messages';

/**
 * One attachment as the mail subsystem passes it around — the row's own fields
 * without its id, `message_id` or `ord`.
 *
 * Declared here beside the columns, so what the send path resolves, what
 * storage writes, and what the SMTP transport reads are one shape.
 * `contentId` is optional-undefined while the column is nullable; the read path
 * coalesces.
 */
export interface MessageAttachment {
  /** Canonical `files` row id in the Oxy file manager. */
  fileId: string;
  /** User-facing filename, mirrored from `files.original_name` at link time. */
  name: string;
  /** Mirrored from `files.mime`. */
  contentType: string;
  /** Mirrored from `files.size`. */
  size: number;
  /** MIME Content-ID for inline `cid:` references in HTML bodies. */
  contentId?: string;
  /** True if rendered inline in the HTML body, false if a standalone download. */
  isInline: boolean;
}

export const messageAttachments = pgTable(
  'message_attachments',
  {
    id: generatedId(),
    messageId: text()
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    /** Position in the message, 0-based — MIME parts are ordered. */
    ord: integer().notNull(),
    /** The canonical asset. See the module comment for why `no action`. */
    fileId: text()
      .notNull()
      .references(() => files.id, { onDelete: 'no action' }),
    /** Mirrored from `files.original_name` at link time. */
    name: text().notNull(),
    /** Mirrored from `files.mime`. */
    contentType: text().notNull(),
    /** Mirrored from `files.size`. */
    size: bigint({ mode: 'number' }).notNull(),
    /**
     * MIME `Content-ID`, for an inline `cid:` reference in the HTML body. An
     * email header value, not a row id — see `deferredForeignKeys.ts`.
     */
    contentId: text(),
    /** True when the part renders inside the body rather than as a download. */
    isInline: boolean().notNull().default(false),
  },
  (t) => [
    unique('message_attachments_message_id_ord_key').on(t.messageId, t.ord),
    // Mongo's `{userId, 'attachments.fileId'}`, landing where the data now
    // lives. The user scope comes from the join to `messages`, which is keyed
    // on the primary key — cheaper than carrying a denormalized `user_id` here.
    index('message_attachments_file_id_idx').on(t.fileId),
    // Mongo's `min: 0`.
    check('message_attachments_size_check', sql`${t.size} >= 0`),
    check('message_attachments_ord_check', sql`${t.ord} >= 0`),
  ]
);
