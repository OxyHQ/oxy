import express from 'express';
import multer from 'multer';
import { assetService } from '../services/assetServiceSingleton';
import { s3Service } from '../services/s3ServiceSingleton';
import { authMiddleware, serviceAuthMiddleware, type ServiceAuthRequest } from '../middleware/auth';
import { optionalAuthMiddleware, getMediaViewerUserId } from '../middleware/optionalAuth';
import { mediaHeadersMiddleware } from '../middleware/mediaHeaders';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { logger } from '../utils/logger';
import { asyncHandler, sendSuccess } from '../utils/asyncHandler';
import { ApiError, BadRequestError, NotFoundError, UnauthorizedError, ForbiddenError, ValidationError, ConflictError } from '../utils/error';
import { z } from 'zod';
import type { FileLinkRecord, FileVariantRecord, FileVisibility } from '../types/file.types';
import type { MediaAccessContext } from '../types/mediaPrivacy.types';
import { validate } from '../middleware/validate';
import {
  assetIdParams,
  listAssetsQuerySchema,
  assetUrlQuerySchema,
  updateVisibilitySchema,
  batchAccessSchema,
  assetsByIdsBodySchema,
  assetsBySha256BodySchema,
  linkFileSchema,
  unlinkFileSchema,
} from '../schemas/assets.schemas';
import { generateMissingFilePlaceholder, TRANSPARENT_PNG_PLACEHOLDER } from '../utils/placeholders';
import { buildCdnUrl, stripPublicPrefix, isPublicKey, CDN_REDIRECT_MAX_AGE_SECONDS } from '../config/cdn';
import { MEDIA_TOKEN_QUERY_PARAM, MEDIA_TOKEN_TTL_SECONDS, signMediaToken } from '../utils/mediaToken';
import { FEDERATION_CACHE_MAX_BYTES, USER_MEDIA_MAX_BYTES, isAllowedCacheMime } from '../constants/federationCache';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { users } from '../db/schema';
import { resolveFileMediaMetadata } from '../utils/fileMediaMetadata';

interface AuthenticatedRequest extends express.Request {
  user?: {
    _id: string;
    [key: string]: any;
  };
}

const router = express.Router();
const upload = multer(); // memory storage

/**
 * Project a link/variant row onto the wire shape clients already receive.
 *
 * Two differences would otherwise ship silently. Mongo stored these as
 * subdocuments declared `{ _id: false }`, so they carried NO id and no parent
 * pointer — the `file_links.id` / `file_variants.id` / `file_id` columns are
 * new and internal, and must not leak. And Mongo OMITTED an unset optional
 * field, where a Postgres row spells it `null`; `JSON.stringify` drops
 * `undefined` but preserves `null`, so passing rows through verbatim would turn
 * "absent" into an explicit `null` for every consumer in the ecosystem.
 */
function serializeLink(link: FileLinkRecord) {
  return {
    app: link.app,
    entityType: link.entityType,
    entityId: link.entityId,
    createdBy: link.createdBy,
    createdAt: link.createdAt,
    ...(link.webhookUrl === null ? {} : { webhookUrl: link.webhookUrl }),
  };
}

function serializeVariant(variant: FileVariantRecord) {
  return {
    type: variant.type,
    key: variant.key,
    ...(variant.width === null ? {} : { width: variant.width }),
    ...(variant.height === null ? {} : { height: variant.height }),
    ...(variant.readyAt === null ? {} : { readyAt: variant.readyAt }),
    ...(variant.size === null ? {} : { size: variant.size }),
    ...(variant.metadata === null ? {} : { metadata: variant.metadata }),
  };
}

/**
 * Build an absolute, our-origin streaming URL for an asset on the host that
 * served this request (e.g. `https://api.oxy.so/assets/<id>/stream`). Used for
 * any asset NOT served by the public CDN (private/unlisted, or a public object
 * not yet under the `public/` prefix) so clients always hit our own domain —
 * never a raw `amazonaws.com` URL.
 *
 * `mediaToken` attaches a SCOPED media credential (`?mt=`) so an `<img src>`,
 * which can send neither an `Authorization` header nor an ambient cookie, can
 * still render a private asset the caller was already authorized for. It is
 * single-asset, read-only, and ~15-minute-lived — see `utils/mediaToken.ts`.
 * Omit it for assets that are readable anonymously.
 */
function buildOriginStreamUrl(
  req: express.Request,
  fileId: string,
  variant?: string,
  mediaToken?: string
): string {
  const host = req.get('host') ?? '';
  const url = new URL(`${req.protocol}://${host}${req.baseUrl}/${encodeURIComponent(fileId)}/stream`);
  if (variant) {
    url.searchParams.set('variant', variant);
  }
  if (mediaToken) {
    url.searchParams.set(MEDIA_TOKEN_QUERY_PARAM, mediaToken);
  }
  return url.toString();
}

/**
 * Parse a media access-check context string into a {@link MediaAccessContext}.
 *
 * The wire form is `app:entityType:entityId` (e.g. `mention:post:123`), which
 * gates media behind an entity's own visibility. Anything without at least three
 * colon-separated parts — a bare label like `file-manager`, an empty string, or a
 * non-string — carries no entity gate and resolves to `undefined`. Shared by the
 * stream route (`?context=`) and the batch route (body `context`) so both parse
 * identically.
 */
function parseMediaAccessContext(raw: unknown): MediaAccessContext | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const parts = raw.split(':');
  if (parts.length < 3) {
    return undefined;
  }
  return { app: parts[0], entityType: parts[1], entityId: parts[2] };
}

// Auth applied per-route: authMiddleware for private routes,
// optionalAuthMiddleware for public stream/download endpoints.
// AssetService is a shared singleton (services/assetServiceSingleton.ts) so
// every consumer (assets routes, email controller, email service) shares the
// same in-memory fileCache.

// Validation schemas
const initUploadSchema = z.object({
  sha256: z.string().length(64, 'SHA256 must be 64 characters'),
  size: z.number().positive('Size must be positive'),
  mime: z.string().min(1, 'MIME type is required')
});

const completeUploadSchema = z.object({
  fileId: z.string().min(1, 'File ID is required'),
  originalName: z.string().min(1, 'Original name is required'),
  size: z.number().positive('Size must be positive'),
  mime: z.string().min(1, 'MIME type is required'),
  visibility: z.enum(['private', 'public', 'unlisted']).optional(),
  metadata: z.record(z.any()).optional()
});

/**
 * @openapi
 * /assets:
 *   get:
 *     tags:
 *       - Files
 *     summary: List the user's files
 *     description: >
 *       Paginated list of files owned by the authenticated user, including
 *       upload status, deduplication info (`sha256`), variants (thumbnails,
 *       resized renditions), and any entity links.
 *     parameters:
 *       - name: limit
 *         in: query
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *       - name: offset
 *         in: query
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *     responses:
 *       200:
 *         description: Paginated file list.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 files:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 hasMore:
 *                   type: boolean
 *       401:
 *         description: Missing or invalid bearer token.
 */
router.get('/', authMiddleware, validate({ query: listAssetsQuerySchema }), asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
  const user = req.user;
  if (!user?._id) {
    throw new UnauthorizedError('Authentication required');
  }

  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const { files, total } = await assetService.listFilesByUser(user._id, limit, offset);

  sendSuccess(res, {
    files: files.map((file) => ({
      id: file.id,
      sha256: file.sha256,
      size: file.size,
      mime: file.mime,
      ext: file.ext,
      originalName: file.originalName,
      ownerUserId: file.ownerUserId,
      status: file.status,
      usageCount: file.links.length,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      links: file.links.map(serializeLink),
      variants: file.variants.map(serializeVariant),
      metadata: file.metadata,
    })),
    total,
    hasMore: offset + files.length < total,
  });
}));

