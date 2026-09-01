/**
 * `app_reviews` — what a person says about an application, and the rating they
 * give it.
 *
 * ## It hangs off the application, not the listing
 *
 * A listing can be unpublished, rejected, rewritten or withdrawn, and none of
 * that should touch what people said. Reviews are about the program, so they
 * reference `applications`; the listing is the page they are shown on. The
 * store therefore has an answer to "this app was delisted, where did the
 * reviews go" that is not "we deleted them".
 *
 * ## One review per person per app
 *
 * `unique(application_id, user_id)` — enforced here rather than checked in a
 * route, because two concurrent submits pass any check and only a constraint
 * stops the second. Editing is an UPDATE of the row that exists; a person who
 * changed their mind has one review with a new body, not two contradicting each
 * other.
 *
 * ## Who may write one
 *
 * Any verified Oxy account, which is what `user_id` records. Whether that
 * person actually USES the app is not a column here: `app_grants` already knows
 * who authorized what and when, so the store reads it to mark a review as
 * coming from a user rather than storing a flag that would be true at insert
 * time and wrong forever after.
 *
 * ## The rating is an integer with a CHECK
 *
 * One to five, whole stars. The bound is in the database because it is a fact
 * about the data, not about the form that happened to submit it — an import, a
 * migration or a second client all have to obey it.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { applications } from './applications';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { users } from './users';

/**
 * Moderation state. `visible` is the default because a review that needs
 * approval before anyone reads it is a different product decision, and one the
 * store can make later by changing the default — the states are already here.
 */
export const APP_REVIEW_STATUSES = ['visible', 'hidden', 'flagged', 'removed'] as const;

export type AppReviewStatus = (typeof APP_REVIEW_STATUSES)[number];

export const appReviews = pgTable(
  'app_reviews',
  {
    id: generatedId(),

    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),

    /**
     * The author. `CASCADE`: an account erasure takes its reviews with it,
     * which is the only reading of a data-deletion request that is honest —
     * anonymising the row would leave the text, and the text is the person's.
     */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    rating: integer().notNull(),
    /** Optional headline: most people write a sentence and no title. Absent is NULL, never `''`: an empty string is a VALUE, and the schema gate rejects the default outright — see `CONVENTIONS.md`. */
    title: text(),
    /** The review itself. NULL for a rating with no words behind it. */
    body: text(),

    status: text({ enum: APP_REVIEW_STATUSES }).notNull().default('visible'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('app_reviews_rating_range', sql`${t.rating} between 1 and 5`),
    unique('app_reviews_application_id_user_id_key').on(t.applicationId, t.userId),
    /**
     * The page's read: visible reviews for one app, newest first, and the
     * aggregate the store computes instead of storing. The status column leads
     * the sort key because every public read filters on it.
     */
    index('app_reviews_application_id_status_created_at_idx').on(
      t.applicationId,
      t.status,
      t.createdAt
    ),
    /** "Everything this person wrote", for their profile and for moderation. */
    index('app_reviews_user_id_idx').on(t.userId),
  ]
);
