/**
 * `app_listings` — what the store shows about an application.
 *
 * ## The boundary this table draws
 *
 * `applications` answers "may this program act for this person?" — client
 * identity, redirect URIs, scopes, ownership. This answers "should this person
 * choose it?" — the shelf, the words, the pictures, the state of its
 * submission. One row per application, and the application can exist without
 * one: an internal tool or a first-party client that is never listed simply has
 * no listing, which is why this is a separate table rather than more columns on
 * `applications`.
 *
 * The dependency runs one way. Turn the store off and OAuth still works; delete
 * an application and its listing goes with it (`CASCADE`), because a listing
 * for a program that no longer exists is not a record worth keeping.
 *
 * ## What is deliberately NOT here
 *
 * - **The icon.** `applications.icon` already holds a file id and the consent
 *   screen already draws it. A second icon would be two sources for one image
 *   and they would disagree the first time someone edited the wrong one.
 * - **Legal and website links.** `applications.privacyPolicyUrl`, `termsUrl`
 *   and `websiteUrl` exist and are shown on the consent screen. The store reads
 *   them; it does not keep its own copy.
 * - **Versions.** `app_updates` already records every OTA release with its
 *   channel, runtime version and platform. The store renders that history.
 * - **Install counts.** `app_grants` already records who authorized what and
 *   when. A count here would be a cache of a table that is one query away, and
 *   caches of things nobody has measured are how numbers start lying.
 *
 * ## Ratings are computed, not stored
 *
 * There is no `rating` or `review_count` column. An average over
 * `app_reviews` is a single aggregate on an indexed column; a stored counter is
 * a second source of truth that has to be maintained on every insert, edit,
 * hide and delete, and drifts the first time one of those paths forgets. If the
 * aggregate ever becomes hot, the answer is a materialized view refreshed on a
 * schedule — still derived, still one source.
 */

import { index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { appCategories } from './appCategories';
import { applications } from './applications';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxyhq/db';

/**
 * Where a listing is in its life.
 *
 * `pending_review` is the store's own review of the LISTING, and is not the
 * same thing as `applications.status = 'pending_review'`, which gates whether
 * the client may complete an OAuth authorize. An app can be perfectly
 * authorized and its store page still be a draft, and the reverse — a published
 * page for a suspended client — is exactly the state the store must be able to
 * see in order to pull the page down.
 */
export const APP_LISTING_STATUSES = ['draft', 'pending_review', 'published', 'rejected'] as const;

export type AppListingStatus = (typeof APP_LISTING_STATUSES)[number];

export const appListings = pgTable(
  'app_listings',
  {
    id: generatedId(),

    /**
     * The application this describes. UNIQUE: one listing per application, so
     * "the listing" is always a definite article and no reader has to decide
     * which of two is current.
     */
    applicationId: text()
      .notNull()
      .references(() => applications.id, { onDelete: 'cascade' }),

    /**
     * The public URL segment — `astro`, `mention`. This is the store's own
     * identifier and the one every link carries; the application id stays
     * internal.
     *
     * It lives here rather than on `applications` for the same reason the rest
     * of this table does: an unlisted client has no store URL, and the platform
     * needs no slug to authorize anybody. It is also the seam the marketing
     * site's `productId` lands on when its catalogue moves here.
     */
    slug: text().notNull().unique(),

    /** One line under the name. Short by intent; the card shows it whole. Absent is NULL, never `''`: an empty string is a VALUE, and the schema gate rejects the default outright — see `CONVENTIONS.md`. */
    tagline: text(),
    /** The long description on the page. Markdown, rendered by the client. */
    description: text(),

    /**
     * The shelf. Nullable with `SET NULL`: retiring a category must not delete
     * the listings that sat on it — they fall back to uncategorised and someone
     * re-files them, which is recoverable. `CASCADE` here would delete a
     * publisher's page because a curator tidied the taxonomy.
     */
    categoryId: text().references(() => appCategories.id, { onDelete: 'set null' }),

    /** Where a person goes when the app misbehaves. Store-specific. */
    supportUrl: text(),
    /** Address for the same, when there is no page for it. */
    supportEmail: text(),

    status: text({ enum: APP_LISTING_STATUSES }).notNull().default('draft'),
    /**
     * When it first became visible. Kept as its own column rather than derived
     * from `updated_at`, because a listing that is unpublished and published
     * again has one publication date and many edits.
     */
    publishedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('app_listings_application_id_key').on(t.applicationId),
    /** The storefront's own reads: a shelf, newest published first. */
    index('app_listings_category_id_idx').on(t.categoryId),
    index('app_listings_status_published_at_idx').on(t.status, t.publishedAt),
  ]
);
