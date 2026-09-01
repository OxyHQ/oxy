/**
 * `user_link_metadata` — the resolved preview of one profile link.
 *
 * Ported from the `linksMetadata` array embedded in `models/User.ts`. `url`,
 * `title` and `description` were all `required: true` there and stay `NOT NULL`
 * here.
 *
 * `users.links` (the bare URL list) stays a native `text[]` on the parent: it is
 * a handful of scalars, never queried by element. This table is the ENTITY half
 * — an array of objects, which `CONVENTIONS.md` sends to a child table rather
 * than `jsonb`, so a preview can be replaced or re-resolved on its own.
 *
 * `position` preserves the array's order, which is user-chosen and visible on
 * the profile. Without it the order would be whatever Postgres returned.
 *
 * `title` / `description` hold text scraped from a REMOTE page. Mongoose's
 * `trim` was a backstop only; the real normalization (interior newlines from an
 * indented `<title>`, length caps) lives in `utils/profileTextNormalization.ts`
 * and must be re-applied at the write call site — Postgres has no setter.
 */

import { pgTable, text, integer, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { users } from './users';

export const userLinkMetadata = pgTable(
  'user_link_metadata',
  {
    id: generatedId(),
    /** `CASCADE` — a link preview outlives nothing. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Zero-based position in the profile's link list. */
    position: integer().notNull(),
    url: text().notNull(),
    title: text().notNull(),
    description: text().notNull(),
    /** Oxy-hosted preview image id. Optional — many pages have none. */
    image: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // Leads with `user_id`, so it answers the only read there is ("this profile's
  // link previews, in order") and simultaneously makes two rows claiming one
  // position impossible.
  (t) => [uniqueIndex('user_link_metadata_user_id_position_key').on(t.userId, t.position)]
);
