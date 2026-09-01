/**
 * `bookmarks` — a user saved a post.
 *
 * Ported from `models/Bookmark.ts`.
 *
 * `post_id` carries NO foreign key: `Post` is Mention's model, in Mention's
 * database. There is no `posts` table in this database to point at, so the
 * column is a plain indexed id — the one place in this batch where a relation
 * genuinely cannot be enforced, recorded in `deferredForeignKeys.ts` so it stays
 * a stated exception rather than an oversight.
 */

import { index, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { users } from './users';

export const bookmarks = pgTable(
  'bookmarks',
  {
    id: generatedId(),
    /** Bookmarks are private to their owner and outlive nothing. */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Mention's `Post` id. Cross-service, so no foreign key is possible. */
    postId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // Every read of a bookmark is "this user's bookmarks". Mongo declared no index
  // at all here, so that read was a collection scan; a supporting index is the
  // schema this table would have had if it had been designed on Postgres.
  (t) => [index('bookmarks_user_id_idx').on(t.userId)]
);
