/**
 * The app store's reads.
 *
 * Every query here joins a listing to the `applications` row it decorates,
 * because the store owns the page and the platform owns the app: the name, the
 * icon and the legal links come from the application, and the shelf, the copy
 * and the pictures from the listing. Nothing is duplicated between them, so
 * nothing can disagree.
 *
 * ## The rating is computed
 *
 * There is no stored average or count — see `db/schema/appListings.ts` for why.
 * These queries aggregate `app_reviews` on the index that exists for it
 * (`application_id, status, created_at`), filtered to `visible`, so a hidden
 * review stops counting the moment it is hidden rather than when some counter
 * is next repaired.
 */

import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { appCategories } from '../db/schema/appCategories';
import { appGrants } from '../db/schema/appGrants';
import {
  appListingScreenshots,
  type AppScreenshotPlatform,
} from '../db/schema/appListingScreenshots';
import { appListings, type AppListingStatus } from '../db/schema/appListings';
import { appReviewReplies } from '../db/schema/appReviewReplies';
import { appReviews, type AppReviewStatus } from '../db/schema/appReviews';
import { applications } from '../db/schema/applications';
import { files } from '../db/schema/files';
import { users } from '../db/schema/users';
import { isUniqueViolation } from '@oxyhq/db';
import { accountService } from './account.service';
import { appPermissionsForAccountAccess } from '../utils/accountRoles';
import { stripSensitiveUrlQueryParams } from '../utils/sanitizeUrl';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalServerError,
  NotFoundError,
} from '../utils/error';

/** What a card needs, and nothing more. */
export interface StoreListingSummary {
  slug: string;
  name: string;
  tagline: string | null;
  icon: string | null;
  category: { slug: string; label: string } | null;
  rating: { average: number | null; count: number };
}

export interface StoreListingDetail extends StoreListingSummary {
  description: string | null;
  websiteUrl: string | null;
  privacyPolicyUrl: string | null;
  termsUrl: string | null;
  supportUrl: string | null;
  supportEmail: string | null;
  publishedAt: Date | null;
  screenshots: { id: string; fileId: string; platform: string; caption: string | null }[];
  /** 1..5 → how many visible reviews gave it. Absent keys are zero. */
  ratingBreakdown: Record<number, number>;
}

/**
 * Ratings for a set of applications, in ONE query.
 *
 * A per-listing aggregate would be a query per card, which is the shape that
 * turns a 24-item page into 25 round trips. `inArray` over the same index the
 * reviews list uses answers all of them at once.
 */
async function ratingsFor(applicationIds: string[]): Promise<Map<string, { average: number | null; count: number }>> {
  if (applicationIds.length === 0) return new Map();

  const rows = await getDb()
    .select({
      applicationId: appReviews.applicationId,
      average: sql<string>`avg(${appReviews.rating})`,
      total: count(),
    })
    .from(appReviews)
    .where(and(inArray(appReviews.applicationId, applicationIds), eq(appReviews.status, 'visible')))
    .groupBy(appReviews.applicationId);

  return new Map(
    rows.map((row) => [
      row.applicationId,
      // `avg` comes back as a numeric string; rounding here rather than in the
      // client keeps every surface showing the same 4.6.
      { average: row.average === null ? null : Math.round(Number(row.average) * 10) / 10, count: Number(row.total) },
    ])
  );
}

/** Published listings, newest first, optionally on one shelf. */
export async function listPublishedListings(options: {
  categorySlug?: string;
  limit: number;
  offset: number;
}): Promise<{ items: StoreListingSummary[]; total: number }> {
  const db = getDb();
  const filters = [eq(appListings.status, 'published')];

  if (options.categorySlug) {
    const [category] = await db
      .select({ id: appCategories.id })
      .from(appCategories)
      .where(eq(appCategories.slug, options.categorySlug))
      .limit(1);
    // An unknown shelf is an empty shelf, not every app on the store.
    if (!category) return { items: [], total: 0 };
    filters.push(eq(appListings.categoryId, category.id));
  }

  const where = and(...filters);

  const [rows, [totals]] = await Promise.all([
    db
      .select({
        applicationId: appListings.applicationId,
        slug: appListings.slug,
        tagline: appListings.tagline,
        name: applications.name,
        icon: applications.icon,
        categorySlug: appCategories.slug,
        categoryLabel: appCategories.label,
      })
      .from(appListings)
      .innerJoin(applications, eq(applications.id, appListings.applicationId))
      .leftJoin(appCategories, eq(appCategories.id, appListings.categoryId))
      .where(where)
      .orderBy(desc(appListings.publishedAt), asc(appListings.id))
      .limit(options.limit)
      .offset(options.offset),
    db.select({ value: count() }).from(appListings).where(where),
  ]);

  const ratings = await ratingsFor(rows.map((row) => row.applicationId));

  return {
    items: rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      tagline: row.tagline,
      icon: row.icon === null ? null : stripSensitiveUrlQueryParams(row.icon),
      category: row.categorySlug ? { slug: row.categorySlug, label: row.categoryLabel! } : null,
      rating: ratings.get(row.applicationId) ?? { average: null, count: 0 },
    })),
    total: Number(totals?.value ?? 0),
  };
}

