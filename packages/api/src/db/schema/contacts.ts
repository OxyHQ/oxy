/**
 * `contacts` — a user's address book.
 *
 * Ported from `models/Contact.ts`.
 *
 * ## The compound text index has no Postgres counterpart
 *
 * A scalar field (`user_id`) and two text fields (`name`, `email`) in ONE
 * index is something Postgres cannot express: a
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
 * ## What the search actually runs — read this before changing the call site
 *
 * Contact search in `email.service.ts` does NOT use this vector. It matches
 * unanchored case-insensitive substrings over `name`, `email` AND `company`,
 * which no text index can serve — so contact search is a scan, and nothing in
 * `src/` queries this vector today.
 *
 * The vector covers `name` and `email` only. `company`, the third field the
 * live query searches, is deliberately not in it. A call site that moves to an
 * index must pick one deliberately: `to_tsquery` against this vector (prefix
 * matching, loses `company` and loses infix matches), or `pg_trgm` (already
 * available, matches the current substring semantics exactly). Do not assume
 * this index covers the query it does not.
 */

import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, tsvector, updatedAt } from '@oxy.so/db';
import { users } from './users';

/** English. A LITERAL — see `@oxy.so/db`'s `tsvector`. */
const SEARCH_CONFIGURATION = 'english';

/**
 * `name` + `email`, unweighted.
 *
 * Spelled in SQL because a generated expression is built before the table
 * object exists; `__tests__/contacts.test.ts` asserts the column populates from
 * both fields, so a name that drifts fails rather than silently indexing
 * nothing.
 */
const SEARCH_VECTOR_EXPRESSION = sql.raw(
  `to_tsvector('${SEARCH_CONFIGURATION}', coalesce(name, '') || ' ' || coalesce(email, ''))`,
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
     * CALL-SITE OBLIGATION. Stored lower-cased and trimmed, which is what makes
     * the unique index below effectively case-insensitive. Postgres has no
     * setter, and per `CONVENTIONS.md` the
     * expression-index treatment is reserved for values the system resolves an
     * ACCOUNT by — which this is not. So `createContact`
     * (`email.service.ts:3001`), `updateContact` and the auto-collect path
     * (`:3067`) must lower-case and trim before writing; if one forgets, the
     * user gets two address-book entries for one correspondent.
     */
    email: text().notNull(),
    company: text(),
    notes: text(),
    starred: boolean().notNull().default(false),
    /** True when the contact was harvested from mail rather than typed. */
    autoCollected: boolean().notNull().default(false),
    lastContactedAt: timestamptz(),

    /** GENERATED — the text half of the split search index (see the header). */
    searchVector: tsvector().generatedAlwaysAs(SEARCH_VECTOR_EXPRESSION),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Also the `user_id`-leading btree the split text index relies on, and the
    // reason there is no standalone `(user_id)` index.
    uniqueIndex('contacts_user_id_email_key').on(t.userId, t.email),
    index('contacts_search_vector_idx').using('gin', t.searchVector),
    // Only `starred = true` is ever queried (`email.controller.ts:835`), so the
    // partial index is smaller and answers the same read.
    index('contacts_starred_idx').on(t.userId).where(sql`${t.starred}`),
  ],
);
