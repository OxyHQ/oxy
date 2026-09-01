/**
 * The app store (`/store`).
 *
 * The reads are unauthenticated on purpose: a storefront is what somebody looks
 * at before they have an account, and every row they return is already public —
 * a published listing, an application's name and icon, and reviews their
 * authors wrote to be read.
 *
 * Only `published` listings and `visible` reviews are served. A draft, a
 * rejected page and a hidden review are absent rather than marked, so no client
 * has to be trusted to filter them.
 *
 * The writes carry their own `authMiddleware` and `csrfProtection` per route
 * rather than a mount-wide one, because this router serves both and a blanket
 * middleware would either lock the storefront or leave the writes open. Reading
 * a route here tells you what guards it.
 */

import { Router, type Request, type Response } from 'express';
import { asyncHandler, sendPaginated, sendSuccess } from '../utils/asyncHandler';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { csrfProtection } from '../middleware/csrf';
import { requireStaff } from '../middleware/requireStaff';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { NotFoundError, UnauthorizedError } from '../utils/error';
import {
  storeCategoryBody,
  storeCategoryParams,
  storeCategoryPatch,
  storeListingsQuery,
  storeModerationParams,
  storeModerationQuery,
  storeReplyBody,
  storeReviewBody,
  storeReviewParams,
  storeReviewsQuery,
  storeSlugParams,
} from '../schemas/store.schemas';
import {
  approveListing,
  createCategory,
  deleteCategory,
  deleteOwnReview,
  deleteReply,
  getOwnReview,
  getPublishedListing,
  listCategories,
  listListingsAwaitingReview,
  listPublishedListings,
  listReviews,
  rejectListing,
  updateCategory,
  upsertReply,
  upsertReview,
} from '../services/store.service';

const router = Router();

const WINDOW_1_MIN = 60 * 1000;

/**
 * Uniquely prefixed, per the shared-store rule: a limiter without its own
 * prefix shares a counter with every other one on the same Redis and halves
 * both budgets.
 */
const readLimiter = rateLimit({
  prefix: 'rl:store:read:',
  windowMs: WINDOW_1_MIN,
  max: 240,
});

/**
 * Writes are keyed on the ACCOUNT, not the IP: one review per app per person is
 * already a constraint, so the budget that matters is how fast one person can
 * churn reviews across apps — and an IP key would throttle a whole office
 * network to one reviewer.
 *
 * ## The account key is only available AFTER `authMiddleware`
 *
 * This limiter therefore runs after it on every route below, and that ordering
 * is the whole mechanism rather than a detail. It used to run BEFORE
 * `authMiddleware` on all nine of them, so `req.user` was undefined every single
 * time and the `?? req.ip` fallback was not a fallback — it was the only branch
 * that ever executed. Both halves of the paragraph above were false in
 * production: every store write minted a Redis key holding a RAW CLIENT IP,
 * violating the platform's no-user-IPs-at-rest invariant, and a whole office
 * network really did share one 20-writes-per-minute budget.
 *
 * So there is no IP branch here at all, not even a hashed one. A request whose
 * account did not resolve is SKIPPED rather than bucketed under a shared key: if
 * this limiter is ever reordered in front of `authMiddleware` again the
 * degradation is "no per-account budget" — visible, and still covered by the
 * global limiters named below — instead of silently reintroducing an IP key or
 * collapsing every anonymous caller into one bucket.
 *
 * ## What guards the pre-auth lane, since this no longer does
 *
 * Two global middlewares, both registered in `server.ts` before any router and
 * neither skipping `/store`, and both already keyed through `hashedIpKey`:
 *
 *   - `rateLimiter` (`rl:general:`, 1000/15min in production) — the per-IP
 *     ceiling every unauthenticated request on this API is subject to.
 *   - `bruteForceProtection` (`slowDown`, 500ms after 100/15min) — a progressive
 *     delay on the same key.
 *
 * That is a deliberate trade, and the thing being traded away is small: an
 * unauthenticated store write reaches no database write and has no secret to
 * guess. It gets a 401 out of `authMiddleware` after a JWT decode and a cached
 * session lookup — cheaper than the storefront GETs this same file serves
 * anonymously at 240/min. A dedicated pre-auth write budget would be a second
 * Redis round-trip guarding a 401, and to avoid re-throttling that office
 * network its ceiling would have to sit near `rl:general:`'s anyway.
 */