/** One page. Returns null when the slug is unknown or the listing is not published. */
export async function getPublishedListing(slug: string): Promise<StoreListingDetail | null> {
  const db = getDb();

  const [row] = await db
    .select({
      id: appListings.id,
      applicationId: appListings.applicationId,
      slug: appListings.slug,
      tagline: appListings.tagline,
      description: appListings.description,
      supportUrl: appListings.supportUrl,
      supportEmail: appListings.supportEmail,
      publishedAt: appListings.publishedAt,
      name: applications.name,
      icon: applications.icon,
      websiteUrl: applications.websiteUrl,
      privacyPolicyUrl: applications.privacyPolicyUrl,
      termsUrl: applications.termsUrl,
      categorySlug: appCategories.slug,
      categoryLabel: appCategories.label,
    })
    .from(appListings)
    .innerJoin(applications, eq(applications.id, appListings.applicationId))
    .leftJoin(appCategories, eq(appCategories.id, appListings.categoryId))
    .where(and(eq(appListings.slug, slug), eq(appListings.status, 'published')))
    .limit(1);

  if (!row) return null;

  const [screenshots, breakdown, ratings] = await Promise.all([
    db
      .select({
        id: appListingScreenshots.id,
        fileId: appListingScreenshots.fileId,
        platform: appListingScreenshots.platform,
        caption: appListingScreenshots.caption,
      })
      .from(appListingScreenshots)
      .where(eq(appListingScreenshots.listingId, row.id))
      .orderBy(asc(appListingScreenshots.position), asc(appListingScreenshots.id)),
    db
      .select({ rating: appReviews.rating, total: count() })
      .from(appReviews)
      .where(and(eq(appReviews.applicationId, row.applicationId), eq(appReviews.status, 'visible')))
      .groupBy(appReviews.rating),
    ratingsFor([row.applicationId]),
  ]);

  return {
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    icon: row.icon === null ? null : stripSensitiveUrlQueryParams(row.icon),
    websiteUrl: row.websiteUrl,
    privacyPolicyUrl: row.privacyPolicyUrl,
    termsUrl: row.termsUrl,
    supportUrl: row.supportUrl,
    supportEmail: row.supportEmail,
    publishedAt: row.publishedAt,
    category: row.categorySlug ? { slug: row.categorySlug, label: row.categoryLabel! } : null,
    rating: ratings.get(row.applicationId) ?? { average: null, count: 0 },
    ratingBreakdown: Object.fromEntries(breakdown.map((entry) => [entry.rating, Number(entry.total)])),
    screenshots,
  };
}

export interface StoreReview {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  createdAt: Date;
  author: { id: string; username: string | null };
  reply: { body: string; createdAt: Date } | null;
  /**
   * Whether this author has ever authorized the application — read from
   * `app_grants` at request time rather than stored on the review, which is the
   * whole reason `app_reviews` carries no such column: a flag written at insert
   * would be true then and wrong from the next revocation onwards.
   *
   * It is not a claim that they still use it, and it is false for a first-party
   * app nobody has to consent to, so a client should render its absence as
   * nothing at all rather than as a demotion.
   */
  authorUsesApp: boolean;
}

/**
 * Visible reviews for a published listing.
 *
 * Replies are fetched for the page's reviews in one query rather than joined,
 * because most reviews have none and a LEFT JOIN would carry the reply columns
 * on every row to say so.
 */