/**
 * @openapi
 * /assets/init:
 *   post:
 *     tags:
 *       - Files
 *     summary: Initialise a file upload
 *     description: >
 *       First call in the two-step upload flow. Submit the file's SHA-256,
 *       size, and MIME type and receive a `fileId` plus a pre-signed S3
 *       upload URL. If a file with the same SHA-256 already exists for the
 *       caller, the server short-circuits and returns the existing record
 *       (de-duplication).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - sha256
 *               - size
 *               - mime
 *             properties:
 *               sha256:
 *                 type: string
 *                 minLength: 64
 *                 maxLength: 64
 *                 example: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
 *               size:
 *                 type: integer
 *                 minimum: 1
 *                 example: 12345
 *               mime:
 *                 type: string
 *                 example: image/png
 *     responses:
 *       200:
 *         description: Upload initialised.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 fileId:
 *                   type: string
 *                 uploadUrl:
 *                   type: string
 *                   description: Pre-signed S3 PUT URL.
 *                 storageKey:
 *                   type: string
 *                 deduplicated:
 *                   type: boolean
 *                   description: True if the SHA-256 was already present.
 *       400:
 *         description: Validation failed.
 *       401:
 *         description: Missing or invalid bearer token.
 */
router.post('/init', authMiddleware, validate({ body: initUploadSchema }), asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
  const user = req.user;
  if (!user?._id) {
    throw new UnauthorizedError('Authentication required');
  }

  let validatedData;
  try {
    validatedData = initUploadSchema.parse(req.body);
  } catch (error: any) {
    if (error.name === 'ZodError') {
      throw new ValidationError('Invalid request data', { details: error.errors });
    }
    throw error;
  }
  
  const result = await assetService.initUpload(
    user._id,
    validatedData.sha256,
    validatedData.size,
    validatedData.mime
  );

  logger.info('Asset upload initialized', { 
    userId: user._id, 
    fileId: result.fileId,
    sha256: result.sha256
  });

  sendSuccess(res, result);
}));

/**
 * @openapi
 * /assets/complete:
 *   post:
 *     tags:
 *       - Files
 *     summary: Complete a file upload
 *     description: >
 *       Second call in the two-step upload flow. Call this after the client
 *       has finished PUTing the file to the pre-signed S3 URL returned by
 *       `/assets/init`. Commits the metadata, marks the file ready, and
 *       enqueues variant generation (thumbnails, image resizes) where
 *       applicable.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fileId
 *               - originalName
 *               - size
 *               - mime
 *             properties:
 *               fileId:
 *                 type: string
 *               originalName:
 *                 type: string
 *                 example: profile.png
 *               size:
 *                 type: integer
 *                 example: 12345
 *               mime:
 *                 type: string
 *                 example: image/png
 *               visibility:
 *                 type: string
 *                 enum: [private, public, unlisted]
 *                 default: private
 *               metadata:
 *                 type: object
 *                 additionalProperties: true
 *     responses:
 *       200:
 *         description: File committed.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 assetId:
 *                   type: string
 *                 file:
 *                   type: object
 *       400:
 *         description: Validation failed.
 *       401:
 *         description: Missing or invalid bearer token.
 */
router.post('/complete', authMiddleware, validate({ body: completeUploadSchema }), asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
  const user = req.user;
  if (!user?._id) {
    throw new UnauthorizedError('Authentication required');
  }

  let validatedData;
  try {
    validatedData = completeUploadSchema.parse(req.body);
  } catch (error: any) {
    if (error.name === 'ZodError') {
      throw new ValidationError('Invalid request data', { details: error.errors });
    }
    throw error;
  }
  
  const file = await assetService.completeUpload(validatedData);

  logger.info('Asset upload completed', { 
    userId: user._id, 
    fileId: file.id,
    originalName: validatedData.originalName
  });

  sendSuccess(res, {
    assetId: file.id,
    file: {
      id: file.id,
      sha256: file.sha256,
      size: file.size,
      mime: file.mime,
      originalName: file.originalName,
      status: file.status,
      usageCount: file.links.length,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      links: file.links.map(serializeLink),
      variants: file.variants.map(serializeVariant)
    }
  });
}));

/**
 * @route POST /api/assets/:id/upload-direct
 * @desc Direct upload via API (bypasses browser CORS for presigned PUT)
 * @access Private
 */
router.post('/:id/upload-direct', authMiddleware, validate({ params: assetIdParams }), upload.single('file'), asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
  const user = req.user;
  if (!user?._id) {
    throw new UnauthorizedError('Authentication required');
  }

  const { id: fileId } = req.params;
  if (!req.file) {
    throw new BadRequestError('Missing file');
  }

  // Defense-in-depth: reject a present-but-empty upload so an empty object is
  // never written to the predetermined storage key.
  if (!req.file.buffer || req.file.buffer.length === 0) {
    throw new BadRequestError('Empty file');
  }

  const file = await assetService.getFile(fileId);
  if (!file) {
    throw new NotFoundError('File not found');
  }
  if (file.status === 'deleted') {
    throw new BadRequestError('Cannot upload to deleted file');
  }

  // Upload buffer to the predetermined storageKey
  await s3Service.uploadBuffer(file.storageKey, req.file.buffer, {
    contentType: req.file.mimetype || file.mime || 'application/octet-stream'
  });

  sendSuccess(res, { fileId, key: file.storageKey });
}));

/**
 * @openapi
 * /assets/upload:
 *   post:
 *     tags:
 *       - Files
 *     summary: Upload a file in a single request
 *     description: >
 *       Convenience endpoint that wraps the init/PUT/complete flow into a
 *       single multipart upload. The backend computes the SHA-256 itself.
 *       Use this for small files where the round-trip cost outweighs the
 *       benefit of direct-to-S3 streaming.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *               visibility:
 *                 type: string
 *                 enum: [private, public, unlisted]
 *                 default: private
 *               metadata:
 *                 type: string
 *                 description: Optional JSON-encoded metadata object.
 *     responses:
 *       200:
 *         description: File uploaded and committed.
 *       400:
 *         description: Missing file or malformed metadata.
 *       401:
 *         description: Missing or invalid bearer token.
 */
router.post('/upload', authMiddleware, upload.single('file'), asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
  const user = req.user;
  if (!user?._id) {
    throw new UnauthorizedError('Authentication required');
  }

  if (!req.file) {
    throw new BadRequestError('Missing file');
  }

  // Defense-in-depth: reject a present-but-empty upload before any record is
  // created. A 0-byte buffer would otherwise hash to the empty-content SHA-256
  // and persist an empty asset.
  if (!req.file.buffer || req.file.buffer.length === 0) {
    throw new BadRequestError('Empty file');
  }

  const visibility = (req.body.visibility as FileVisibility) || 'private';
  let metadata: Record<string, unknown> | undefined;
  if (req.body.metadata) {
    try {
      metadata = JSON.parse(req.body.metadata);
    } catch {
      throw new BadRequestError('Invalid metadata JSON');
    }
  }

  const file = await assetService.uploadFileDirect(
    user._id,
    req.file.buffer,
    req.file.mimetype || 'application/octet-stream',
    req.file.originalname || req.file.fieldname || 'upload',
    visibility,
    metadata
  );

  logger.info('File uploaded via direct endpoint', { 
    userId: user._id, 
    fileId: file.id,
    sha256: file.sha256
  });

  sendSuccess(res, {
    file: {
      id: file.id,
      sha256: file.sha256,
      size: file.size,
      mime: file.mime,
      ext: file.ext,
      originalName: file.originalName,
      visibility: file.visibility,
      metadata: file.metadata,
      links: file.links.map(serializeLink),
      variants: file.variants.map(serializeVariant)
    }
  });
}));

