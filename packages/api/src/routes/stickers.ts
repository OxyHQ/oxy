/**
 * Stickers (`/stickers`) — one catalogue for every Oxy app.
 *
 * The reads are unauthenticated: a sticker is a public asset, and the apps that
 * draw one (an empty state before sign-in, a chat bubble in an end-to-end
 * encrypted conversation whose server never sees the message) cannot always
 * attach a session. They are also what an app BACKEND calls to check an id a
 * client sent before storing it.
 *
 * The files themselves are never proxied here. Every sticker carries CDN URLs
 * (`cloud.oxy.so`) with an immutable cache header, so the bytes go straight
 * from the edge to the renderer.
 *
 * `/me/*` is the signed-in person's picker, shared across apps: install a pack
 * in Allo and Mention's picker has it too. `/admin/*` is staff-only while
 * packs are curated rather than user-made.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import {
  STICKER_MAX_FALLBACK_BYTES,
  STICKER_MAX_UPLOAD_BYTES,
  createStickerPackRequestSchema,
  reorderStickerPacksRequestSchema,
  resolveStickersRequestSchema,
  updateStickerPackRequestSchema,
} from '@oxy.so/contracts';
import { asyncHandler, sendPaginated, sendSuccess } from '../utils/asyncHandler';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { requireStaff } from '../middleware/requireStaff';
import { validate } from '../middleware/validate';
import { rateLimit } from '../middleware/rateLimiter';
import { BadRequestError, NotFoundError, UnauthorizedError } from '../utils/error';
import {
  stickerAddFields,
  stickerIdParams,
  stickerPackIdParams,
  stickerPackSlugParams,
  stickerPacksQuery,
  stickerSearchQuery,
  stickerStickerParams,
} from '../schemas/stickers.schemas';
import {
  addSticker,
  archivePack,
  createPack,
  deleteDraftPack,
  getPackBySlug,
  getPackForStaff,
  installPack,
  listAllPacks,
  listInstalledPacks,
  listPublishedPacks,
  publishPack,
  removeSticker,
  reorderInstalledPacks,
  resolveStickers,
  searchStickers,
  uninstallPack,
  updatePack,
} from '../services/stickers.service';

const router = Router();

const WINDOW_1_MIN = 60 * 1000;

/**
 * Generous: a chat screen resolves every sticker in view, and an app backend
 * resolves on each post it stores. Uniquely prefixed so it shares no counter
 * with another limiter on the same Redis.
 */
const readLimiter = rateLimit({
  prefix: 'rl:stickers:read:',
  windowMs: WINDOW_1_MIN,
  max: 600,
});

/**
 * Keyed on the account, and so placed AFTER `authMiddleware` on every route —
 * `routes/store.ts` explains why a request without a resolved account is
 * skipped rather than bucketed by IP.
 */
const writeLimiter = rateLimit({
  prefix: 'rl:stickers:write:',
  windowMs: WINDOW_1_MIN,
  max: 60,
  keyGenerator: (req) => (req as AuthRequest).user?._id?.toString() ?? '',
  skip: (req) => ((req as AuthRequest).user?._id?.toString() ?? '') === '',
});

/** Catalogue reads change only when staff publish, so the edge may hold them briefly. */
const CATALOGUE_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=3600';

/**
 * Both of a sticker's files in one request. Multer caps each at the larger of
 * the two limits; `stickerValidation.ts` then holds each file to its own.
 */
const stickerFields = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 2,
    fileSize: Math.max(STICKER_MAX_UPLOAD_BYTES, STICKER_MAX_FALLBACK_BYTES),
  },
}).fields([
  { name: 'animation', maxCount: 1 },
  { name: 'fallback', maxCount: 1 },
]);

/** Multer's own errors (too large, unexpected field) are the caller's mistake: a 400, not a 500. */
const stickerUpload = (req: Request, res: Response, next: NextFunction): void => {
  stickerFields(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      next(new BadRequestError(err.message));
      return;
    }
    next(err);
  });
};