const writeLimiter = rateLimit({
  prefix: 'rl:store:write:',
  windowMs: WINDOW_1_MIN,
  max: 20,
  keyGenerator: (req) => (req as AuthRequest).user?._id?.toString() ?? '',
  // The NEGATION of "the key exists", never a policy decision — see above for
  // why this limiter refuses to invent a key it does not have. Spelled as the
  // same expression the key generator uses, rather than as a separate test for
  // `undefined`, so the two cannot drift into disagreeing about what "no key"
  // means and leave a request bucketed under the empty string.
  skip: (req) => ((req as AuthRequest).user?._id?.toString() ?? '') === '',
});

function requireUserId(req: AuthRequest): string {
  const userId = req.user?._id?.toString();
  if (!userId) throw new UnauthorizedError('Authentication required');
  return userId;
}

/** GET /store/categories — the shelves, in curated order. */
router.get(
  '/categories',
  readLimiter,
  asyncHandler(async (_req: Request, res: Response) => {
    sendSuccess(res, await listCategories());
  })
);

/** GET /store/apps — published listings, newest first, optionally one shelf. */
router.get(
  '/apps',
  readLimiter,
  validate({ query: storeListingsQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const { category, limit, offset } = req.query as unknown as {
      category?: string;
      limit: number;
      offset: number;
    };
    const { items, total } = await listPublishedListings({ categorySlug: category, limit, offset });
    sendPaginated(res, items, total, limit, offset);
  })
);

/** GET /store/apps/:slug — one page, or 404 if it is not published. */
router.get(
  '/apps/:slug',
  readLimiter,
  validate({ params: storeSlugParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const listing = await getPublishedListing(req.params.slug);
    // The same answer for "no such app" and "not published": whether a draft
    // exists is not something an unauthenticated caller gets to learn.
    if (!listing) throw new NotFoundError('App not found');
    sendSuccess(res, listing);
  })
);

/** GET /store/apps/:slug/reviews — visible reviews, with the publisher's reply. */
router.get(
  '/apps/:slug/reviews',
  readLimiter,
  validate({ params: storeSlugParams, query: storeReviewsQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const { limit, offset, sort } = req.query as unknown as {
      limit: number;
      offset: number;
      sort: 'recent' | 'rating';
    };
    const result = await listReviews({ slug: req.params.slug, limit, offset, sort });
    if (!result) throw new NotFoundError('App not found');
    sendPaginated(res, result.items, result.total, limit, offset);
  })
);

// ============================================================================
// Writes
//
// Who may review: any signed-in Oxy account. Not `users.verified`, which is a
// standing badge an administrator sets — gating reviews on it would mean almost
// nobody could write one. Whether the reviewer has actually authorized the app
// is answered by `app_grants` and shown as `authorUsesApp` on the public list,
// which is the trust signal a reader wants and one nobody can award themselves.
// ============================================================================

/** GET /store/apps/:slug/review — the caller's own review, or null. */
router.get(
  '/apps/:slug/review',
  readLimiter,
  authMiddleware,
  validate({ params: storeSlugParams }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    sendSuccess(res, await getOwnReview({ slug: req.params.slug, userId: requireUserId(req) }));
  })
);

/**
 * PUT /store/apps/:slug/review — write or rewrite the caller's review.
 *
 * `PUT` because a person has one review of an app and this sets it. A `POST`
 * would promise a second resource on the second call, which the table's unique
 * constraint would then refuse.
 */
router.put(
  '/apps/:slug/review',
  authMiddleware,
  writeLimiter,
  csrfProtection,
  validate({ params: storeSlugParams, body: storeReviewBody }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { rating, title, body } = req.body as { rating: number; title?: string | null; body?: string | null };
    const review = await upsertReview({
      slug: req.params.slug,
      userId: requireUserId(req),
      rating,
      title,
      body,
    });
    sendSuccess(res, review);
  })
);

/** DELETE /store/apps/:slug/review — withdraw the caller's own review. */
router.delete(
  '/apps/:slug/review',
  authMiddleware,
  writeLimiter,
  csrfProtection,
  validate({ params: storeSlugParams }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await deleteOwnReview({ slug: req.params.slug, userId: requireUserId(req) });
    res.status(204).end();
  })
);