// ---------------------------------------------------------------------------
// Service-token media cache (federation)
//
// Scoped, service-token-only surface that lets backend services (e.g. the
// Mention backend) cache federated/remote media to Oxy S3 and evict it. These
// routes do NOT touch the user-facing /assets/upload or DELETE /assets/:id
// paths, which stay session-only. Every asset created here is force-owned by
// the reserved cache namespace and tagged with the cache purpose, so a leaked
// service token can only ever touch cache objects — never user media.
//
// Registered BEFORE the wildcard `/:id` routes below so the more specific
// `/service/cache` paths are never shadowed.
// ---------------------------------------------------------------------------

// Cache rate-limit tuning. Bounds the write budget a single (possibly abused)
// service token can drive. At 256 MiB/object the upload cap is the cost lever:
// 30 uploads/min × 256 MiB ≈ 7.5 GB/min sustained worst case, bounded — vs.
// ~30 GB/min at the previous 120/min. Deletes are cheap (S3 DELETE), so they
// keep a higher ceiling.
const CACHE_RATE_WINDOW_MS = 60 * 1000;
const CACHE_UPLOAD_MAX_PER_MINUTE = 30;
const CACHE_DELETE_MAX_PER_MINUTE = 240;
/** See {@link assetServiceLookupLimiter} for how this ceiling was chosen. */
const SERVICE_LOOKUP_MAX_PER_MINUTE = 600;

function requireServiceScope(req: ServiceAuthRequest, scope: string): void {
  const scopes = req.serviceApp?.scopes ?? [];
  if (!scopes.includes(scope)) {
    throw new ForbiddenError(`Missing required scope: ${scope}`);
  }
}

function getSingleHeader(req: express.Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Per-app rate limit for cache uploads. Keyed on the service `appId` (falling
 * back to IP) so one misbehaving service can't exhaust the budget for others.
 * Unique redis prefix per the rate-limiter convention to avoid double-counting.
 */
const cacheUploadLimiter = rateLimit({
  prefix: 'rl:asset-cache:upload:',
  windowMs: CACHE_RATE_WINDOW_MS,
  max: CACHE_UPLOAD_MAX_PER_MINUTE,
  message: 'Too many media cache uploads. Please slow down.',
  keyGenerator: (req: express.Request) => {
    const serviceApp = (req as ServiceAuthRequest).serviceApp;
    if (serviceApp?.appId) {
      return `asset-cache:upload:${serviceApp.appId}`;
    }
    return `asset-cache:upload:ip:${hashedIpKey(req)}`;
  },
});

/**
 * Per-app rate limit for the two bulk service LOOKUPS (`/service/by-ids`,
 * `/service/by-sha256`). Both are exempt from the general per-IP browser budget
 * via `SERVICE_TO_SERVICE_BULK_PATHS`, so this is their SOLE ceiling for
 * authenticated service traffic and the invariant that exemption depends on.
 * (Requests WITHOUT a valid service token are never exempted, so they remain
 * under `rl:general` — this limiter bounds the authenticated path.)
 *
 * Sized for the workload that exposed the gap: a relying app's media-metadata
 * backfill resolves up to {@link SERVICE_ASSET_METADATA cap} 100 ids per request,
 * so 600/min per app is 60,000 ids/min — comfortably above any backfill sweep
 * while still bounding a runaway loop or a compromised credential. Deliberately
 * far above `cacheUploadLimiter`'s 30/min: that guards an S3 write, this is a
 * projected read of documents by `_id`.
 *
 * Unique redis prefix per the rate-limiter convention — a duplicated prefix on a
 * shared store makes a request increment the same counter twice
 * (`ERR_ERL_DOUBLE_COUNT`) and silently halves the budget.
 */
const assetServiceLookupLimiter = rateLimit({
  prefix: 'rl:asset-lookup:',
  windowMs: CACHE_RATE_WINDOW_MS,
  max: SERVICE_LOOKUP_MAX_PER_MINUTE,
  message: 'Too many asset metadata lookups. Please slow down.',
  keyGenerator: (req: express.Request) => {
    const serviceApp = (req as ServiceAuthRequest).serviceApp;
    if (serviceApp?.appId) {
      return `asset-lookup:${serviceApp.appId}`;
    }
    return `asset-lookup:ip:${hashedIpKey(req)}`;
  },
});

const cacheDeleteLimiter = rateLimit({
  prefix: 'rl:asset-cache:delete:',
  windowMs: CACHE_RATE_WINDOW_MS,
  max: CACHE_DELETE_MAX_PER_MINUTE,
  message: 'Too many media cache deletions. Please slow down.',
  keyGenerator: (req: express.Request) => {
    const serviceApp = (req as ServiceAuthRequest).serviceApp;
    if (serviceApp?.appId) {
      return `asset-cache:delete:${serviceApp.appId}`;
    }
    return `asset-cache:delete:ip:${hashedIpKey(req)}`;
  },
});

/**
 * @route POST /api/assets/service/cache
 * @desc Stream-upload a remote/federated media file into the reserved cache
 *       namespace. The raw bytes are sent as the request body (NOT multipart)
 *       so large video streams straight to S3 without buffering in RAM.
 *       Content-Type must be image/*, video/*, or audio/*.
 * @access Service token only (requires files:write)
 */
router.post(
  '/service/cache',
  serviceAuthMiddleware,
  cacheUploadLimiter,
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    requireServiceScope(req, 'files:write');

    const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!mime) {
      throw new BadRequestError('Content-Type header is required');
    }
    if (!isAllowedCacheMime(mime)) {
      throw new ApiError(415, 'Unsupported media type for cache', 'UNSUPPORTED_MEDIA_TYPE');
    }

    // Reject oversized payloads up front when the client declares a length.
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > FEDERATION_CACHE_MAX_BYTES) {
      throw new ApiError(413, 'Cached media exceeds the maximum allowed size', 'PAYLOAD_TOO_LARGE');
    }

    const originalNameHeader = req.headers['x-original-name'];
    const originalName =
      typeof originalNameHeader === 'string' && originalNameHeader.trim().length > 0
        ? originalNameHeader.trim().slice(0, 255)
        : 'federation-cache-media';

    try {
      const file = await assetService.uploadCachedMediaStream(
        req,
        mime,
        originalName,
        FEDERATION_CACHE_MAX_BYTES
      );

      logger.info('Federation media cached', {
        appId: req.serviceApp?.appId,
        appName: req.serviceApp?.appName,
        fileId: file.id,
        mime,
        size: file.size,
      });

      sendSuccess(res, {
        file: {
          id: file.id,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'CacheMediaTooLargeError') {
        throw new ApiError(413, 'Cached media exceeds the maximum allowed size', 'PAYLOAD_TOO_LARGE');
      }
      throw error;
    }
  })
);

/**
 * @route POST /api/assets/service/federation
 * @desc Stream-upload durable federated media into a normal public file owned by
 *       the resolved federated Oxy user. Unlike `/service/cache`, files created
 *       here are not in the eviction namespace and can safely be referenced from
 *       persisted Mention posts.
 * @access Service token only (requires files:write)
 */
