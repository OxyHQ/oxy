/**
 * `notes` — the one example table this scaffold ships.
 *
 * It exists so a freshly generated app has a migration that applies and a
 * typed query that runs, and so the two conventions a new Oxy table gets wrong
 * most often are already demonstrated. Rename it, reshape it, or delete it once
 * you have a real table — but keep both conventions.
 *
 * ## 1. `oxyUserId` carries no foreign key, and never will
 *
 * Oxy owns identity. Every user id in an Oxy app's own database is a FOREIGN
 * SERVICE's primary key reached over HTTP, so there is nothing in this database
 * for `.references()` to point at. A shadow `users` table would be a cache that
 * can disagree with Oxy, and validating on write would put an HTTP round trip
 * in front of every insert. The same applies to any id belonging to another
 * service the app integrates with (an Oxy `fileId` on an attachment, a payment
 * reference), so say so in a comment on each such column.
 *
 * ## 2. Columns are declared camelCase and named by the casing authority
 *
 * `oxyUserId` becomes `oxy_user_id` in SQL because `DATABASE_CASING` is passed
 * both to the runtime handle (`db/postgres.ts`) and to drizzle-kit
 * (`drizzle.config.ts`). Do not spell the SQL name by hand — and note that
 * `column.name` on a drizzle column is the TypeScript property name, not the
 * SQL one. `sqlColumnName()` from `@oxyhq/db` is the way to get the SQL name if
 * hand-written SQL ever needs it.
 */

import { index, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';

export const notes = pgTable(
  'notes',
  {
    /** A UUIDv7 text primary key, generated in the application. */
    id: generatedId(),
    /** An Oxy account id — a foreign service's key, so no foreign key here. */
    oxyUserId: text().notNull(),
    title: text().notNull(),
    body: text().notNull().default(''),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // "This user's notes, newest first" — the only read this table has, so it
    // gets the composite index rather than a bare index on the user id.
    index('notes_oxy_user_id_created_at_idx').on(t.oxyUserId, t.createdAt.desc()),
  ],
);

/** A `notes` row as selected. */
export type Note = typeof notes.$inferSelect;

/** The shape `insert(notes).values(...)` accepts. */
export type NewNote = typeof notes.$inferInsert;
