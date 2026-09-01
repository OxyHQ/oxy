/**
 * `contacts` — a user's address book.
 *
 * Ported from `models/Contact.ts`.
 *
 * ## The compound text index has no Postgres counterpart
 *
 * Mongo declared `{userId: 1, name: 'text', email: 'text'}` — a scalar field
 * and two text fields in ONE index, which Postgres cannot express: a
 * multicolumn GIN would need a GIN opclass for `user_id`, i.e. the `btree_gin`
 * extension, and `CONVENTIONS.md` has already refused that class of
 * install-ordering dependency twice (for `citext` and for PostGIS). The
 * extension IS present in `postgres:17-alpine` — it is the `CREATE EXTENSION`
 * that would have to run identically in dev, CI and RDS before the first
 * migration that is the problem, not availability.
 *
 * So it splits the way the planner wants it anyway: a `tsvector` GIN for the
 * text half, and the `user_id`-leading btree the unique index below already
 * provides for the scalar half. Postgres BitmapAnds them.
 *
 * ## What the search actually runs today — read this before porting the call site
 *
 * `email.service.ts:2976` does NOT use the text index. It builds a `$or` of
 * three unanchored case-insensitive REGEXES over `name`, `email` AND `company`,
 * which no Mongo text index can serve — so contact search is a collection scan
 * today, and this `tsvector` is a port of a DEAD index (nothing in `src/`
 * issues a `$text` query against `Contact`).
 *
 * The vector covers exactly what Mongo's index covered — `name` and `email` —
 * so this is a port, not a redesign. `company`, the third field the live query
 * searches, is deliberately not in it. When the call site is ported it must
 * pick one deliberately: `to_tsquery` against this vector (prefix matching,
 * loses `company` and loses infix matches), or `pg_trgm` (already available,
 * matches the current substring semantics exactly). Do not assume this index
 * covers the query it does not.
 */

import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, tsvector, updatedAt } from '@oxyhq/db';
import { users } from './users';

/** Matches the Mongo text index's default language. A LITERAL — see `@oxyhq/db`'s `tsvector`. */
const SEARCH_CONFIGURATION = 'english';

/**
 * `name` + `email`, the two fields Mongo's text index covered, unweighted
 * because Mongo declared no weights for them.
 *
 * Spelled in SQL because a generated expression is built before the table
 * object exists; `__tests__/contacts.test.ts` asserts the column populates from
 * both fields, so a name that drifts fails rather than silently indexing
 * nothing.
 */
const SEARCH_VECTOR_EXPRESSION = sql.raw(
  `to_tsvector('${SEARCH_CONFIGURATION}', coalesce(name, '') || ' ' || coalesce(email, ''))`
);

export const contacts = pgTable(
  'contacts',
  {
    id: generatedId(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    /**
     * CALL-SITE OBLIGATION. Mongoose stored this `lowercase: true, trim: true`,
     * so the unique index below was effectively case-insensitive by
     * construction. Postgres has no setter, and per `CONVENTIONS.md` the
     * expression-index treatment is reserved for values the system resolves an
     * ACCOUNT by — which this is not. So `createContact`
     * (`email.service.ts:3001`), `updateContact` and the auto-collect path
     * (`:3067`) must lower-case and trim before writing; if one forgets, the
     * user gets two address-book entries for one correspondent where Mongo
     * silently gave them one.
     */
    email: text().notNull(),
    company: text(),
    notes: text(),
    starred: boolean().notNull().default(false),
    /** True when the contact was harvested from mail rather than typed. */
    autoCollected: boolean().notNull().default(false),
    lastContactedAt: timestamptz(),

    /** GENERATED — the text half of Mongo's compound text index. */
    searchVector: tsvector().generatedAlwaysAs(SEARCH_VECTOR_EXPRESSION),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Also the `user_id`-leading btree the split text index relies on. Mongo's
    // standalone `{userId}` is dropped for the same reason.
    uniqueIndex('contacts_user_id_email_key').on(t.userId, t.email),
    index('contacts_search_vector_idx').using('gin', t.searchVector),
    // Mongo's `{userId, starred}` indexed both values of a boolean; only
    // `starred = true` is ever queried (`email.controller.ts:835`), so the
    // partial index is smaller and answers the same read.
    index('contacts_starred_idx').on(t.userId).where(sql`${t.starred}`),
  ]
);