router.post(
  '/service/federation',
  serviceAuthMiddleware,
  cacheUploadLimiter,
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    requireServiceScope(req, 'files:write');

    const ownerUserId = getSingleHeader(req, 'x-owner-user-id')?.trim();
    if (!ownerUserId) {
      throw new BadRequestError('x-owner-user-id must be a valid federated user id');
    }

    // An id of the wrong SHAPE is no longer a separate 400: a `text` primary key
    // matches no row, so it lands on the same 403 an id that simply names no
    // federated account does. That is the answer this endpoint already gives for
    // "not a federated user", and it is the accurate one.
    const [owner] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, ownerUserId), eq(users.type, 'federated')))
      .limit(1);
    if (!owner) {
      throw new ForbiddenError('Federated media owner must be an existing federated user');
    }

    const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!mime) {
      throw new BadRequestError('Content-Type header is required');
    }
    if (!isAllowedCacheMime(mime)) {
      throw new ApiError(415, 'Unsupported media type for federation upload', 'UNSUPPORTED_MEDIA_TYPE');
    }

    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > FEDERATION_CACHE_MAX_BYTES) {
      throw new ApiError(413, 'Federated media exceeds the maximum allowed size', 'PAYLOAD_TOO_LARGE');
    }

    const originalNameHeader = getSingleHeader(req, 'x-original-name');
    const originalName = originalNameHeader && originalNameHeader.trim().length > 0
      ? originalNameHeader.trim().slice(0, 255)
      : 'federation-media';

    const metadataHeader = getSingleHeader(req, 'x-media-metadata');
    let metadata: Record<string, unknown> | undefined;
    if (metadataHeader) {
      try {
        metadata = JSON.parse(metadataHeader) as Record<string, unknown>;
      } catch {
        throw new BadRequestError('x-media-metadata must be valid JSON');
      }
    }

    try {
      const file = await assetService.uploadFederatedMediaStream(
        req,
        mime,
        originalName,
        FEDERATION_CACHE_MAX_BYTES,
        ownerUserId,
        {
          ...(metadata || {}),
          serviceAppId: req.serviceApp?.appId,
          serviceAppName: req.serviceApp?.appName,
        }
      );

      logger.info('Federation media persisted', {
        appId: req.serviceApp?.appId,
        appName: req.serviceApp?.appName,
        ownerUserId,
        fileId: file.id,
        mime,
        size: file.size,
      });

      sendSuccess(res, {
        file: {
          id: file.id,
          sha256: file.sha256,
          size: file.size,
          mime: file.mime,
          visibility: file.visibility,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'CacheMediaTooLargeError') {
        throw new ApiError(413, 'Federated media exceeds the maximum allowed size', 'PAYLOAD_TOO_LARGE');
      }
      throw error;
    }
  })
);

/**
 * @route POST /api/assets/service/user-media
 * @desc Stream-upload durable media into a normal public file owned by an
 *       existing local Oxy user. Used by Mention MCP intent-media when the
 *       caller authenticates with an MCP JWT (no Oxy session bearer).
 * @access Service token only (requires files:write)
 */
router.post(
  '/service/user-media',
  serviceAuthMiddleware,
  cacheUploadLimiter,
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    requireServiceScope(req, 'files:write');

    const ownerUserId = getSingleHeader(req, 'x-owner-user-id')?.trim();
    if (!ownerUserId) {
      throw new BadRequestError('x-owner-user-id must be a valid user id');
    }

    // Same reasoning as `/service/federation` above: a malformed id matches no
    // row and gets the endpoint's existing "not an existing local user" 403.
    const [owner] = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, ownerUserId), eq(users.type, 'local')))
      .limit(1);
    if (!owner) {
      throw new ForbiddenError('User media owner must be an existing local user');
    }

    const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!mime) {
      throw new BadRequestError('Content-Type header is required');
    }
    if (!mime.startsWith('image/') && !mime.startsWith('video/')) {
      throw new ApiError(415, 'Unsupported media type for user upload', 'UNSUPPORTED_MEDIA_TYPE');
    }
    if (!isAllowedCacheMime(mime)) {
      throw new ApiError(415, 'Unsupported media type for user upload', 'UNSUPPORTED_MEDIA_TYPE');
    }

    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > USER_MEDIA_MAX_BYTES) {
      throw new ApiError(413, 'User media exceeds the maximum allowed size', 'PAYLOAD_TOO_LARGE');
    }

    const originalNameHeader = getSingleHeader(req, 'x-original-name');
    const originalName = originalNameHeader && originalNameHeader.trim().length > 0
      ? originalNameHeader.trim().slice(0, 255)
      : 'user-media';

    const metadataHeader = getSingleHeader(req, 'x-media-metadata');
    let metadata: Record<string, unknown> | undefined;
    if (metadataHeader) {
      try {
        metadata = JSON.parse(metadataHeader) as Record<string, unknown>;
      } catch {
        throw new BadRequestError('x-media-metadata must be valid JSON');
      }
    }

    try {
      const file = await assetService.uploadUserMediaStream(
        req,
        mime,
        originalName,
        USER_MEDIA_MAX_BYTES,
        ownerUserId,
        {
          ...(metadata || {}),
          serviceAppId: req.serviceApp?.appId,
          serviceAppName: req.serviceApp?.appName,
        }
      );

      logger.info('User media persisted', {
        appId: req.serviceApp?.appId,
        appName: req.serviceApp?.appName,
        ownerUserId,
        fileId: file.id,
        mime,
        size: file.size,
      });

      sendSuccess(res, {
        file: {
          id: file.id,
          sha256: file.sha256,
          size: file.size,
          mime: file.mime,
          visibility: file.visibility,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'CacheMediaTooLargeError') {
        throw new ApiError(413, 'User media exceeds the maximum allowed size', 'PAYLOAD_TOO_LARGE');
      }
      throw error;
    }
  })
);

/**
 * @route DELETE /api/assets/service/cache/:id
 * @desc Evict a cached media asset by id. Rejects (403) anything that is not
 *       in the reserved cache namespace, so a service token can never delete
 *       user-owned media.
 * @access Service token only (requires federation:write)
 */
router.delete(
  '/service/cache/:id',
  serviceAuthMiddleware,
  cacheDeleteLimiter,
  validate({ params: assetIdParams }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    requireServiceScope(req, 'federation:write');

    const { id: fileId } = req.params;

    const result = await assetService.deleteCachedMedia(fileId);

    if (result.outOfScope) {
      throw new ForbiddenError('Asset is not a federation media-cache object');
    }
    if (!result.deleted) {
      throw new NotFoundError('Cached asset not found');
    }

    logger.info('Federation media cache evicted', {
      appId: req.serviceApp?.appId,
      appName: req.serviceApp?.appName,
      fileId,
    });

    sendSuccess(res, { message: 'Cached asset deleted successfully' });
  })
);

/**
 * @openapi
 * /assets/service/by-ids:
 *   post:
 *     tags:
 *       - Files
 *     summary: Batch-resolve asset metadata for a service
 *     description: >
 *       Service-token-only batch metadata read. Given up to 100 file ids,
 *       returns the content hash (`sha256`), `mime`, `size`, and `status` for
 *       each KNOWN, non-deleted file. This is a METADATA-ONLY surface — it never
 *       returns bytes, signed URLs, owner ids, links, or any other field, so a
 *       service token can map a file id to its content hash without being able
 *       to read private file contents. Unknown, invalid, or deleted ids are
 *       silently omitted from `data` (the batch never 404s as a whole).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - ids
 *             properties:
 *               ids:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 100
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: Resolved asset metadata (order not guaranteed).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       sha256:
 *                         type: string
 *                       mime:
 *                         type: string
 *                       size:
 *                         type: integer
 *                       status:
 *                         type: string
 *                         enum: [active, trash]
 *       400:
 *         description: Validation failed (empty array or more than 100 ids).
 *       401:
 *         description: Missing or expired service token.
 *       403:
 *         description: Not a service token, or missing the files:read scope.
 */