export async function listReviews(options: {
  slug: string;
  limit: number;
  offset: number;
  sort: 'recent' | 'rating';
}): Promise<{ items: StoreReview[]; total: number } | null> {
  const db = getDb();

  const [listing] = await db
    .select({ applicationId: appListings.applicationId })
    .from(appListings)
    .where(and(eq(appListings.slug, options.slug), eq(appListings.status, 'published')))
    .limit(1);

  if (!listing) return null;

  const where = and(eq(appReviews.applicationId, listing.applicationId), eq(appReviews.status, 'visible'));
  const order =
    options.sort === 'rating'
      ? [desc(appReviews.rating), desc(appReviews.createdAt), asc(appReviews.id)]
      : [desc(appReviews.createdAt), asc(appReviews.id)];

  const [rows, [totals]] = await Promise.all([
    db
      .select({
        id: appReviews.id,
        rating: appReviews.rating,
        title: appReviews.title,
        body: appReviews.body,
        createdAt: appReviews.createdAt,
        authorId: users.id,
        authorUsername: users.username,
      })
      .from(appReviews)
      .innerJoin(users, eq(users.id, appReviews.userId))
      .where(where)
      .orderBy(...order)
      .limit(options.limit)
      .offset(options.offset),
    db.select({ value: count() }).from(appReviews).where(where),
  ]);

  // Both are per-PAGE lookups keyed on the rows just read, so neither grows
  // with the number of reviews the app has.
  const [replies, grants] = rows.length
    ? await Promise.all([
        db
          .select({
            reviewId: appReviewReplies.reviewId,
            body: appReviewReplies.body,
            createdAt: appReviewReplies.createdAt,
          })
          .from(appReviewReplies)
          .where(inArray(appReviewReplies.reviewId, rows.map((row) => row.id))),
        db
          .select({ userId: appGrants.userId })
          .from(appGrants)
          .where(
            and(
              eq(appGrants.applicationId, listing.applicationId),
              inArray(appGrants.userId, rows.map((row) => row.authorId))
            )
          ),
      ])
    : [[], []];

  const replyByReview = new Map(replies.map((reply) => [reply.reviewId, reply]));
  const authorsWithGrant = new Set(grants.map((grant) => grant.userId));

  return {
    items: rows.map((row) => {
      const reply = replyByReview.get(row.id);
      return {
        id: row.id,
        rating: row.rating,
        title: row.title,
        body: row.body,
        createdAt: row.createdAt,
        author: { id: row.authorId, username: row.authorUsername },
        reply: reply ? { body: reply.body, createdAt: reply.createdAt } : null,
        authorUsesApp: authorsWithGrant.has(row.authorId),
      };
    }),
    total: Number(totals?.value ?? 0),
  };
}

/**
 * A shelf as everyone sees it.
 *
 * `order` is included: the storefront does not need it, but a curator moving a
 * shelf has to be able to see where it currently sits, and one shape for one
 * row is better than two that differ by a field.
 */
export interface StoreCategoryRow {
  slug: string;
  label: string;
  description: string | null;
  order: number;
}

const CATEGORY_COLUMNS = {
  slug: appCategories.slug,
  label: appCategories.label,
  description: appCategories.description,
  order: appCategories.order,
} as const;

/** The shelves, in their curated order. */
export async function listCategories(): Promise<StoreCategoryRow[]> {
  return getDb()
    .select(CATEGORY_COLUMNS)
    .from(appCategories)
    .orderBy(asc(appCategories.order), asc(appCategories.id));
}

// ============================================================================
// Writes
//
// The reads above answer `null` because "this slug is not a published listing"
// is the only way they fail. A write has several distinct outcomes — no such
// page, nothing of yours to delete, not yours to answer — and one sentinel
// cannot say which, so these throw the error that names the outcome and the
// routes stay free of translation.
// ============================================================================