/**
 * PUT /store/reviews/:reviewId/reply — the publisher's answer.
 *
 * Addressed by review id rather than under the listing's slug: the reply
 * belongs to the review, which belongs to the application, and a listing can be
 * renamed or withdrawn out from under it.
 */
router.put(
  '/reviews/:reviewId/reply',
  authMiddleware,
  writeLimiter,
  csrfProtection,
  validate({ params: storeReviewParams, body: storeReplyBody }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const reply = await upsertReply({
      reviewId: req.params.reviewId,
      authorUserId: requireUserId(req),
      body: (req.body as { body: string }).body,
    });
    sendSuccess(res, reply);
  })
);

/** DELETE /store/reviews/:reviewId/reply — withdraw it. Same gate. */
router.delete(
  '/reviews/:reviewId/reply',
  authMiddleware,
  writeLimiter,
  csrfProtection,
  validate({ params: storeReviewParams }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await deleteReply({ reviewId: req.params.reviewId, authorUserId: requireUserId(req) });
    res.status(204).end();
  })
);

// ============================================================================
// Moderation
//
// Staff only. A publisher edits their page and hands it in — those routes hang
// off `/applications/:appId/listing`, beside the credentials and webhooks the
// same permission guards. Granting the review is the STORE's judgement, and a
// publisher who could grant it would make the queue decorative, so it lives
// here and behind `requireStaff`.
// ============================================================================

/** GET /store/moderation/listings — the queue, oldest submission first. */
router.get(
  '/moderation/listings',
  readLimiter,
  authMiddleware,
  requireStaff,
  validate({ query: storeModerationQuery }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { limit, offset } = req.query as unknown as { limit: number; offset: number };
    const { items, total } = await listListingsAwaitingReview({ limit, offset });
    sendPaginated(res, items, total, limit, offset);
  })
);

/** POST /store/moderation/listings/:applicationId/approve — publish it. */
router.post(
  '/moderation/listings/:applicationId/approve',
  authMiddleware,
  writeLimiter,
  requireStaff,
  csrfProtection,
  validate({ params: storeModerationParams }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    sendSuccess(res, await approveListing(req.params.applicationId));
  })
);

/** POST /store/moderation/listings/:applicationId/reject — send it back. */
router.post(
  '/moderation/listings/:applicationId/reject',
  authMiddleware,
  writeLimiter,
  requireStaff,
  csrfProtection,
  validate({ params: storeModerationParams }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    sendSuccess(res, await rejectListing(req.params.applicationId));
  })
);

/**
 * The shelves are curated, not migrated.
 *
 * `app_categories` is a table rather than a CHECK-constrained column exactly so
 * a curator can rename a shelf or reorder the storefront without a deploy —
 * these three routes are what make that claim true. Same `requireStaff` gate as
 * the review queue: a shelf is a decision about the store's shape.
 */

/** POST /store/moderation/categories — add a shelf. */
router.post(
  '/moderation/categories',
  authMiddleware,
  writeLimiter,
  requireStaff,
  csrfProtection,
  validate({ body: storeCategoryBody }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = req.body as {
      slug: string;
      label: string;
      description?: string | null;
      order?: number;
    };
    sendSuccess(res, await createCategory(body), 201);
  })
);

/** PATCH /store/moderation/categories/:slug — rename, re-word, or reorder it. */
router.patch(
  '/moderation/categories/:slug',
  authMiddleware,
  writeLimiter,
  requireStaff,
  csrfProtection,
  validate({ params: storeCategoryParams, body: storeCategoryPatch }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const patch = req.body as { label?: string; description?: string | null; order?: number };
    sendSuccess(res, await updateCategory(req.params.slug, patch));
  })
);

/**
 * DELETE /store/moderation/categories/:slug — retire it.
 *
 * Answers with how many listings just became uncategorised rather than 204,
 * because a curator tidying the taxonomy should be told what they moved.
 */
router.delete(
  '/moderation/categories/:slug',
  authMiddleware,
  writeLimiter,
  requireStaff,
  csrfProtection,
  validate({ params: storeCategoryParams }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    sendSuccess(res, await deleteCategory(req.params.slug));
  })
);

export default router;