router.post(
  '/service/by-ids',
  serviceAuthMiddleware,
  assetServiceLookupLimiter,
  validate({ body: assetsByIdsBodySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    requireServiceScope(req, 'files:read');

    const { ids } = req.body as { ids: string[] };

    const files = await assetService.getFilesByIds(ids);

    // Metadata only: never expose bytes, signed URLs, owner ids, storage keys,
    // links, or variants. Deleted tombstones are omitted so a resolved id always
    // maps to a live asset.
    const data = files
      .filter((file) => file.status !== 'deleted')
      .map((file) => {
        const media = resolveFileMediaMetadata(file);
        return {
          id: file.id,
          sha256: file.sha256,
          mime: file.mime,
          size: file.size,
          status: file.status,
          ...(media.width !== undefined ? { width: media.width } : {}),
          ...(media.height !== undefined ? { height: media.height } : {}),
          ...(media.durationSec !== undefined ? { durationSec: media.durationSec } : {}),
          ...(media.orientation !== undefined ? { orientation: media.orientation } : {}),
          ...(media.aspectRatio !== undefined ? { aspectRatio: media.aspectRatio } : {}),
        };
      });

    logger.debug('POST /assets/service/by-ids', {
      appId: req.serviceApp?.appId,
      requested: ids.length,
      resolved: data.length,
    });

    sendSuccess(res, data);
  })
);

/**
 * @openapi
 * /assets/service/by-sha256:
 *   post:
 *     tags:
 *       - Files
 *     summary: Reverse content-address resolve assets by SHA-256
 *     description: >
 *       Service-token-only batch REVERSE lookup. Given up to 100 lowercase hex
 *       SHA-256 content hashes, resolves each to the live (non-deleted) Oxy asset
 *       holding that content: its file `id`, `mime`, byte `size`, `status`, and —
 *       for ACTIVE, PUBLIC, CDN-reachable assets only — a public `url`
 *       (`cloud.oxy.so`). This is the inverse of `POST /assets/service/by-ids`:
 *       callers (e.g. Mention's MTN materializer / node-blob sync) that hold a
 *       record's `blob.sha256` use it to find the servable asset for that
 *       content. Private/unlisted assets omit `url`. Unknown, invalid, or deleted
 *       hashes are silently omitted from `data` (the batch never 404s as a
 *       whole); the result may be shorter than the requested list — map by
 *       `sha256`.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - sha256s
 *             properties:
 *               sha256s:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 100
 *                 items:
 *                   type: string
 *                   pattern: '^[a-f0-9]{64}$'
 *     responses:
 *       200:
 *         description: Resolved asset metadata (order not guaranteed).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       sha256:
 *                         type: string
 *                       id:
 *                         type: string
 *                       mime:
 *                         type: string
 *                       size:
 *                         type: integer
 *                       status:
 *                         type: string
 *                         enum: [active, trash]
 *                       url:
 *                         type: string
 *                         description: Public CDN URL; present only for active, public, CDN-reachable assets.
 *       400:
 *         description: Validation failed (empty array, > 100 hashes, or a non-hex digest).
 *       401:
 *         description: Missing or expired service token.
 *       403:
 *         description: Not a service token, or missing the files:read scope.
 */
router.post(
  '/service/by-sha256',
  serviceAuthMiddleware,
  assetServiceLookupLimiter,
  validate({ body: assetsBySha256BodySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    requireServiceScope(req, 'files:read');

    const { sha256s } = req.body as { sha256s: string[] };

    // Dedupe so a single batch never issues duplicate work; the schema already
    // lowercased + validated each entry as a 64-char hex digest.
    const uniqueShas = Array.from(new Set(sha256s));

    // One live record per hash: several File docs can share a sha256 (per-owner),
    // so the service collapses each hash to a single deterministic representative
    // (oldest by createdAt/_id) — the sha256 -> id mapping is stable across calls.
    const files = await assetService.findActiveFilesBySha256(uniqueShas);

    // Resolve the public CDN URL for active public assets. getPublicCdnUrl gates
    // on active+public and verifies CDN reachability (returns null otherwise), so
    // private/unlisted/non-reachable assets simply omit `url`. Never expose
    // bytes, owner ids, storage keys, links, or variants.
    const data = await Promise.all(
      files.map(async (file) => {
        let url: string | null = null;
        try {
          url = await assetService.getPublicCdnUrl(file);
        } catch (error) {
          // A transient S3/variant error on one hash must not 500 the whole
          // batch — omit `url` and keep metadata (mirrors batch-access).
          logger.warn('service/by-sha256: CDN resolution failed; omitting url', {
            sha256: file.sha256,
            fileId: file.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        const media = resolveFileMediaMetadata(file);
        return {
          sha256: file.sha256,
          id: file.id,
          mime: file.mime,
          size: file.size,
          status: file.status,
          ...(url ? { url } : {}),
          ...(media.width !== undefined ? { width: media.width } : {}),
          ...(media.height !== undefined ? { height: media.height } : {}),
          ...(media.durationSec !== undefined ? { durationSec: media.durationSec } : {}),
          ...(media.orientation !== undefined ? { orientation: media.orientation } : {}),
          ...(media.aspectRatio !== undefined ? { aspectRatio: media.aspectRatio } : {}),
        };
      })
    );

    logger.debug('POST /assets/service/by-sha256', {
      appId: req.serviceApp?.appId,
      requested: uniqueShas.length,
      resolved: data.length,
    });

    sendSuccess(res, data);
  })
);

/**
 * @route POST /api/assets/:id/links
 * @desc Link file to an entity
 * @access Private
 */
router.post('/:id/links', authMiddleware, validate({ params: assetIdParams, body: linkFileSchema }), asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
  const user = req.user;
  if (!user?._id) {
    throw new UnauthorizedError('Authentication required');
  }

  const { id: fileId } = req.params;
  let validatedData: z.infer<typeof linkFileSchema>;
  try {
    validatedData = linkFileSchema.parse(req.body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationError('Invalid request data', { details: error.errors });
    }
    throw error;
  }

  const linkRequest = {
    ...validatedData,
    createdBy: user._id,
    webhookUrl: validatedData.webhookUrl
  };

  const file = await assetService.linkFile(fileId, linkRequest);

  logger.info('File linked successfully', { 
    userId: user._id, 
    fileId,
    linkRequest
  });

  sendSuccess(res, {
    assetId: file.id,
    file: {
      id: file.id,
      usageCount: file.links.length,
      links: file.links.map(serializeLink),
      status: file.status
    }
  });
}));

/**
 * @route DELETE /api/assets/:id/links
 * @desc Remove link from file
 * @access Private
 */
router.delete('/:id/links', authMiddleware, validate({ params: assetIdParams, body: unlinkFileSchema }), asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
  const user = req.user;
  if (!user?._id) {
    throw new UnauthorizedError('Authentication required');
  }

  const { id: fileId } = req.params;
  let validatedData;
  try {
    validatedData = unlinkFileSchema.parse(req.body);
  } catch (error: any) {
    if (error.name === 'ZodError') {
      throw new ValidationError('Invalid request data', { details: error.errors });
    }
    throw error;
  }
  
  const file = await assetService.unlinkFile(
    fileId,
    validatedData.app,
    validatedData.entityType,
    validatedData.entityId
  );

  logger.info('File unlinked successfully', { 
    userId: user._id, 
    fileId,
    unlinkRequest: validatedData
  });

  sendSuccess(res, {
    file: {
      id: file.id,
      usageCount: file.links.length,
      links: file.links.map(serializeLink),
      status: file.status
    }
  });
}));