/** A review as its own author sees it, whatever its moderation state. */
export interface StoreOwnReview {
  id: string;
  rating: number;
  title: string | null;
  body: string | null;
  /** Its own author is told when their review is hidden; the public list is not. */
  status: AppReviewStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** The columns an author is served for their own review. */
const OWN_REVIEW_COLUMNS = {
  id: appReviews.id,
  rating: appReviews.rating,
  title: appReviews.title,
  body: appReviews.body,
  status: appReviews.status,
  createdAt: appReviews.createdAt,
  updatedAt: appReviews.updatedAt,
} as const;

/** The application behind a published listing, or a 404. */
async function requirePublishedApplicationId(slug: string): Promise<string> {
  const [listing] = await getDb()
    .select({ applicationId: appListings.applicationId })
    .from(appListings)
    .where(and(eq(appListings.slug, slug), eq(appListings.status, 'published')))
    .limit(1);
  // The same answer a read gives: whether an unpublished page exists under this
  // slug is not something a write attempt gets to reveal either.
  if (!listing) throw new NotFoundError('App not found');
  return listing.applicationId;
}

/**
 * Write the caller's review of an app, creating it or replacing what they said
 * before.
 *
 * One statement, because `unique(application_id, user_id)` is what actually
 * enforces one-review-per-person: a read-then-insert passes its own check
 * twice under concurrency and the second insert is the one that raises. The
 * conflict clause turns that race into the edit the person asked for.
 *
 * Editing does NOT reset moderation — a hidden review stays hidden when its
 * author rewrites it, or hiding one would be undone by whoever wrote it.
 */
export async function upsertReview(options: {
  slug: string;
  userId: string;
  rating: number;
  title?: string | null;
  body?: string | null;
}): Promise<StoreOwnReview> {
  const applicationId = await requirePublishedApplicationId(options.slug);

  // Absent stays absent and blank becomes absent: an empty string is a value,
  // and `app_reviews` keeps "wrote no title" as NULL rather than as `''`.
  const title = options.title?.trim() || null;
  const body = options.body?.trim() || null;

  const [row] = await getDb()
    .insert(appReviews)
    .values({ applicationId, userId: options.userId, rating: options.rating, title, body })
    .onConflictDoUpdate({
      target: [appReviews.applicationId, appReviews.userId],
      set: { rating: options.rating, title, body, updatedAt: new Date() },
    })
    .returning(OWN_REVIEW_COLUMNS);

  return row;
}

/** The caller's own review of an app, or null if they have not written one. */
export async function getOwnReview(options: {
  slug: string;
  userId: string;
}): Promise<StoreOwnReview | null> {
  const applicationId = await requirePublishedApplicationId(options.slug);

  const [row] = await getDb()
    .select(OWN_REVIEW_COLUMNS)
    .from(appReviews)
    .where(and(eq(appReviews.applicationId, applicationId), eq(appReviews.userId, options.userId)))
    .limit(1);

  return row ?? null;
}

/**
 * Withdraw the caller's own review.
 *
 * A real delete, not a status change: `removed` is a moderator's verdict about
 * someone's words, and an author taking their own words back is not that.
 */
export async function deleteOwnReview(options: { slug: string; userId: string }): Promise<void> {
  const applicationId = await requirePublishedApplicationId(options.slug);

  const deleted = await getDb()
    .delete(appReviews)
    .where(and(eq(appReviews.applicationId, applicationId), eq(appReviews.userId, options.userId)))
    .returning({ id: appReviews.id });

  if (deleted.length === 0) throw new NotFoundError('You have not reviewed this app');
}

/**
 * Authorise `userId` to answer `reviewId` on the publisher's behalf.
 *
 * The right to reply is not a store concept: it is `app:update` over the
 * application's owning account, resolved through the same
 * `AccountMember` graph — with inheritance, per-member revokes and all — that
 * governs every other write to that application. So a store listing cannot
 * become a second, weaker way to act as somebody's app.
 */
async function requirePublisherAccess(reviewId: string, userId: string): Promise<void> {
  const [review] = await getDb()
    .select({ ownerAccountId: applications.ownerAccountId })
    .from(appReviews)
    .innerJoin(applications, eq(applications.id, appReviews.applicationId))
    .where(eq(appReviews.id, reviewId))
    .limit(1);

  if (!review) throw new NotFoundError('Review not found');

  const access = await accountService.resolveEffectiveAccess(userId, review.ownerAccountId);
  if (!access || !appPermissionsForAccountAccess(access).includes('app:update')) {
    throw new ForbiddenError('You cannot reply on behalf of this app');
  }
}

export interface StoreReply {
  id: string;
  reviewId: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Post or rewrite the publisher's answer to a review.
 *
 * `unique(review_id)` is why this is an upsert rather than an insert: one
 * answer per review is the shape the table declares, and two people holding
 * `app:update` pressing reply at once must not produce two.
 *
 * `author_user_id` is overwritten with whoever wrote the current text, because
 * attribution that survived an edit by a colleague would name the wrong person.
 */
export async function upsertReply(options: {
  reviewId: string;
  authorUserId: string;
  body: string;
}): Promise<StoreReply> {
  await requirePublisherAccess(options.reviewId, options.authorUserId);

  const [row] = await getDb()
    .insert(appReviewReplies)
    .values({ reviewId: options.reviewId, authorUserId: options.authorUserId, body: options.body })
    .onConflictDoUpdate({
      target: appReviewReplies.reviewId,
      set: { body: options.body, authorUserId: options.authorUserId, updatedAt: new Date() },
    })
    .returning({
      id: appReviewReplies.id,
      reviewId: appReviewReplies.reviewId,
      body: appReviewReplies.body,
      createdAt: appReviewReplies.createdAt,
      updatedAt: appReviewReplies.updatedAt,
    });

  return row;
}

/** Withdraw the publisher's answer. Same gate as writing it. */
export async function deleteReply(options: {
  reviewId: string;
  authorUserId: string;
}): Promise<void> {
  await requirePublisherAccess(options.reviewId, options.authorUserId);

  const deleted = await getDb()
    .delete(appReviewReplies)
    .where(eq(appReviewReplies.reviewId, options.reviewId))
    .returning({ id: appReviewReplies.id });

  if (deleted.length === 0) throw new NotFoundError('This review has no reply');
}

// ============================================================================
// The publisher's side of a listing
//
// Everything above is read by, or written by, whoever is looking at the store.
// What follows is written by whoever OWNS the app, and the split it respects is
// the one `app_listings` documents: the publisher writes the words and the
// pictures; the STATUS is not theirs to set. Editing content and moving a page
// through review are therefore different calls, not one call with a `status`
// field somebody could pass `published` to.
//
// Authorisation lives in the routes, on `requireAppPermission('app:update')` —
// the same middleware that guards credentials and webhooks. This module never
// re-derives who may act for an application.
// ============================================================================

/** A listing as its owner sees it: whatever state it is in, with its shelf. */
export interface PublisherListing {
  id: string;
  applicationId: string;
  slug: string;
  tagline: string | null;
  description: string | null;
  category: { slug: string; label: string } | null;
  supportUrl: string | null;
  supportEmail: string | null;
  status: AppListingStatus;
  publishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Read one listing back with its category resolved, by application. */
async function publisherListings(
  where: SQL | undefined,
  order?: { limit: number; offset: number }
): Promise<PublisherListing[]> {
  const query = getDb()
    .select({
      id: appListings.id,
      applicationId: appListings.applicationId,
      slug: appListings.slug,
      tagline: appListings.tagline,
      description: appListings.description,
      supportUrl: appListings.supportUrl,
      supportEmail: appListings.supportEmail,
      status: appListings.status,
      publishedAt: appListings.publishedAt,
      createdAt: appListings.createdAt,
      updatedAt: appListings.updatedAt,
      categorySlug: appCategories.slug,
      categoryLabel: appCategories.label,
    })
    .from(appListings)
    .leftJoin(appCategories, eq(appCategories.id, appListings.categoryId))
    .where(where)
    .orderBy(asc(appListings.updatedAt), asc(appListings.id));

  const rows = await (order ? query.limit(order.limit).offset(order.offset) : query);

  return rows.map(({ categorySlug, categoryLabel, ...listing }) => ({
    ...listing,
    category: categorySlug ? { slug: categorySlug, label: categoryLabel! } : null,
  }));
}

/** Read one listing back with its category resolved, by application. */
async function publisherListingFor(applicationId: string): Promise<PublisherListing | null> {
  const [listing] = await publisherListings(eq(appListings.applicationId, applicationId));
  return listing ?? null;
}

/** The listing for an application, in whatever state, or null if it has none. */
export async function getListingForApplication(
  applicationId: string
): Promise<PublisherListing | null> {
  return publisherListingFor(applicationId);
}

/**
 * Create or replace the CONTENT of an application's listing.
 *
 * A `PUT` of the whole page rather than a patch of some of it: the console
 * edits one form, and a partial update would make "the tagline is absent" and
 * "leave the tagline alone" the same request.
 *
 * The status is untouched — a new page starts as a `draft` by the column's
 * default, and an existing page keeps whatever review state it is in. So
 * correcting a typo on a live page does not silently unpublish it, and editing
 * a rejected one does not re-submit it.
 */
export async function upsertListing(options: {
  applicationId: string;
  slug: string;
  tagline?: string | null;
  description?: string | null;
  categorySlug?: string | null;
  supportUrl?: string | null;
  supportEmail?: string | null;
}): Promise<PublisherListing> {
  const db = getDb();

  let categoryId: string | null = null;
  if (options.categorySlug) {
    const [category] = await db
      .select({ id: appCategories.id })
      .from(appCategories)
      .where(eq(appCategories.slug, options.categorySlug))
      .limit(1);
    // Named, not ignored: silently filing a page under "uncategorised" because
    // a shelf was misspelled is the kind of thing nobody notices until a
    // publisher asks why their app is nowhere.
    if (!category) throw new BadRequestError(`No such category: ${options.categorySlug}`);
    categoryId = category.id;
  }

  const content = {
    slug: options.slug,
    tagline: options.tagline?.trim() || null,
    description: options.description?.trim() || null,
    categoryId,
    supportUrl: options.supportUrl?.trim() || null,
    supportEmail: options.supportEmail?.trim() || null,
  };

  try {
    await db
      .insert(appListings)
      .values({ applicationId: options.applicationId, ...content })
      .onConflictDoUpdate({
        target: appListings.applicationId,
        set: { ...content, updatedAt: new Date() },
      });
  } catch (error) {
    // Named, not bare: `app_listings` carries TWO unique constraints, and a
    // bare check would report "the slug is taken" for whichever of them fired.
    // `application_id` is the conflict target here so it cannot raise today —
    // pinning the name is what keeps the message honest if that ever changes.
    if (isUniqueViolation(error, 'app_listings_slug_unique')) {
      throw new ConflictError(`The slug "${options.slug}" is already taken`);
    }
    throw error;
  }

  // Re-read rather than `returning()`: the caller needs the category resolved
  // to its slug and label, which an insert cannot join.
  const listing = await publisherListingFor(options.applicationId);
  if (!listing) throw new InternalServerError('The listing vanished as it was written');
  return listing;
}

/**
 * Move a listing between states, checking what it is moving FROM.
 *
 * The guard is the point: a transition that did not check would let a rejected
 * page be published by replaying a request, and would let a submission
 * "succeed" against a page already live.
 */
async function transitionListing(options: {
  applicationId: string;
  from: readonly AppListingStatus[];
  to: AppListingStatus;
  publishedAt?: Date | null;
}): Promise<PublisherListing> {
  const [current] = await getDb()
    .select({ status: appListings.status, publishedAt: appListings.publishedAt })
    .from(appListings)
    .where(eq(appListings.applicationId, options.applicationId))
    .limit(1);

  if (!current) throw new NotFoundError('This application has no listing');
  if (!options.from.includes(current.status)) {
    throw new ConflictError(`A ${current.status} listing cannot become ${options.to}`);
  }

  await getDb()
    .update(appListings)
    .set({
      status: options.to,
      // `publishedAt` is only ever written on the first publish: a page taken
      // down and put back up has one publication date and many edits.
      ...(options.publishedAt !== undefined && current.publishedAt === null
        ? { publishedAt: options.publishedAt }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(appListings.applicationId, options.applicationId));

  const listing = await publisherListingFor(options.applicationId);
  if (!listing) throw new NotFoundError('This application has no listing');
  return listing;
}

/** Hand a draft — or a rejected page, once fixed — to the store for review. */
export async function submitListing(applicationId: string): Promise<PublisherListing> {
  return transitionListing({
    applicationId,
    from: ['draft', 'rejected'],
    to: 'pending_review',
  });
}

/**
 * Take a page down, or withdraw it from the queue.
 *
 * Back to `draft` rather than deleted: the slug, the words and the screenshots
 * are the publisher's work, and unlisting an app should not destroy them. It
 * also keeps the reviews, which hang off the application and were never the
 * listing's to take with it.
 */
export async function unpublishListing(applicationId: string): Promise<PublisherListing> {
  return transitionListing({
    applicationId,
    from: ['published', 'pending_review'],
    to: 'draft',
  });
}

// ============================================================================
// Store moderation
//
// Staff-only, and separate from the publisher's calls above for the reason the
// two states exist: `pending_review` is the store's judgement of a page, and a
// publisher who could grant it would make the queue decorative.
// ============================================================================

/** The review queue, oldest first — a submission should not wait behind newer ones. */
export async function listListingsAwaitingReview(options: {
  limit: number;
  offset: number;
}): Promise<{ items: PublisherListing[]; total: number }> {
  const where = eq(appListings.status, 'pending_review');

  const [items, [totals]] = await Promise.all([
    publisherListings(where, options),
    getDb().select({ value: count() }).from(appListings).where(where),
  ]);

  return { items, total: Number(totals?.value ?? 0) };
}

/** Publish a page that was submitted for review. */
export async function approveListing(applicationId: string): Promise<PublisherListing> {
  return transitionListing({
    applicationId,
    from: ['pending_review'],
    to: 'published',
    publishedAt: new Date(),
  });
}

/** Send a page back. It returns to the publisher, who may fix it and re-submit. */
export async function rejectListing(applicationId: string): Promise<PublisherListing> {
  return transitionListing({
    applicationId,
    from: ['pending_review'],
    to: 'rejected',
  });
}

// ============================================================================
// Screenshots
//
// A picture on a store page is a row rather than an entry in a `text[]`, and
// `app_listing_screenshots` says why: each carries a caption, a platform and a
// position, and `file_id` is a real foreign key, so a purged asset cannot leave
// a hole on a published page.
//
// Every write below is scoped to the listing as well as to the screenshot id.
// An id alone would let anyone holding `app:update` on THEIR app edit a picture
// on somebody else's, which is the shape of every id-guessing bug ever filed.
// ============================================================================

export interface ListingScreenshot {
  id: string;
  fileId: string;
  platform: AppScreenshotPlatform;
  caption: string | null;
  position: number;
}

const SCREENSHOT_COLUMNS = {
  id: appListingScreenshots.id,
  fileId: appListingScreenshots.fileId,
  platform: appListingScreenshots.platform,
  caption: appListingScreenshots.caption,
  position: appListingScreenshots.position,
} as const;

/** The listing an application must already have before it can hold pictures. */
async function requireListingId(applicationId: string): Promise<string> {
  const [listing] = await getDb()
    .select({ id: appListings.id })
    .from(appListings)
    .where(eq(appListings.applicationId, applicationId))
    .limit(1);

  if (!listing) throw new NotFoundError('This application has no listing');
  return listing.id;
}

/** Every picture on a listing, in the author's order. */
export async function listScreenshots(applicationId: string): Promise<ListingScreenshot[]> {
  const listingId = await requireListingId(applicationId);

  return getDb()
    .select(SCREENSHOT_COLUMNS)
    .from(appListingScreenshots)
    .where(eq(appListingScreenshots.listingId, listingId))
    .orderBy(asc(appListingScreenshots.position), asc(appListingScreenshots.id));
}

/**
 * Attach an already-uploaded image to the listing.
 *
 * The file is checked here rather than left to the foreign key, because the FK
 * only proves the row exists. Three things have to hold, and each has its own
 * answer: the asset must not be in the trash, it must be an image, and the
 * caller must be entitled to it — which is the account graph's question again,
 * asked of the file's owner, so a colleague can attach an asset the account
 * owns and nobody can attach a stranger's.
 */
export async function addScreenshot(options: {
  applicationId: string;
  callerUserId: string;
  fileId: string;
  platform?: AppScreenshotPlatform;
  caption?: string | null;
}): Promise<ListingScreenshot> {
  const listingId = await requireListingId(options.applicationId);

  // Three columns rather than the file repository's full record: this asks
  // "may I attach this?", not "give me the asset", and the repository's read
  // pulls the variant rows a screenshot has no use for.
  const [file] = await getDb()
    .select({ ownerUserId: files.ownerUserId, status: files.status, mime: files.mime })
    .from(files)
    .where(eq(files.id, options.fileId))
    .limit(1);

  if (!file || file.status !== 'active') throw new NotFoundError('No such file');
  if (!file.mime.startsWith('image/')) throw new BadRequestError('A screenshot must be an image');

  const entitled =
    file.ownerUserId !== null &&
    (await accountService.resolveEffectiveAccess(options.callerUserId, file.ownerUserId)) !== null;
  if (!entitled) throw new ForbiddenError('That file is not yours to publish');

  // Appended, and ties are fine: `position` is deliberately not unique, so two
  // concurrent adds landing on the same number order by `id` between them
  // rather than one of them failing.
  const [{ next } = { next: 0 }] = await getDb()
    .select({ next: sql<number>`coalesce(max(${appListingScreenshots.position}), -1) + 1` })
    .from(appListingScreenshots)
    .where(eq(appListingScreenshots.listingId, listingId));

  const [row] = await getDb()
    .insert(appListingScreenshots)
    .values({
      listingId,
      fileId: options.fileId,
      platform: options.platform ?? 'desktop',
      caption: options.caption?.trim() || null,
      position: Number(next),
    })
    .returning(SCREENSHOT_COLUMNS);

  return row;
}

/** Edit a picture's caption or the frame it was taken in. Order is `reorderScreenshots`. */
export async function updateScreenshot(options: {
  applicationId: string;
  screenshotId: string;
  platform?: AppScreenshotPlatform;
  caption?: string | null;
}): Promise<ListingScreenshot> {
  const listingId = await requireListingId(options.applicationId);

  const [row] = await getDb()
    .update(appListingScreenshots)
    .set({
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      ...(options.caption === undefined ? {} : { caption: options.caption?.trim() || null }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(appListingScreenshots.id, options.screenshotId),
        eq(appListingScreenshots.listingId, listingId)
      )
    )
    .returning(SCREENSHOT_COLUMNS);

  if (!row) throw new NotFoundError('No such screenshot on this listing');
  return row;
}

/** Remove a picture. The file itself is untouched — it may be in use elsewhere. */
export async function deleteScreenshot(options: {
  applicationId: string;
  screenshotId: string;
}): Promise<void> {
  const listingId = await requireListingId(options.applicationId);

  const deleted = await getDb()
    .delete(appListingScreenshots)
    .where(
      and(
        eq(appListingScreenshots.id, options.screenshotId),
        eq(appListingScreenshots.listingId, listingId)
      )
    )
    .returning({ id: appListingScreenshots.id });

  if (deleted.length === 0) throw new NotFoundError('No such screenshot on this listing');
}

/**
 * Set the order of every picture at once.
 *
 * The WHOLE set, not a move: a partial list would leave the pictures it omits
 * at their old positions, interleaved with the new ones, and the result is an
 * order nobody asked for. Sending every id makes the request say exactly what
 * the page should look like, and makes a client that lost a picture along the
 * way fail loudly instead of scrambling the rest.
 *
 * One transaction, because a reorder that stopped halfway is worse than one
 * that did not happen.
 */
export async function reorderScreenshots(options: {
  applicationId: string;
  screenshotIds: string[];
}): Promise<ListingScreenshot[]> {
  const listingId = await requireListingId(options.applicationId);

  const existing = await getDb()
    .select({ id: appListingScreenshots.id })
    .from(appListingScreenshots)
    .where(eq(appListingScreenshots.listingId, listingId));

  const known = new Set(existing.map((row) => row.id));
  const asked = new Set(options.screenshotIds);
  if (
    asked.size !== options.screenshotIds.length ||
    asked.size !== known.size ||
    options.screenshotIds.some((id) => !known.has(id))
  ) {
    throw new BadRequestError('Send every screenshot on the listing, exactly once');
  }

  await getDb().transaction(async (tx) => {
    for (const [position, id] of options.screenshotIds.entries()) {
      await tx
        .update(appListingScreenshots)
        .set({ position, updatedAt: new Date() })
        .where(eq(appListingScreenshots.id, id));
    }
  });

  return listScreenshots(options.applicationId);
}

// ============================================================================
// Curating the shelves
//
// `app_categories` is a table rather than a CHECK-constrained column precisely
// so the vocabulary can be edited by whoever curates the store instead of by a
// migration — see the schema. These are the calls that make that true; without
// them a typo in a shelf name could only be fixed with SQL.
//
// Staff only, like the review queue: a shelf is a decision about the store's
// shape, not about any one publisher's app.
// ============================================================================

export interface WriteCategoryInput {
  slug: string;
  label: string;
  description?: string | null;
  order?: number;
}

/** Add a shelf. */
export async function createCategory(input: WriteCategoryInput): Promise<StoreCategoryRow> {
  try {
    const [row] = await getDb()
      .insert(appCategories)
      .values({
        slug: input.slug,
        label: input.label,
        description: input.description?.trim() || null,
        order: input.order ?? 0,
      })
      .returning(CATEGORY_COLUMNS);
    return row;
  } catch (error) {
    if (isUniqueViolation(error, 'app_categories_slug_unique')) {
      throw new ConflictError(`A category with the slug "${input.slug}" already exists`);
    }
    throw error;
  }
}

/**
 * Rename a shelf, re-word it, or move it in the running order.
 *
 * The SLUG is not editable. It is what every link to a category page carries,
 * and a store that silently breaks its own URLs to fix a spelling is worse than
 * one with a misspelled slug — retiring the shelf and adding a new one is the
 * honest way to change it, and leaves the listings recoverable.
 */
export async function updateCategory(
  slug: string,
  patch: { label?: string; description?: string | null; order?: number }
): Promise<StoreCategoryRow> {
  const [row] = await getDb()
    .update(appCategories)
    .set({
      ...(patch.label === undefined ? {} : { label: patch.label }),
      ...(patch.description === undefined ? {} : { description: patch.description?.trim() || null }),
      ...(patch.order === undefined ? {} : { order: patch.order }),
      updatedAt: new Date(),
    })
    .where(eq(appCategories.slug, slug))
    .returning(CATEGORY_COLUMNS);

  if (!row) throw new NotFoundError('No such category');
  return row;
}

/**
 * Retire a shelf.
 *
 * The listings on it are NOT deleted: the foreign key is `SET NULL`, so they
 * fall back to uncategorised and someone re-files them. That is the whole
 * reason the reference is nullable — `CASCADE` here would delete a publisher's
 * page because a curator tidied the taxonomy.
 */
export async function deleteCategory(slug: string): Promise<{ listingsUncategorised: number }> {
  const db = getDb();

  const [category] = await db
    .select({ id: appCategories.id })
    .from(appCategories)
    .where(eq(appCategories.slug, slug))
    .limit(1);
  if (!category) throw new NotFoundError('No such category');

  // Counted BEFORE the delete, because afterwards there is nothing to count
  // against — and a curator deserves to be told how many pages they just moved.
  const [affected] = await db
    .select({ value: count() })
    .from(appListings)
    .where(eq(appListings.categoryId, category.id));

  await db.delete(appCategories).where(eq(appCategories.id, category.id));

  return { listingsUncategorised: Number(affected?.value ?? 0) };
}
