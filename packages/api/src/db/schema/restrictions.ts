/**
 * `restrictions` — user A has restricted user B.
 *
 * Ported from `models/Restricted.ts`. Structurally identical to `blocks`, and
 * deliberately mirrors it: same two-user shape, same compound unique, same
 * `created_at`-only append-only contract (Mongoose declared its own
 * `createdAt: { default: Date.now }` rather than `timestamps`, which has no
 * Postgres counterpart — both spellings are one `created_at` column).
 *
 * The Mongo collection was `restricteds`. Nothing reads a collection name, so
 * the table is named for what a row holds: a restriction.
 *
 * ## The one place it does NOT mirror `blocks`
 *
 * `blocks` gained a `blocked_id` index that Mongo lacked, because
 * `graphExclusion.ts:47` and `user.service.ts:1661` both ask "who has blocked
 * me" and no Mongo index could serve that direction. Restrictions have no such
 * reader: every query leads with `user_id` — `mediaPrivacyService.ts:133`
 * (`{userId, restrictedId}` point lookup), and the three list/act/remove
 * handlers in `routes/privacy.ts:211-213`, all scoped to the restricter. The
 * compound unique below answers every one of them, so no second index is added.
 * That asymmetry is the point: an index is ported when a query needs it, not
 * because the neighbouring table has one.
 */

import { pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId } from '@oxyhq/db';
import { users } from './users';

export const restrictions = pgTable(
  'restrictions',
  {
    id: generatedId(),
    /** The user who restricted. A deleted account restricts nobody. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The user who was restricted. A restriction on a deleted account enforces nothing. */
    restrictedId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [unique('restrictions_user_id_restricted_id_key').on(t.userId, t.restrictedId)]
);