/**
 * @openapi
 * /assets/{id}:
 *   get:
 *     tags:
 *       - Files
 *     summary: Get file metadata
 *     description: >
 *       Return metadata for the file (size, MIME, SHA-256, variants, links,
 *       usage count, status). Only the owner can fetch metadata; signed
 *       URLs (`/assets/:id/url` or `/assets/:id/stream`) are the public
 *       access path.
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: File metadata.
 *       401:
 *         description: Missing or invalid bearer token.
 *       404:
 *         description: File not found.
 */
router.get('/:id', authMiddleware, validate({ params: assetIdParams }), asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
  const user = req.user;
  if (!user?._id) {
    throw new UnauthorizedError('Authentication required');
  }

  const { id: fileId } = req.params;
  const file = await assetService.getFile(fileId);

  if (!file) {
    throw new NotFoundError('File not found');
  }

  logger.debug('File metadata retrieved', {
    userId: user._id,
    fileId
  });

  sendSuccess(res, {
    assetId: file.id,
    file: {
      id: file.id,
      sha256: file.sha256,
      size: file.size,
      mime: file.mime,
      ext: file.ext,
      originalName: file.originalName,
      ownerUserId: file.ownerUserId,
      status: file.status,
      usageCount: file.links.length,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      links: file.links.map(serializeLink),
      variants: file.variants.map(serializeVariant),
      metadata: file.metadata
    }
  });
}));

/**
 * @openapi
 * /assets/{id}/url:
 *   get:
 *     tags:
 *       - Files
 *     summary: Get a download URL for a file
 *     description: >
 *       Return a CDN URL (for public files) or a pre-signed S3 URL (for
 *       private files) suitable for `<img src>` or direct download. The URL
 *       is valid for `expiresIn` seconds (default 3600).
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: variant
 *         in: query
 *         required: false
 *         schema:
 *           type: string
 *           description: 'Variant name (e.g. "thumb-256", "medium").'
 *       - name: expiresIn
 *         in: query
 *         required: false
 *         schema:
 *           type: integer
 *           default: 3600
 *           description: Seconds the signed URL stays valid.
 *     responses:
 *       200:
 *         description: Signed URL.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:
 *                   type: string
 *                   format: uri
 *                 variant:
 *                   type: [string, "null"]
 *                 expiresIn:
 *                   type: integer
 *       401:
 *         description: Missing or invalid bearer token.
 *       404:
 *         description: File not found.
 */
router.get('/:id/url', authMiddleware, validate({ params: assetIdParams, query: assetUrlQuerySchema }), asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
  const user = req.user;
  if (!user?._id) {
    throw new UnauthorizedError('Authentication required');
  }

  const { id: fileId } = req.params;
  const { variant, expiresIn } = req.query;

  const variantType = typeof variant === 'string' ? variant : undefined;
  const expiry = typeof expiresIn === 'string' ? Number.parseInt(expiresIn) : 3600;

  const file = await assetService.getFile(fileId);
  if (!file) {
    throw new NotFoundError('File not found');
  }

  // The caller must actually be allowed to see this asset before we hand back a
  // renderable URL. `authMiddleware` proves identity; this proves authorization
  // for THIS asset (ownership, follow/block, entity context) — so we never mint
  // a media token for an asset the caller can't access.
  if (!(await assetService.canUserAccessFile(file, user._id))) {
    logger.warn('Access denied to asset URL', { fileId, userId: user._id, visibility: file.visibility });
    throw new ForbiddenError('Access denied');
  }

  // Public + CDN-reachable → clean CDN URL (no credential). Otherwise serve
  // through our own origin (never a raw S3 URL). A non-public asset streamed
  // through origin needs a SCOPED media token so the resulting `<img src>` —
  // which can carry neither a bearer nor a cookie — renders for this authorized
  // viewer. Public-but-not-yet-CDN-prefixed assets are readable anonymously, so
  // they get no token.
  let cdnUrl: string | null = null;
  try {
    cdnUrl = await assetService.getFileUrl(fileId, variantType, expiry, file);
  } catch (error) {
    logger.warn('asset URL: CDN resolution failed; falling back to origin stream URL', {
      fileId,
      variant: variantType,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const mediaToken = cdnUrl || file.visibility === 'public'
    ? undefined
    : signMediaToken(fileId, user._id);
  const url = cdnUrl ?? buildOriginStreamUrl(req, fileId, variantType, mediaToken);

  logger.debug('File URL generated', {
    userId: user._id,
    fileId,
    variant: variantType,
    via: cdnUrl ? 'cdn' : 'origin',
    scoped: Boolean(mediaToken),
  });

  sendSuccess(res, {
    url,
    variant: variantType,
    expiresIn: mediaToken ? MEDIA_TOKEN_TTL_SECONDS : expiry,
  });
}));

/**
 * @route GET /api/assets/:id/exists
 * @desc Debug: return storageKey and existence of the underlying object
 * @access Private
 */
router.get('/:id/exists', authMiddleware, validate({ params: assetIdParams }), asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
  const user = req.user;
  if (!user?._id) {
    throw new UnauthorizedError('Authentication required');
  }

  const { id: fileId } = req.params;
  const file = await assetService.getFile(fileId);
  if (!file) {
    throw new NotFoundError('File not found');
  }

  const exists = await s3Service.fileExists(file.storageKey);
  sendSuccess(res, {
    fileId,
    storageKey: file.storageKey,
    exists,
    hasVariants: Array.isArray(file.variants) && file.variants.length > 0
  });
}));

/**
 * @openapi
 * /assets/{id}/stream:
 *   get:
 *     tags:
 *       - Files
 *     summary: Stream file bytes (with correct headers)
 *     description: >
 *       Public endpoint that streams the raw file bytes back to the caller.
 *       Sends correct `Content-Type` and `Cache-Control` headers and falls
 *       back to a placeholder if the underlying object is missing
 *       (`?fallback=placeholder|placeholderVisible|icon`). For private files
 *       the caller must supply a bearer token.
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *       - name: variant
 *         in: query
 *         required: false
 *         schema:
 *           type: string
 *       - name: fallback
 *         in: query
 *         required: false
 *         schema:
 *           type: string
 *           enum: [placeholder, placeholderVisible, icon]
 *     responses:
 *       200:
 *         description: File bytes streamed (or placeholder if fallback requested).
 *       302:
 *         description: Redirect to pre-signed S3 URL.
 *       403:
 *         description: Access denied.
 *       404:
 *         description: File not found (and no fallback requested).
 */
