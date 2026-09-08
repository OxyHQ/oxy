/**
 * Public CDN origin resolver — `GET /cdn/:id`.
 *
 * This is the origin endpoint behind the `cloud.oxy.so/<id>` CloudFront
 * behavior. CloudFront is configured with `OriginPath = /cdn`, so a browser
 * request for `https://cloud.oxy.so/<id>` is forwarded to this API as
 * `GET /cdn/<id>`. The route resolves the file id to its `cloud.oxy.so` CDN URL
 * and 302-redirects to it.
 *
 * Hard contract: this path serves ONLY public, CDN-backed assets. It has NO
 * auth and NO CSRF (it is a public CDN origin). It NEVER streams raw bytes and
 * NEVER exposes a private/unlisted asset — anything that is not an active, public
 * file with a CDN-reachable (`public/`-prefixed) copy resolves to a 404. The actual
 * "resolve public file id → cloud CDN url (or null)" decision is owned by
 * `assetService.getPublicCdnUrl`, the SAME probe used by `GET /assets/:id/stream`
 * (no duplicated visibility/placement logic here).
 */

import express from 'express';
import { assetService } from '../services/assetServiceSingleton';
import { validate } from '../middleware/validate';
import { assetIdParams } from '../schemas/assets.schemas';
import { asyncHandler } from '../utils/asyncHandler';
import { CDN_REDIRECT_CACHE_CONTROL } from '../config/cdn';
import { logger } from '../utils/logger';
import { singleQueryValue } from '../utils/queryString';

const router = express.Router();

/**
 * @openapi
 * /cdn/{id}:
 *   get:
 *     summary: Resolve a public asset id to its cloud.oxy.so CDN URL (302).
 *     description: >
 *       Public CDN origin endpoint (no auth). Redirects to the `cloud.oxy.so`
 *       CDN URL for a PUBLIC, CDN-backed asset. Private/unlisted assets, files
 *       that are not active, files with no public copy, and unknown ids all return 404 — this path never
 *       streams bytes and never exposes a non-public asset.
 *     tags: [Assets]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: variant
 *         required: false
 *         schema: { type: string }
 *         description: Optional variant (e.g. `thumb`, `w320`); omitted = original.
 *     responses:
 *       302:
 *         description: Redirect to the public cloud.oxy.so CDN URL.
 *       404:
 *         description: No public CDN-backed asset for this id.
 */
router.get(
  '/:id',
  validate({ params: assetIdParams }),
  asyncHandler(async (req: express.Request, res: express.Response) => {
    const { id: fileId } = req.params;
    const variant = singleQueryValue(req.query.variant);

    const file = await assetService.getFile(fileId);
    if (!file) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Resource not found' });
    }

    if (file.status !== 'active') {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Resource not found' });
    }

    // `getPublicCdnUrl` returns a `cloud.oxy.so` URL ONLY for a public file whose
    // bytes are CDN-reachable; it returns null for private/unlisted assets and
    // for public assets without a `public/` copy. Either non-result is a 404
    // here — this public origin must never stream private bytes or 500.
    let cdnUrl: string | null;
    try {
      cdnUrl = await assetService.getPublicCdnUrl(file, variant);
    } catch (error) {
      logger.warn('CDN resolve failed for public asset', {
        fileId,
        variant,
        error: error instanceof Error ? error.message : String(error),
      });
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Resource not found' });
    }

    if (!cdnUrl) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Resource not found' });
    }

    res.setHeader('Cache-Control', CDN_REDIRECT_CACHE_CONTROL);
    return res.redirect(cdnUrl);
  })
);

export default router;
