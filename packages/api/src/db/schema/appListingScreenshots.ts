/**
 * `app_listing_screenshots` — the pictures on a store page, in the author's
 * order.
 *
 * ## Why a child table and not a `text[]` of file ids
 *
 * `CONVENTIONS.md` keeps `redirect_uris` as a native array because it is read
 * whole and no query filters by element. This is the opposite case on both
 * counts. Each screenshot carries data of its own — a caption, a platform, a
 * position — so an array would have to become an array of objects, and an
 * array of objects is a table that has given up its foreign key: nothing would
 * stop a deleted file from staying referenced forever.
 *
 * With a row per picture, `file_id` is a real reference and a purged asset
 * cannot leave a broken image on a published page.
 *
 * ## Position is explicit
 *
 * Order matters and is the author's, so it is a column rather than an
 * insertion-order accident. Not unique per listing: reordering three pictures
 * would otherwise need a temporary value to dodge a collision, which is how
 * reorder bugs are born. Ties break by `id`, which is stable.
 */

import { index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { appListings } from './appListings';
import { createdAt, generatedId, updatedAt } from '@oxyhq/db';
import { files } from './files';

/** Which frame a shot was taken in — the store groups by it on the page. */
export const APP_SCREENSHOT_PLATFORMS = ['phone', 'tablet', 'desktop', 'web'] as const;

export type AppScreenshotPlatform = (typeof APP_SCREENSHOT_PLATFORMS)[number];

export const appListingScreenshots = pgTable(
  'app_listing_screenshots',
  {
    id: generatedId(),

    /** `CASCADE`: a screenshot is part of the listing, not a thing beside it. */
    listingId: text()
      .notNull()
      .references(() => appListings.id, { onDelete: 'cascade' }),

    /**
     * The uploaded asset. `RESTRICT` rather than `CASCADE` or `SET NULL`: a
     * screenshot row without its file is a hole on a published page, and
     * silently deleting the row when an asset is purged would remove a picture
     * the publisher never removed. Refusing the delete surfaces the conflict to
     * whoever is purging, which is where the decision belongs.
     */
    fileId: text()
      .notNull()
      .references(() => files.id, { onDelete: 'restrict' }),

    platform: text({ enum: APP_SCREENSHOT_PLATFORMS }).notNull().default('desktop'),
    /** Alt text, and the caption under the picture. Absent is NULL, never `''`: an empty string is a VALUE, and the schema gate rejects the default outright — see `CONVENTIONS.md`. */
    caption: text(),
    position: integer().notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /** The page's own read: every shot for a listing, in order. */
    index('app_listing_screenshots_listing_id_position_idx').on(t.listingId, t.position),
    /** What a file delete needs in order to check this table without a scan. */
    index('app_listing_screenshots_file_id_idx').on(t.fileId),
  ]
);