router.get('/:id/stream', mediaHeadersMiddleware, validate({ params: assetIdParams }), optionalAuthMiddleware, asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
  // `<img src>` can send neither an Authorization header nor a cookie, so resolve
  // the viewer from the scoped `?mt=` media token (bound to this file id) when no
  // session user is present, so owners can render their own private media. Access
  // is still gated by canUserAccessFile.
  const userId = getMediaViewerUserId(req);
  const { id: fileId } = req.params;
  const { variant } = req.query;
  const variantType = typeof variant === 'string' ? variant : undefined;

  const fallback = typeof req.query.fallback === 'string' ? req.query.fallback : '';

  const file = await assetService.getFile(fileId);
  if (!file) {
    if (fallback === 'placeholderVisible' || fallback === 'icon') {
      const svg = generateMissingFilePlaceholder(fileId);
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).end(svg);
    }
    if (fallback === 'placeholder') {
      const buf = Buffer.from(TRANSPARENT_PNG_PLACEHOLDER, 'base64');
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).end(buf);
    }
    throw new NotFoundError('File not found');
  }

  const context = parseMediaAccessContext(req.query.context);

  if (!(await assetService.canUserAccessFile(file, userId, context))) {
    logger.warn('Access denied to file', { fileId, userId, visibility: file.visibility });
    if (fallback === 'placeholderVisible' || fallback === 'icon') {
      const svg = generateMissingFilePlaceholder(fileId);
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).end(svg);
    }
    if (fallback === 'placeholder') {
      const buf = Buffer.from(TRANSPARENT_PNG_PLACEHOLDER, 'base64');
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).end(buf);
    }
    throw new ForbiddenError('Access denied');
  }

  // Resolve variant storageKey if requested
  let storageKey = file.storageKey;
  if (variantType) {
    try {
      const ensured = await assetService.ensureVariant(fileId, variantType, file);
      storageKey = ensured.key;
    } catch (e: any) {
      logger.warn('Variant ensure failed', { fileId, variantType, error: e?.message });
      if (fallback === 'placeholder') {
        const buf = Buffer.from(TRANSPARENT_PNG_PLACEHOLDER, 'base64');
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Length', String(buf.length));
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).end(buf);
      }
      if (fallback === 'icon' || fallback === 'placeholderVisible') {
        const svg = generateMissingFilePlaceholder(fileId);
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).end(svg);
      }
      throw new NotFoundError('File not found');
    }
  }

  let storageExists = await s3Service.fileExists(storageKey);
  if (!storageExists && storageKey === file.storageKey) {
    const repaired = await assetService.repairMissingFederationFileContent(file);
    if (repaired) {
      storageExists = true;
      if (variantType) {
        try {
          const ensured = await assetService.ensureVariant(fileId, variantType, file);
          storageKey = ensured.key;
          storageExists = await s3Service.fileExists(storageKey);
        } catch (e: any) {
          logger.warn('Variant ensure failed after repairing original', {
            fileId,
            variantType,
            error: e?.message,
          });
          storageExists = false;
        }
      }
    }
  }

  if (!storageExists) {
    logger.warn('Asset metadata points to a missing storage object', {
      fileId,
      variant: variantType,
      storageKey,
    });
    if (fallback === 'placeholder') {
      const buf = Buffer.from(TRANSPARENT_PNG_PLACEHOLDER, 'base64');
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).end(buf);
    }
    if (fallback === 'icon' || fallback === 'placeholderVisible') {
      const svg = generateMissingFilePlaceholder(fileId);
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).end(svg);
    }
    throw new NotFoundError('File not found');
  }

  // Public + CDN-reachable object → redirect to the public CDN (our own domain,
  // `cloud.oxy.so`). No raw S3 URL is ever handed to the client.
  if (file.visibility === 'public') {
    // Fast path: the resolved object key is already under the `public/` prefix
    // (every new upload, and any visibility-relocated object) — no S3 probe.
    if (isPublicKey(storageKey)) {
      res.setHeader('Cache-Control', `public, max-age=${CDN_REDIRECT_MAX_AGE_SECONDS}`);
      return res.redirect(buildCdnUrl(stripPublicPrefix(storageKey)));
    }

    // Legacy public object whose DB key still points at a non-public key, but
    // whose bytes were copied under `public/` by the CDN backfill. Reuse the
    // same variant-aware probe `/assets/:id/url` uses so the CDN serves the
    // bytes for the REQUESTED variant (thumb/w320/original). Only fall through
    // to origin streaming when no `public/` copy exists (or the probe errors).
    try {
      const cdnUrl = await assetService.getPublicCdnUrl(file, variantType);
      if (cdnUrl) {
        res.setHeader('Cache-Control', `public, max-age=${CDN_REDIRECT_MAX_AGE_SECONDS}`);
        return res.redirect(cdnUrl);
      }
    } catch (cdnProbeError) {
      logger.debug('CDN probe failed for public asset stream; streaming through origin', {
        fileId,
        variant: variantType,
        error: cdnProbeError instanceof Error ? cdnProbeError.message : String(cdnProbeError),
      });
    }
  }

  // Otherwise stream the bytes THROUGH our origin (access was already checked
  // above): private/unlisted assets, and public objects not yet under the
  // `public/` prefix. Never a 302 to an `amazonaws.com` URL. Range requests are
  // honoured so video seeking works.
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  try {
    const streamInfo = await s3Service.getObjectStreamRange(storageKey, rangeHeader);

    if (streamInfo.contentType) {
      res.setHeader('Content-Type', streamInfo.contentType);
    }
    if (streamInfo.contentLength != null) {
      res.setHeader('Content-Length', String(streamInfo.contentLength));
    }
    if (streamInfo.contentRange) {
      res.setHeader('Content-Range', streamInfo.contentRange);
    }
    res.setHeader('Accept-Ranges', streamInfo.acceptRanges ?? 'bytes');
    if (streamInfo.lastModified) {
      res.setHeader('Last-Modified', new Date(streamInfo.lastModified).toUTCString());
    }
    if (streamInfo.etag) {
      res.setHeader('ETag', streamInfo.etag);
    }
    res.setHeader(
      'Cache-Control',
      file.visibility === 'public'
        ? 'public, max-age=3600'
        : 'private, max-age=3600'
    );
    res.status(streamInfo.statusCode);

    streamInfo.body.on('error', (err: Error) => {
      logger.error('Stream error', { fileId, error: err.message });
      if (!res.headersSent) {
        res.status(500).end('Stream error');
      } else {
        res.end();
      }
    });

    streamInfo.body.pipe(res);
  } catch (streamError) {
    const errName = streamError instanceof Error ? streamError.name : '';
    if (errName === 'NoSuchKey' || errName === 'NotFound') {
      if (fallback === 'placeholder') {
        const buf = Buffer.from(TRANSPARENT_PNG_PLACEHOLDER, 'base64');
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Length', String(buf.length));
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).end(buf);
      }
      if (fallback === 'icon' || fallback === 'placeholderVisible') {
        const svg = generateMissingFilePlaceholder(fileId);
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).end(svg);
      }
      throw new NotFoundError('File not found');
    }
    throw streamError;
  }
}));

/**
 * @route GET /api/assets/:id/download
 * @desc Redirect to the signed file URL (suitable for <img src> and direct downloads)
 * @access Public (with optional authentication for private files)
 */
