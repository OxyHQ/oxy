/**
 * `app_review_replies` — the publisher's answer to a review.
 *
 * ## Why a table and not two columns on the review
 *
 * A reply has its own author, its own timestamps and its own moderation, and
 * `reply_body`/`reply_at` on the review would make three of those four
 * nullable-together — the shape where "half a reply" is representable and
 * something eventually writes one. A row exists or it does not.
 *
 * `unique(review_id)` keeps it to one: a thread under a review is a different
 * product, and if it is ever wanted this table gains a parent id rather than
 * being retrofitted out of a pair of columns.
 *
 * ## The author is a person, not "the app"
 *
 * `author_user_id` is whoever pressed reply, and the store shows it as coming
 * from the publisher because that person holds a member role over the owning
 * account — the same RBAC that governs every other write to an application.
 * Recording the account instead of the person would lose who wrote it, which is
 * exactly what moderation needs.
 */

import { pgTable, text, unique } from 'drizzle-orm/pg-core';
import { appReviews } from './appReviews';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { users } from './users';

export const appReviewReplies = pgTable(
  'app_review_replies',
  {
    id: generatedId(),

    /** `CASCADE`: a reply to a review that is gone is not a record. */
    reviewId: text()
      .notNull()
      .references(() => appReviews.id, { onDelete: 'cascade' }),

    /**
     * Attribution, and nullable with `SET NULL` for the same reason
     * `applications.created_by_user_id` is: an account erasure must not delete
     * the publisher's answer, which belongs to the conversation on the page,
     * and must not fail either. The reply survives without a name on it.
     */
    authorUserId: text().references(() => users.id, { onDelete: 'set null' }),

    body: text().notNull(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('app_review_replies_review_id_key').on(t.reviewId)]
);
