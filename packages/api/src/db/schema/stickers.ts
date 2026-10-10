/**
 * Stickers — the catalogue every Oxy app draws from, and the packs each person
 * has installed.
 *
 * ## One catalogue, many apps
 *
 * Allo sends stickers in a chat, Mention draws them in an empty state, and the
 * next app will want both. The sticker is therefore a platform object with a
 * stable id, not a copy inside each product: an app stores or sends the id,
 * and anything that can reach Oxy can turn it back into the same animation.
 * Which packs a person installed lives here for the same reason — installing a
 * pack in Allo means it is installed in every app that offers a picker.
 *
 * ## A sticker outlives its pack's place in the shop
 *
 * A message in someone's history names a sticker id forever. Retiring a pack
 * from the catalogue is `status = 'archived'`, never a delete: an archived pack
 * stops being listed and installable, and every sticker in it keeps resolving,
 * so old conversations still render.
 *
 * ## The bytes are ordinary files
 *
 * Each sticker points at two rows in `files`, owned by the `__stickers__`
 * system namespace: the Lottie animation (normalized on upload — see
 * `services/stickerValidation.ts`) and a static fallback image for push
 * notifications, federation, reduced motion and link previews (rendered from
 * the animation when the author supplies none — `services/stickerRender.ts`). They are
 * public and content-addressed, so the CDN serves them forever with an
 * immutable cache header, and the file's own `sha256` is the integrity hash a
 * client checks — it is not copied onto the sticker, where it could disagree.
 * `ON DELETE no action`: a stored file cannot be removed out from under a
 * sticker that still shows it.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { STICKER_CANVAS_SIZES } from '@oxy.so/contracts';
import { createdAt, generatedId, inList, numericInList, timestamptz, updatedAt } from '@oxy.so/db';
import { files } from './files';
import { users } from './users';

/**
 * Where a pack is in its life. `draft` is invisible outside staff tooling;
 * `published` is listed and installable; `archived` is neither, but its
 * stickers still resolve — see the file comment.
 */
export const STICKER_PACK_STATUSES = ['draft', 'published', 'archived'] as const;

export type StickerPackStatus = (typeof STICKER_PACK_STATUSES)[number];

export const stickerPacks = pgTable(
  'sticker_packs',
  {
    id: generatedId(),

    /** The public URL segment — `oxy-basics`. The id stays in messages; the slug is what a link carries. */
    slug: text().notNull().unique(),
    title: text().notNull(),
    /** Absent is NULL, never `''` — see `CONVENTIONS.md`. */
    description: text(),
    /** Who drew it, as shown on the pack page. Free text: an illustrator is not necessarily an Oxy account. */
    author: text(),

    status: text({ enum: STICKER_PACK_STATUSES }).notNull().default('draft'),
    /**
     * When it first became visible. Its own column rather than `updated_at`,
     * because a pack that is archived and republished has one publication date
     * and many edits.
     */
    publishedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'sticker_packs_status_check',
      sql`${t.status} in (${sql.raw(inList(STICKER_PACK_STATUSES))})`,
    ),
    /** The shop's read: published packs, newest first. */
    index('sticker_packs_status_published_at_idx').on(t.status, t.publishedAt),
  ],
);

export const stickers = pgTable(
  'stickers',
  {
    id: generatedId(),

    /**
     * `CASCADE` is safe only because a pack is never deleted once published —
     * the service refuses it and archives instead. Deleting a DRAFT takes its
     * half-built stickers with it, which is what a draft is for.
     */
    packId: text()
      .notNull()
      .references(() => stickerPacks.id, { onDelete: 'cascade' }),
    /** Order inside the pack. Not unique: a reorder rewrites every row, and a unique pair would force it through temporary values. */
    position: integer().notNull(),

    /** The emoji this sticker stands for — what the picker's search and "suggest a sticker for 😂" match on. */
    emoji: text().array().notNull(),
    /** Extra search words beyond the emoji. */
    keywords: text().array().notNull().default(sql`'{}'::text[]`),

    /** The Lottie animation (`application/json`). */
    lottieFileId: text()
      .notNull()
      .references(() => files.id),
    /** A static image of the same sticker, for every surface that cannot animate. */
    fallbackFileId: text()
      .notNull()
      .references(() => files.id),

    /** The square canvas the animation was authored at — one of `STICKER_CANVAS_SIZES` in `@oxy.so/contracts`. */
    size: integer().notNull(),
    /** Length of one loop, read from the animation on upload. */
    durationMs: integer().notNull(),

    createdAt: createdAt(),
  },
  (t) => [
    check(
      'stickers_size_check',
      sql`${t.size} in (${sql.raw(numericInList(STICKER_CANVAS_SIZES))})`,
    ),
    check('stickers_duration_ms_check', sql`${t.durationMs} > 0`),
    check('stickers_emoji_check', sql`cardinality(${t.emoji}) > 0`),
    index('stickers_pack_id_position_idx').on(t.packId, t.position),
  ],
);

/**
 * The packs a person installed, in the order their picker shows them.
 *
 * Keyed on the pair: installing twice is the same row, which is what makes
 * `PUT` idempotent without a check-then-insert race.
 */
export const userStickerPacks = pgTable(
  'user_sticker_packs',
  {
    /** `CASCADE`: an erased account's picker goes with it. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    packId: text()
      .notNull()
      .references(() => stickerPacks.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    installedAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.packId] })],
);