router.get('/:id/download', validate({ params: assetIdParams }), optionalAuthMiddleware, asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
  // Resolve viewer from the scoped `?mt=` media token for direct-download links
  // that cannot carry an Authorization header or cookie (owners downloading
  // their own private files). Access is still gated by canUserAccessFile below.
  const userId = getMediaViewerUserId(req);
  const { id: fileId } = req.params;
  const { variant, expiresIn } = req.query;

  // Get file and check permissions
  const file = await assetService.getFile(fileId);
  if (!file) {
    throw new NotFoundError('File not found');
  }

  // Check access permissions
  if (!(await assetService.canUserAccessFile(file, userId))) {
    logger.warn('Access denied to file download', { fileId, userId, visibility: file.visibility });
    throw new ForbiddenError('Access denied');
  }

  const variantType = typeof variant === 'string' ? variant : undefined;
  const expiry = typeof expiresIn === 'string' ? Number.parseInt(expiresIn) : 3600;

  if (!(await assetService.fileContentExists(fileId, file))) {
    await assetService.repairMissingFederationFileContent(file);
  }

  // Public + CDN-reachable → CDN URL; otherwise redirect to our own origin
  // stream endpoint (which proxies the bytes). Never a raw S3 URL. A non-public
  // asset needs a freshly-scoped media token on the redirect target so the
  // follow-up stream request (which also carries no bearer/cookie) renders for
  // this authorized viewer.
  let cdnUrl: string | null = null;
  try {
    cdnUrl = await assetService.getFileUrl(fileId, variantType, expiry, file);
  } catch (error) {
    logger.warn('asset download: CDN resolution failed; falling back to origin stream URL', {
      fileId,
      variant: variantType,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const mediaToken = cdnUrl || file.visibility === 'public' || !userId
    ? undefined
    : signMediaToken(fileId, userId);
  const url = cdnUrl ?? buildOriginStreamUrl(req, fileId, variantType, mediaToken);
  res.setHeader('Cache-Control', 'private, max-age=60');
  return res.redirect(url);
}));

/**
 * @route POST /api/assets/:id/restore
 * @desc Restore file from trash
 * @access Private
 */
router.post('/:id/restore', authMiddleware, validate({ params: assetIdParams }), asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
  const user = req.user;
  if (!user?._id) {
    throw new UnauthorizedError('Authentication required');
  }

  const { id: fileId } = req.params;
  const file = await assetService.restoreFile(fileId);

  logger.info('File restored from trash', { 
    userId: user._id, 
    fileId
  });

  sendSuccess(res, {
    file: {
      id: file.id,
      status: file.status,
      usageCount: file.links.length
    }
  });
}));

/**
 * @route PATCH /api/assets/:id/visibility
 * @desc Update file visibility
 * @access Private
 */
router.patch('/:id/visibility', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
  const user = req.user;
  if (!user?._id) {
    throw new UnauthorizedError('Authentication required');
  }

  const { id: fileId } = req.params;
  const { visibility } = req.body;

  // Validate visibility value
  if (!visibility || !['private', 'public', 'unlisted'].includes(visibility)) {
    throw new BadRequestError('Visibility must be one of: private, public, unlisted');
  }

  // Get file and verify ownership
  const file = await assetService.getFile(fileId);
  if (!file) {
    throw new NotFoundError('File not found');
  }

  // Compare as strings (handle ObjectId vs string comparison)
  if (file.ownerUserId !== user._id) {
    throw new ForbiddenError('Access denied');
  }

  // Only update if visibility is actually changing
  if (file.visibility === visibility) {
    // No change needed, return current file
    return sendSuccess(res, {
      file: {
        id: file.id,
        visibility: file.visibility,
        updatedAt: file.updatedAt
      }
    });
  }

  // Update visibility
  const updatedFile = await assetService.updateFileVisibility(fileId, visibility as FileVisibility);

  logger.info('File visibility updated', { 
    userId: user._id, 
    fileId,
    visibility
  });

  sendSuccess(res, {
    file: {
      id: updatedFile.id,
      visibility: updatedFile.visibility,
      updatedAt: updatedFile.updatedAt
    }
  });
}));

/**
 * @route DELETE /api/assets/:id
 * @desc Delete file with impact summary
 * @access Private
 */
router.delete('/:id', authMiddleware, asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
  const user = req.user;
  if (!user?._id) {
    throw new UnauthorizedError('Authentication required');
  }

  const { id: fileId } = req.params;
  const { force } = req.query;
  const forceDelete = force === 'true';

  // Get deletion summary first
  const summary = await assetService.getDeletionSummary(fileId);

  // If not forcing and there are active links, return summary
  if (!forceDelete && summary.remainingLinks > 0) {
    throw new ConflictError('File has active links', {
      summary,
      message: 'Use ?force=true to delete anyway'
    });
  }

  // Proceed with deletion
  await assetService.deleteFile(fileId, forceDelete, user._id);

  logger.info('File deleted', { 
    userId: user._id, 
    fileId,
    force: forceDelete,
    summary
  });

  sendSuccess(res, {
    summary,
    message: 'File deleted successfully'
  });
}));

/**
 * One `results` entry in the batch-access response. Access-granted entries carry
 * a caller-scoped, `<img src>`-ready `url` (scoped `mt` stream URL for private
 * assets, clean CDN URL for public) plus `visibility`/`mime`; denied or missing
 * entries carry only `allowed:false` + `error` and NO `url` — a private asset
 * must never be handed a public-CDN URL (a guaranteed 404).
 */
interface BatchAccessResult {
  allowed: boolean;
  url?: string;
  visibility?: FileVisibility;
  mime?: string;
  error?: string;
}

/**
 * @route POST /api/assets/batch-access
 * @desc Resolve access + a caller-scoped, variant-aware URL for many assets in
 *       ONE round trip. Body: `{ files: [{ fileId, variant? }], expiresIn?, context? }`.
 *       A file-manager grid resolves each tile's own rendition (thumb/poster)
 *       without one request per tile. One denied/missing file never fails the
 *       batch (still 200); denied/missing ids are returned with `allowed:false`.
 * @access Private
 */
router.post('/batch-access', authMiddleware, validate({ body: batchAccessSchema }), asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
  const user = req.user;
  const { files: requests, expiresIn, context: rawContext } = req.body as {
    files: Array<{ fileId: string; variant?: string }>;
    expiresIn?: number;
    context?: string;
  };

  const expiry = typeof expiresIn === 'number' ? expiresIn : 3600;
  const context = parseMediaAccessContext(rawContext);

  // One DB round trip for the whole batch, then map each request (with its own
  // variant) back to its file. Unknown ids resolve to a "not found" entry.
  const fetched = await assetService.getFilesByIds(requests.map((r) => r.fileId));
  const filesById = new Map(fetched.map((f) => [f.id, f]));

  const results: Record<string, BatchAccessResult> = {};

  await Promise.all(requests.map(async ({ fileId, variant }) => {
    const file = filesById.get(fileId);
    if (!file) {
      results[fileId] = { allowed: false, error: 'File not found' };
      return;
    }

    if (!(await assetService.canUserAccessFile(file, user?._id, context))) {
      results[fileId] = { allowed: false, error: 'Access denied' };
      return;
    }

    // Public + CDN-reachable → clean CDN URL for the requested variant.
    // Otherwise our own origin stream URL (never a raw S3 URL); a non-public
    // asset gets a SCOPED media token bound to THIS file id + the authenticated
    // caller, so a token minted for file A can never open file B.
    //
    // Resolving the CDN URL can trigger on-demand variant generation, which
    // downloads the original object from S3. A missing/misplaced S3 object
    // throws (NoSuchKey) — that must NOT reject the whole batch (the caller is
    // allowed to see this file). Fall back to the origin stream URL, whose
    // route serves the bytes or a placeholder rendition for a missing object.
    let cdnUrl: string | null = null;
    try {
      cdnUrl = await assetService.getFileUrl(fileId, variant, expiry, file);
    } catch (error) {
      logger.warn('batch-access: CDN resolution failed; falling back to origin stream URL', {
        fileId,
        variant,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const mediaToken = cdnUrl || file.visibility === 'public' || !user?._id
      ? undefined
      : signMediaToken(fileId, user._id);
    const url = cdnUrl ?? buildOriginStreamUrl(req, fileId, variant, mediaToken);
    results[fileId] = {
      allowed: true,
      url,
      visibility: file.visibility,
      mime: file.mime,
    };
  }));

  sendSuccess(res, { results });
}));

export default router;
