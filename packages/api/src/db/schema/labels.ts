/**
 * `labels` — a user's mail labels.
 *
 * Ported from `models/Label.ts`.
 *
 * Mongo enforced "one label name per user, case-insensitively" with a unique
 * index under `collation: { locale: 'en', strength: 2 }`. Postgres gets the same
 * guarantee from a unique index on the EXPRESSION `lower(name)` — see
 * `CONVENTIONS.md` for why that beats the `citext` extension here.
 *
 * Consequence for every read: a lookup by name must be written
 * `where user_id = $1 and lower(name) = lower($2)`. A plain `name = $2` is
 * correct-looking, case-SENSITIVE, and will not use this index.
 */

import { sql } from 'drizzle-orm';
import { integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { users } from './users';

/** Applied when a label is created without one. */
export const DEFAULT_LABEL_COLOR = '#4285f4';

export const labels = pgTable(
  'labels',
  {
    id: generatedId(),
    /** A label belongs to exactly one mailbox owner. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Stored exactly as the user typed it; uniqueness ignores case. */
    name: text().notNull(),
    color: text().notNull().default(DEFAULT_LABEL_COLOR),
    // `order` is a reserved word. Drizzle quotes every identifier it emits, so
    // this is safe from the ORM; hand-written SQL must quote it too.
    order: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // Mongo also declared a standalone `{userId: 1}` index; dropped, since the
  // unique index below leads with `user_id` and serves those reads. No index
  // backs the `order, name` sort of the list view either — a user holds a few
  // dozen labels at most, so sorting them is free and an index would be noise.
  (t) => [uniqueIndex('labels_user_id_lower_name_key').on(t.userId, sql`lower(${t.name})`)]
);