function requireUserId(req: AuthRequest): string {
  const userId = req.user?._id?.toString();
  if (!userId) throw new UnauthorizedError('Authentication required');
  return userId;
}

// ============================================================================
// Catalogue
// ============================================================================

/** GET /stickers/packs — the shop, newest first. */
router.get(
  '/packs',
  readLimiter,
  validate({ query: stickerPacksQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const { limit, offset } = req.query as unknown as { limit: number; offset: number };
    const { items, total } = await listPublishedPacks({ limit, offset });
    res.setHeader('Cache-Control', CATALOGUE_CACHE_CONTROL);
    sendPaginated(res, items, total, limit, offset);
  })
);

/** GET /stickers/packs/:slug — one pack with every sticker. */
router.get(
  '/packs/:slug',
  readLimiter,
  validate({ params: stickerPackSlugParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const pack = await getPackBySlug(req.params.slug);
    if (!pack) throw new NotFoundError('Sticker pack not found');
    res.setHeader('Cache-Control', CATALOGUE_CACHE_CONTROL);
    sendSuccess(res, pack);
  })
);

/** GET /stickers/search?emoji=😂 | ?q=cat — stickers from published packs. */
router.get(
  '/search',
  readLimiter,
  validate({ query: stickerSearchQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    const { emoji, q, limit } = req.query as unknown as { emoji?: string; q?: string; limit: number };
    res.setHeader('Cache-Control', CATALOGUE_CACHE_CONTROL);
    sendSuccess(res, { stickers: await searchStickers({ emoji, q, limit }) });
  })
);

/**
 * POST /stickers/resolve — many stickers by id. `POST` only because a list of
 * ids does not belong in a URL; it reads nothing and writes nothing. Unknown
 * ids are absent from the answer.
 */
router.post(
  '/resolve',
  readLimiter,
  validate({ body: resolveStickersRequestSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { ids } = req.body as { ids: string[] };
    sendSuccess(res, { stickers: await resolveStickers(ids) });
  })
);

// ============================================================================
// The signed-in person's picker
//
// Declared before `/:stickerId` so `me` is never read as a sticker id.
// ============================================================================

/** GET /stickers/me/packs — installed packs with their stickers, in picker order. */
router.get(
  '/me/packs',
  readLimiter,
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-cache');
    sendSuccess(res, await listInstalledPacks(requireUserId(req)));
  })
);

/** PUT /stickers/me/packs/:packId — install it. Idempotent. */
router.put(
  '/me/packs/:packId',
  authMiddleware,
  writeLimiter,
  validate({ params: stickerPackIdParams }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await installPack(requireUserId(req), req.params.packId);
    res.status(204).end();
  })
);

/** DELETE /stickers/me/packs/:packId — remove it from the picker. */
router.delete(
  '/me/packs/:packId',
  authMiddleware,
  writeLimiter,
  validate({ params: stickerPackIdParams }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await uninstallPack(requireUserId(req), req.params.packId);
    res.status(204).end();
  })
);

/** PATCH /stickers/me/packs-order — the whole installed list, first to last. */
router.patch(
  '/me/packs-order',
  authMiddleware,
  writeLimiter,
  validate({ body: reorderStickerPacksRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await reorderInstalledPacks(requireUserId(req), (req.body as { packIds: string[] }).packIds);
    res.status(204).end();
  })
);

// ============================================================================
// Staff: curating the catalogue
// ============================================================================

/** GET /stickers/admin/packs — every pack, drafts included. */
router.get(
  '/admin/packs',
  readLimiter,
  authMiddleware,
  requireStaff,
  validate({ query: stickerPacksQuery }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { limit, offset } = req.query as unknown as { limit: number; offset: number };
    const { items, total } = await listAllPacks({ limit, offset });
    sendPaginated(res, items, total, limit, offset);
  })
);

