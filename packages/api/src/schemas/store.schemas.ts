import { z } from 'zod';
import { APP_SCREENSHOT_PLATFORMS } from '../db/schema/appListingScreenshots';

/** A store URL segment: the listing's own `slug`, never an application id. */
export const storeSlugParams = z.object({
  slug: z.string().trim().min(1).max(120),
});

/**
 * GET /store/apps
 *
 * `category` is a category SLUG for the same reason the path carries a listing
 * slug: an id in a query string is an id in somebody's bookmark.
 */
export const storeListingsQuery = z.object({
  category: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  offset: z.coerce.number().int().min(0).default(0),
});

/** GET /store/apps/:slug/reviews */
export const storeReviewsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  /** Newest first by default; `rating` surfaces the strongest opinions. */
  sort: z.enum(['recent', 'rating']).default('recent'),
});

/** How long a review may be. Generous — the limit is against abuse, not prose. */
const REVIEW_BODY_MAX = 5000;
const REVIEW_TITLE_MAX = 120;

/**
 * PUT /store/apps/:slug/review
 *
 * `rating` repeats the database's `between 1 and 5` on purpose: the CHECK is
 * what makes the bound true of the data, and this is what makes a bad request a
 * 400 rather than a 500 out of the driver.
 *
 * Title and body accept `null` as well as absent, because clearing a title you
 * once wrote has to be expressible — the two are stored the same way.
 */
export const storeReviewBody = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(REVIEW_TITLE_MAX).nullish(),
  body: z.string().trim().max(REVIEW_BODY_MAX).nullish(),
});

/** A review id in the path, for the publisher's reply. */
export const storeReviewParams = z.object({
  reviewId: z.string().trim().min(1).max(64),
});

/**
 * PUT /store/reviews/:reviewId/reply
 *
 * `min(1)` after the trim: a reply is the publisher speaking, so an empty one
 * is a delete, and `DELETE` is where that is spelled.
 */
export const storeReplyBody = z.object({
  body: z.string().trim().min(1).max(REVIEW_BODY_MAX),
});

/**
 * PUT /applications/:appId/listing
 *
 * A whole page, not a patch: the console edits one form, and a partial update
 * would make "clear the tagline" and "leave the tagline alone" the same
 * request.
 *
 * `status` is deliberately absent. Moving a page through review is a
 * transition with its own route and its own guard, so a publisher cannot
 * publish themselves by putting a field in a body.
 */
export const storeListingBody = z.object({
  /**
   * The public URL segment. Lowercase, digits and hyphens, because it is what
   * every link to the page carries and a slug that needs escaping is a slug
   * that will be copied wrong.
   */
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, digits and single hyphens'),
  tagline: z.string().trim().max(160).nullish(),
  description: z.string().trim().max(20000).nullish(),
  /** A category SLUG, never its id: an id in a form is an id in a bug report. */
  categorySlug: z.string().trim().min(1).max(120).nullish(),
  supportUrl: z.string().trim().url().max(2048).nullish(),
  supportEmail: z.string().trim().email().max(320).nullish(),
});

/** GET /store/moderation/listings — the review queue. */
export const storeModerationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** An application id in the path, for the moderation decisions. */
export const storeModerationParams = z.object({
  applicationId: z.string().trim().min(1).max(64),
});

/** POST /applications/:appId/listing/screenshots — attach an uploaded image. */
export const storeScreenshotBody = z.object({
  /** An already-uploaded asset. The service checks it is an image, live, and the caller's. */
  fileId: z.string().trim().min(1).max(64),
  platform: z.enum(APP_SCREENSHOT_PLATFORMS).optional(),
  caption: z.string().trim().max(300).nullish(),
});

/**
 * PATCH /applications/:appId/listing/screenshots/:screenshotId
 *
 * A patch, unlike the listing's `PUT`, because there is nothing to clear
 * wholesale: a picture is its file, and only its words and its frame are
 * editable. Position is not here — ordering is the whole-list `PUT` below, so
 * there is exactly one way to move a picture.
 */
export const storeScreenshotPatch = z
  .object({
    platform: z.enum(APP_SCREENSHOT_PLATFORMS).optional(),
    caption: z.string().trim().max(300).nullish(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });

export const storeScreenshotParams = z.object({
  appId: z.string().trim().min(1).max(64),
  screenshotId: z.string().trim().min(1).max(64),
});

/**
 * PUT /applications/:appId/listing/screenshots/order
 *
 * Every id on the listing, exactly once, in the order they should appear. A
 * partial list would leave the omitted pictures at their old positions,
 * interleaved with the new ones.
 */
export const storeScreenshotOrderBody = z.object({
  screenshotIds: z.array(z.string().trim().min(1).max(64)).min(1).max(50),
});

/** A category slug in the path, for the curator's routes. */
export const storeCategoryParams = z.object({
  slug: z.string().trim().min(1).max(120),
});

/**
 * POST /store/moderation/categories
 *
 * The slug follows the same rule a listing's does, and for the same reason: it
 * is what a link to the category page carries.
 */
export const storeCategoryBody = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .min(2)
    .max(120)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, digits and single hyphens'),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300).nullish(),
  /** Running order on the storefront. Ties break by id, so duplicates are fine. */
  order: z.coerce.number().int().min(0).max(10000).optional(),
});

/**
 * PATCH /store/moderation/categories/:slug
 *
 * The slug itself is absent: it is what every link carries, and a store that
 * silently breaks its own URLs to fix a spelling is worse than one with a
 * misspelled slug.
 */
export const storeCategoryPatch = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(300).nullish(),
    order: z.coerce.number().int().min(0).max(10000).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'Nothing to change' });
