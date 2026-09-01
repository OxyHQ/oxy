/**
 * `file_links` — one place an asset is used.
 *
 * Ported from the `links` array in `models/File.ts`.
 *
 * A child table rather than `jsonb` was not a judgement call: Mongo indexed
 * FOUR of the five inner fields individually AND declared two compound indexes
 * over them. That is a table.
 *
 * ## The unique index Mongo lacked
 *
 * `assetService.linkFile()` (`services/assetService.ts:1163`) refuses a second
 * link with the same `(app, entityType, entityId)` — an invariant enforced by a
 * read-then-write, which is to say not enforced at all under concurrency. It
 * matters because `usageCount` is `links.length` and a duplicate would inflate
 * it, and because `status: 'trash'` flips back to `'active'` on
 * `links.length > 0`.
 *
 * `createdBy` is deliberately NOT in the key: the application's check ignores
 * it, so including it here would enforce a weaker constraint than the code
 * intends.
 *
 * If the backfill fails on this index it has found real duplicates — the same
 * correct outcome `CONVENTIONS.md` records for `users.username`.
 */

import { index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId } from '@oxyhq/db';
import { files } from './files';
import { users } from './users';

export const fileLinks = pgTable(
  'file_links',
  {
    id: generatedId(),
    /** A link is meaningless without the asset it points at. */
    fileId: text()
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    /** The consuming application, e.g. `mention`. */
    app: text().notNull(),
    /** The entity class within that application, e.g. `post`, `avatar`. */
    entityType: text().notNull(),
    /** The entity's id IN THAT APPLICATION's database — see `deferredForeignKeys.ts`. */
    entityId: text().notNull(),
    /**
     * The account that created the link. Always `req.user._id`
     * (`routes/assets.ts:1198`, the only writer), so it is a real relation.
     *
     * `CASCADE`: the link records that this user attached the asset somewhere;
     * with the account gone, so is the claim.
     */
    createdBy: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Optional third-party webhook to notify about events on this asset. */
    webhookUrl: text(),
    /**
     * Mongo declared `createdAt: { default: Date.now }` and no `updatedAt`.
     * The ABSENCE of `updated_at` is the append-only contract.
     */
    createdAt: createdAt(),
  },
  (t) => [
    unique('file_links_file_id_app_entity_key').on(t.fileId, t.app, t.entityType, t.entityId),
    // Mongo declared `{links.app, links.entityType, links.entityId}` AND
    // `{…, links.createdBy}`. A btree serves any leading prefix, so the
    // four-column index answers both.
    index('file_links_app_entity_type_entity_id_created_by_idx').on(
      t.app,
      t.entityType,
      t.entityId,
      t.createdBy
    ),
    // "Everything this user linked" — Mongo's standalone `{links.createdBy}`.
    index('file_links_created_by_idx').on(t.createdBy),
    // Mongo's standalone `{links.app}`, `{links.entityType}` and
    // `{links.entityId}` are dropped: the compound above leads with `app`, and
    // neither of the other two is ever queried without it. Listing one file's
    // links needs no index of its own — the unique above leads with `file_id`.
  ]
);