/** GET /stickers/admin/packs/:packId — one pack in any status. */
router.get(
  '/admin/packs/:packId',
  readLimiter,
  authMiddleware,
  requireStaff,
  validate({ params: stickerPackIdParams }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    sendSuccess(res, await getPackForStaff(req.params.packId));
  })
);

/** POST /stickers/admin/packs — a new draft. */
router.post(
  '/admin/packs',
  authMiddleware,
  writeLimiter,
  requireStaff,
  validate({ body: createStickerPackRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    sendSuccess(res, await createPack(req.body), 201);
  })
);

/** PATCH /stickers/admin/packs/:packId — re-title or re-word it. */
router.patch(
  '/admin/packs/:packId',
  authMiddleware,
  writeLimiter,
  requireStaff,
  validate({ params: stickerPackIdParams, body: updateStickerPackRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    sendSuccess(res, await updatePack(req.params.packId, req.body));
  })
);

/**
 * POST /stickers/admin/packs/:packId/stickers — multipart: `animation` (Lottie
 * JSON), an optional `fallback` (512×512 WebP or PNG; rendered from the
 * animation when absent), and the `emoji` / `keywords` fields as
 * comma-separated lists.
 */
router.post(
  '/admin/packs/:packId/stickers',
  authMiddleware,
  writeLimiter,
  requireStaff,
  stickerUpload,
  validate({ params: stickerPackIdParams, body: stickerAddFields }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const uploaded = req.files as Record<string, Express.Multer.File[] | undefined> | undefined;
    const animation = uploaded?.animation?.[0];
    const fallback = uploaded?.fallback?.[0];
    if (!animation) throw new BadRequestError('An "animation" file is required');
    const { emoji, keywords } = req.body as { emoji: string[]; keywords: string[] };
    const sticker = await addSticker({
      packId: req.params.packId,
      animation: animation.buffer,
      fallback: fallback ? { buffer: fallback.buffer, mime: fallback.mimetype } : undefined,
      emoji,
      keywords,
    });
    sendSuccess(res, sticker, 201);
  })
);

/** DELETE /stickers/admin/packs/:packId/stickers/:stickerId — drafts only. */
router.delete(
  '/admin/packs/:packId/stickers/:stickerId',
  authMiddleware,
  writeLimiter,
  requireStaff,
  validate({ params: stickerStickerParams }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await removeSticker(req.params.packId, req.params.stickerId);
    res.status(204).end();
  })
);

/** POST /stickers/admin/packs/:packId/publish */
router.post(
  '/admin/packs/:packId/publish',
  authMiddleware,
  writeLimiter,
  requireStaff,
  validate({ params: stickerPackIdParams }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    sendSuccess(res, await publishPack(req.params.packId));
  })
);

/** POST /stickers/admin/packs/:packId/archive — out of the shop; stickers keep resolving. */
router.post(
  '/admin/packs/:packId/archive',
  authMiddleware,
  writeLimiter,
  requireStaff,
  validate({ params: stickerPackIdParams }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    sendSuccess(res, await archivePack(req.params.packId));
  })
);

/** DELETE /stickers/admin/packs/:packId — a never-published draft only. */
router.delete(
  '/admin/packs/:packId',
  authMiddleware,
  writeLimiter,
  requireStaff,
  validate({ params: stickerPackIdParams }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await deleteDraftPack(req.params.packId);
    res.status(204).end();
  })
);

// ============================================================================
// One sticker — last, so its parameter cannot swallow the paths above.
// ============================================================================

/** GET /stickers/:stickerId */
router.get(
  '/:stickerId',
  readLimiter,
  validate({ params: stickerIdParams }),
  asyncHandler(async (req: Request, res: Response) => {
    const [sticker] = await resolveStickers([req.params.stickerId]);
    if (!sticker) throw new NotFoundError('Sticker not found');
    res.setHeader('Cache-Control', CATALOGUE_CACHE_CONTROL);
    sendSuccess(res, sticker);
  })
);

export default router;
