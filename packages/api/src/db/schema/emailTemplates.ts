/**
 * `email_templates` — a user's saved reply/compose templates.
 *
 * Ported from `models/EmailTemplate.ts`.
 *
 * Mongo enforced "one template name per user, case-insensitively" with
 * `collation: { locale: 'en', strength: 2 }`. Postgres gets the same guarantee
 * from a unique index on `lower(name)` — the pattern `labels` already uses; see
 * `CONVENTIONS.md` for why that beats the `citext` extension.
 *
 * Consequence for every read: a lookup by name must be written
 * `where user_id = $1 and lower(name) = lower($2)`. A plain `name = $2` is
 * correct-looking, case-SENSITIVE, and will not use this index.
 */

import { sql } from 'drizzle-orm';
import { integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { users } from './users';

export const emailTemplates = pgTable(
  'email_templates',
  {
    id: generatedId(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Stored exactly as the user typed it; uniqueness ignores case. */
    name: text().notNull(),
    /**
     * NOT NULL with no DEFAULT — same reasoning as `messages.subject`.
     * Mongoose's `default: ''` was an application default, and `''` is not
     * available as a column default in this schema.
     */
    subject: text().notNull(),
    body: text().notNull(),
    /** Display order in the template picker. */
    order: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // Mongo also declared a standalone `{userId}`; dropped, since this index
  // leads with `user_id` and a btree serves any leading prefix.
  (t) => [uniqueIndex('email_templates_user_id_lower_name_key').on(t.userId, sql`lower(${t.name})`)]
);
