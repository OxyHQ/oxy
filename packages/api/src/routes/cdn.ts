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
import { CDN_REDIRECT_CACHE_CONTROL, isServableStatus } from '../config/cdn';
import { sendAssetRedirect } from '../utils/cdnRedirect';
import { logger } from '../utils/logger';
import { NotFoundError } from '../utils/error';
import { singleQueryValue } from '../utils/queryString';
import { isRenditionRevision, readyVariantRevision } from '../utils/assetRenditionRevision';

const router = express.Router();

/** How long a client should wait before asking again after a transient failure. */
const CDN_RESOLVE_RETRY_AFTER_SECONDS = 5;

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
 *       - in: query
 *         name: revision
 *         required: false
 *         schema: { type: string, format: date-time }
 *         description: >
 *           Canonical UTC ready timestamp for the requested variant. HLS uses
 *           service metadata hlsReadyAt. A stale revision resolves the current
 *           public rendition without caching; malformed revisions return 400.
 *     responses:
 *       302:
 *         description: Redirect to the public cloud.oxy.so CDN URL.
 *       404:
 *         description: No public CDN-backed asset for this id.
 *       503:
 *         description: >
 *           The asset could not be resolved right now (storage or database
 *           unavailable). Not cacheable; retry after `Retry-After` seconds.
 */
router.get(
  '/:id',
  validate({ params: assetIdParams }),
  asyncHandler(async (req, res) => {
    const { id: fileId } = req.params;
    const variant = singleQueryValue(req.query.variant);
    const revision = req.query.revision;
    if (revision !== undefined && (!variant || !isRenditionRevision(revision))) {
      res.setHeader('Cache-Control', 'no-store');
      return res
        .status(400)
        .json({ error: 'INVALID_REVISION', message: 'Invalid rendition revision' });
    }

    const file = await assetService.getFile(fileId);
    if (!file) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Resource not found' });
    }

    if (!isServableStatus(file)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Resource not found' });
    }

    // `getPublicCdnUrl` returns a `cloud.oxy.so` URL ONLY for a public file whose
    // bytes are CDN-reachable; it returns null for private/unlisted assets and
    // for public assets without a `public/` copy. Either non-result is a 404
    // here — this public origin must never stream private bytes.
    //
    // A THROW is one of two things. A rendition this file can never have (an
    // unknown size, an audio file asked for a thumbnail) is a `NotFoundError`
    // from `ensureVariant`, and a 404. Anything else (S3 or the database
    // failing, a render that did not finish) says nothing about the file, only
    // about this moment: 503, never cached, with when to ask again. A 404 there
    // told every client the file did not exist, and the image stayed broken.
    let cdnUrl: string | null;
    try {
      cdnUrl = await assetService.getPublicCdnUrl(file, variant);
    } catch (error) {
      if (error instanceof NotFoundError) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Resource not found' });
      }
      logger.warn('CDN resolve failed for public asset', {
        fileId,
        variant,
        error: error instanceof Error ? error.message : String(error),
      });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', String(CDN_RESOLVE_RETRY_AFTER_SECONDS));
      return res
        .status(503)
        .json({ error: 'SERVICE_UNAVAILABLE', message: 'File temporarily unavailable' });
    }

    if (!cdnUrl) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Resource not found' });
    }

    // Cacheable redirect: bodiless, and not rangeable. See `sendAssetRedirect`.
    // Older post snapshots still play the current rendition, but an obsolete
    // timestamp must never cache today's target as that earlier generation.
    const matchesRevision =
      revision === undefined ||
      (variant !== undefined && readyVariantRevision(file, variant) === revision);
    res.setHeader('Cache-Control', matchesRevision ? CDN_REDIRECT_CACHE_CONTROL : 'no-store');
    return sendAssetRedirect(res, cdnUrl);
  }),
);

export default router;
