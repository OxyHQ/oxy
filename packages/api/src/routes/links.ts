/**
 * Ecosystem link-preview (URL unfurl) API.
 *
 * Every Oxy app calls these endpoints through the SDK instead of duplicating
 * link-metadata fetching. Oxy owns resolution AND image hosting: the `image` /
 * `favicon` on every returned `LinkPreview` is an Oxy-hosted `cloud.oxy.so` URL
 * (or absent), never a raw origin URL — so a client never contacts the target
 * host and the viewer's IP is never leaked.
 *
 *  - `GET /links/preview?url=&wait=0|1` → a bare `LinkPreview`. `wait=0` returns
 *    cached-or-`pending` (warms in background); `wait=1` resolves synchronously.
 *  - `POST /links/previews` → `{ data: Record<requestedUrl, LinkPreview> }`. The
 *    feed-hydration path (mirrors `POST /users/by-ids`): cached hits returned,
 *    misses returned `pending` and warmed in the background.
 *
 * Auth: `optionalUserOrServiceAuth` — a service token (server-to-server feed
 * hydration), a user session, or anonymous. The output is non-viewer-specific
 * public metadata, so no scope is required. Bearer/service only (no cookie
 * writes → no CSRF). Rate-limited per principal with a unique Redis prefix.
 */

import { Router, type Request, type Response } from 'express';
import type { z } from 'zod';
import {
  linkPreviewBatchRequestSchema,
  linkPreviewBatchResponseSchema,
  linkPreviewResponseSchema,
} from '@oxy.so/contracts';
import {
  optionalUserOrServiceAuth,
  type OptionalUserOrServiceRequest,
} from '../middleware/optionalAuth';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import { linkPreviewService } from '../services/linkPreview/linkPreviewService';
import {
  LINK_PREVIEW_BATCH_RATE_MAX,
  LINK_PREVIEW_PREVIEW_RATE_MAX,
} from '../services/linkPreview/constants';
import { linkPreviewQuerySchema } from '../schemas/links.schemas';
import { logger } from '../utils/logger';

const router = Router();

/** Rate-limit per authenticated principal (user/service), falling back to IP. */
function principalKey(req: Request): string {
  const r = req as OptionalUserOrServiceRequest;
  if (r.user?._id) return `u:${r.user._id}`;
  if (r.serviceApp?.appId) return `s:${r.serviceApp.appId}`;
  return `ip:${hashedIpKey(req)}`;
}

// Reads are cheap (cache-backed) and every app calls them with ONE shared
// service token, so the per-principal ceiling must be generous (env-tunable).
const previewLimiter = rateLimit({
  prefix: 'rl:links:preview:',
  windowMs: 60_000,
  max: LINK_PREVIEW_PREVIEW_RATE_MAX,
  keyGenerator: principalKey,
  message: 'Too many link-preview requests. Please slow down.',
});

const batchLimiter = rateLimit({
  prefix: 'rl:links:batch:',
  windowMs: 60_000,
  max: LINK_PREVIEW_BATCH_RATE_MAX,
  keyGenerator: principalKey,
  message: 'Too many link-preview batch requests. Please slow down.',
});

/**
 * GET /links/preview?url=<url>&wait=0|1
 * Returns a bare `LinkPreview` (per `linkPreviewResponseSchema`).
 */
router.get(
  '/preview',
  optionalUserOrServiceAuth,
  previewLimiter,
  validate({ query: linkPreviewQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { url, wait } = req.query as unknown as z.infer<typeof linkPreviewQuerySchema>;
    const preview = await linkPreviewService.get(url, { wait: wait === '1' });
    logger.debug('GET /links/preview', { wait, status: preview.status });
    res.json(linkPreviewResponseSchema.parse(preview));
  }),
);

/**
 * POST /links/previews  body { urls: string[] } (1..50)
 * Returns `{ data: Record<requestedUrl, LinkPreview> }` (per
 * `linkPreviewBatchResponseSchema`).
 */
router.post(
  '/previews',
  optionalUserOrServiceAuth,
  batchLimiter,
  validate({ body: linkPreviewBatchRequestSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { urls } = req.body as { urls: string[] };
    const data = await linkPreviewService.getBatch(urls);
    logger.debug('POST /links/previews', { requested: urls.length });
    res.json(linkPreviewBatchResponseSchema.parse({ data }));
  }),
);

export default router;
