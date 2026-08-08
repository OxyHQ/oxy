import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxyhq/db';
import { check, index, pgTable, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

/**
 * Example table — delete it once {{APP_NAME}} has real ones.
 *
 * It exists to make the conventions concrete rather than aspirational, and every
 * line of it is a decision worth copying:
 *
 *  - **`generatedId()`** — `text` primary key holding an application-generated
 *    uuid v7. Postgres 17 has no native `uuidv7()`, and generating it in the
 *    application means the id is known before the insert round-trip, so a row and
 *    its children can be built in one batch. v7 is time-ordered, which keeps the
 *    primary-key btree append-mostly instead of scattering inserts the way a v4
 *    does.
 *
 *  - **`ownerOxyUserId` carries no foreign key, and never will.** Oxy owns
 *    identity; this app reaches it over HTTP. A local `users` table would be a
 *    cache that can disagree with Oxy, and validating on write would put an HTTP
 *    round trip in front of every insert. Every id-shaped column pointing at
 *    another service is like this — decide it deliberately and say so in a
 *    comment, so "no constraint" never becomes indistinguishable from "nobody
 *    looked at this yet".
 *
 *  - **`status` is `text` + a CHECK derived from a `const` tuple**, never a
 *    Postgres `enum` type. `text({ enum })` gives the same literal-union
 *    TypeScript type an enum would, so the enum buys nothing at compile time —
 *    and while ADDING a value to a pg enum is easy, removing or renaming one is
 *    not possible, whereas a CHECK is an ordinary DROP/ADD CONSTRAINT. Deriving
 *    the column type and the constraint from the SAME tuple is what stops them
 *    drifting apart.
 *
 *  - **`createdAt()` / `updatedAt()`** are `timestamptz`, never a bare
 *    `timestamp`, which would reinterpret the stored value in the session's
 *    TimeZone on every read. They default to `date_trunc('milliseconds', now())`
 *    rather than plain `now()` because `timestamptz` carries microseconds while a
 *    JavaScript `Date` carries milliseconds — so a value written by `now()` does
 *    not survive the round trip, and any keyset cursor built from that read
 *    compares against a value smaller than the row it came from.
 *
 *  - **`updatedAt` is maintained by the application** (`$onUpdate`), not a
 *    trigger: a trigger is invisible in this file and would also fire during a
 *    bulk import, overwriting the historical value the import exists to preserve.
 */

/** The closed set of note states. Types the column AND generates the CHECK. */
export const NOTE_STATUSES = ['draft', 'published', 'archived'] as const;

export type NoteStatus = (typeof NOTE_STATUSES)[number];

export const notes = pgTable(
  'notes',
  {
    id: generatedId(),
    /** The Oxy account this note belongs to. Deliberately unconstrained — see above. */
    ownerOxyUserId: text().notNull(),
    title: text().notNull(),
    body: text(),
    status: text({ enum: NOTE_STATUSES }).notNull().default('draft'),
    publishedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // The index a "my notes, newest first" query needs: the exact columns of the
    // ORDER BY, in that order and direction. Do not add indexes speculatively —
    // add the one a query you have actually written requires.
    index('notes_owner_created_idx').on(table.ownerOxyUserId, table.createdAt.desc()),
    check('notes_status_check', sql`${table.status} in (${sql.raw(inList(NOTE_STATUSES))})`),
  ],
);
