import { hasServiceAuthority } from '../utils/serviceAuthority';
import { createSupervisedAssetPolicy, isSupervised } from '../services/supervisionPolicy.service';
import express from 'express';
import recordingIngestRouter from './recordingIngest';
import { withoutServerSvgMetadata } from '../utils/svgSanitizer';
import multer from 'multer';
import { assetService } from '../services/assetServiceSingleton';
import { AssetService } from '../services/assetService';
import { s3Service } from '../services/s3ServiceSingleton';
import {
  authMiddleware,
  serviceAuthMiddleware,
  type AuthRequest,
  type ServiceAuthRequest,
} from '../middleware/auth';
import { optionalAuthMiddleware, getMediaViewerUserId } from '../middleware/optionalAuth';
import { resolveOperatorId } from '../middleware/operator';
import { requireStaff } from '../middleware/requireStaff';
import {
  abandonReconciliation,
  beginReconciliation,
  commitReconciliation,
  getReconciliation,
  putReconciliationItems,
  startReconciliationCommit,
} from '../services/fileReferenceReconciliation.service';
import { fileLifecycleMode, listFileLifecycleSweeps } from '../services/fileLifecycle.worker';
import { mediaHeadersMiddleware } from '../middleware/mediaHeaders';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { logger } from '../utils/logger';
import { asyncHandler, sendSuccess } from '../utils/asyncHandler';
import {
  ApiError,
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  ConflictError,
} from '../utils/error';
import { z } from 'zod';
import type {
  FileReferenceRecord,
  FileRecord,
  FileVariantRecord,
  FileVisibility,
} from '../types/file.types';
import type { MediaAccessContext } from '../types/mediaPrivacy.types';
import { validate } from '../middleware/validate';
import {
  assetIdParams,
  listAssetsQuerySchema,
  listLifecycleSweepsQuerySchema,
  beginReconcileBodySchema,
  commitReconcileBodySchema,
  reconcilePageBodySchema,
  reconcileSessionParams,
  assetUrlQuerySchema,
  updateVisibilitySchema,
  batchAccessSchema,
  assetsByIdsBodySchema,
  assetsLinkedUrlBodySchema,
  assetsBySha256BodySchema,
  linkFileSchema,
  unlinkFileSchema,
  federatedAssetDeleteBodySchema,
  type federatedAssetDeleteResult,
  type federatedAssetDeleteResponse,
  type federatedAssetBatchDeleteResponse,
  type federatedMediaUploadResponse,
  listApplicationFilesQuerySchema,
  serviceReferencesBodySchema,
  appImportBodySchema,
  appImportBatchBodySchema,
  MAX_IMPORT_BATCH_ITEMS,
  userMediaImportBodySchema,
  appLargeUploadBodySchema,
  userMediaLargeUploadBodySchema,
  ownLargeUploadBodySchema,
  largeUploadParams,
  largeUploadPartsBodySchema,
  appAdoptBodySchema,
  fileAccessParams,
  playSessionBodySchema,
  playSessionParams,
  revokePlaySessionsBodySchema,
  streamObjectParams,
  audioOptionsSchema,
  type AudioOptions,
  appRecordingTargetBodySchema,
  userMediaRecordingTargetBodySchema,
  recordingTargetParams,
  ingestImportParams,
} from '../schemas/assets.schemas';
import type { FileIngestRow } from '../db/schema/fileIngests';
import {
  RECORDING_BUCKET,
  RECORDING_REGION,
  type IngestOwner,
  type IngestView,
} from '../services/fileIngest.service';
import type { FilePlaySessionRow } from '../db/schema/filePlaySessions';
import type { LargeUploadOwner, LargeUploadView } from '../services/fileUploadSession.service';
import { fileUploadSessionService } from '../services/fileUploadSessionSingleton';
import { ContentBlockedError } from '../services/contentClaims/contentBlocklist';
import { contentDispositionFor, contentSecurityPolicyFor } from '../utils/fileContentPolicy';
import { isSanitizedSvgFile, isSvgType } from '../utils/svgSanitizer';
import {
  isPendingImport,
  normalizeSourceUrl,
  type ImportResult,
  type PendingImport,
} from '../services/fileImport.service';
import { fileImportService, fileIngestService } from '../services/fileIngestSingleton';
import {
  applicationReadConsent,
  mayApplicationRead,
  mayApplicationReference,
  resolveReferenceApplicationId,
} from '../services/fileReference.service';
import {
  applicationExists,
  grantUploadAccess,
  listApplicationAccess,
  restoreAccessByOwner,
  revokeApplicationAccess,
} from '../services/fileAccessGrant.service';
import {
  authorizeKeyRelease,
  loadApplicationPlaySession,
  normalizeRenditionAllowList,
  PLAY_SESSION_DEFAULT_TTL_SECONDS,
  openPlaySession,
  playSessionStatus,
  readyMasterPlaylist,
  renditionAllowList,
  resolveServingSession,
  revokePlaySession,
  revokePlaySessionsWhere,
} from '../services/playSession.service';
import {
  cachedPlaylistReader,
  encryptedLength,
  encryptedRenditionPlaylist,
  MASTER_PLAYLIST_NAME,
  PREVIEW_NAME,
  readyRenditions,
  renditionContentKey,
  renditionKeyName,
  resolveStreamObject,
  restrictedMasterPlaylist,
  segmentCipher,
  streamContentType,
  WAVEFORM_NAME,
} from '../services/hlsStreamServing';
import type { AccessTokenIdentity } from '../utils/sessionUtils';
import { generateMissingFilePlaceholder, TRANSPARENT_PNG_PLACEHOLDER } from '../utils/placeholders';
import {
  buildCdnUrl,
  stripPublicPrefix,
  isPublicKey,
  isServableStatus,
  CDN_REDIRECT_CACHE_CONTROL,
  IMMUTABLE_ASSET_CACHE_CONTROL,
} from '../config/cdn';
import { sendAssetRedirect } from '../utils/cdnRedirect';
import {
  MEDIA_TOKEN_QUERY_PARAM,
  MEDIA_TOKEN_TTL_SECONDS,
  signMediaToken,
} from '../utils/mediaToken';
import { ASSET_MULTIPART_FILE_MAX_BYTES, USE_PRESIGNED_UPLOAD } from '../constants/assetUpload';
import {
  FEDERATION_CACHE_MAX_BYTES,
  USER_MEDIA_MAX_BYTES,
  isAllowedCacheMime,
} from '../constants/federationCache';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { applications, users } from '../db/schema';
import { resolveFileMediaMetadata } from '../utils/fileMediaMetadata';
import { readyVariantRevision } from '../utils/assetRenditionRevision';
import { singleQueryValue } from '../utils/queryString';
import type { ApplicationScope } from '../utils/applicationScopes';

interface AuthenticatedRequest extends express.Request {
  user?: {
    _id: string;
    [key: string]: any;
  };
  /** Set by `authMiddleware`: the application the session is bound to, if any. */
  oxyToken?: AccessTokenIdentity;
}

const router = express.Router();
/**
 * One multipart `file`, in memory, at most {@link ASSET_MULTIPART_FILE_MAX_BYTES}.
 * Over it: 413 {@link USE_PRESIGNED_UPLOAD}, Oxy's own JSON answer, before the
 * proxy in front of the API would refuse the body with an HTML one. Multer's
 * other refusals (an unexpected field) are the caller's mistake: a 400.
 */
const multipartFile = multer({ limits: { fileSize: ASSET_MULTIPART_FILE_MAX_BYTES } }).single(
  'file',
);
const singleMultipartFile: express.RequestHandler = (req, res, next) => {
  multipartFile(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      next(
        err.code === 'LIMIT_FILE_SIZE'
          ? new ApiError(
              413,
              `A file over ${ASSET_MULTIPART_FILE_MAX_BYTES} bytes is uploaded by presigned PUT: POST /assets/init, PUT the bytes to its uploadUrl, then POST /assets/complete`,
              USE_PRESIGNED_UPLOAD,
              { maxBytes: ASSET_MULTIPART_FILE_MAX_BYTES },
            )
          : new BadRequestError(err.message),
      );
      return;
    }
    next(err);
  });
};
/** Reviewed own-file operations: authentication still proves the original bearer. */
const ownAssetAuth: express.RequestHandler = (req, res, next) => {
  res.locals.supervisedSelfOperation = true;
  return authMiddleware(req, res, next);
};

// A recording target's S3-compatible ingest (ADR 0043 stage 4c): mounted first,
// on its own raw body (`server.ts` skips the body parsers for it).
router.use('/recording-ingest', recordingIngestRouter);

/**
 * Project a link/variant row onto the wire shape clients already receive.
 *
 * Two differences would otherwise ship silently. The wire shape carries NO id
 * and no parent pointer — the `file_references.id` / `file_variants.id` / `file_id`
 * columns are internal, and must not leak. And the wire OMITS an unset optional
 * field, where a Postgres row spells it `null`; `JSON.stringify` drops
 * `undefined` but preserves `null`, so passing rows through verbatim would turn
 * "absent" into an explicit `null` for every consumer in the ecosystem.
 */
function serializeLink(link: FileReferenceRecord) {
  return {
    // `app` keeps its key for the clients that read it; since ADR 0043 D4 it
    // holds the using application's id, which `applicationId` also names.
    app: link.applicationId,
    applicationId: link.applicationId,
    entityType: link.entityType,
    entityId: link.entityId,
    // Absent for a reference an application made with its service token.
    ...(link.createdByUserId === null ? {} : { createdBy: link.createdByUserId }),
    createdAt: link.createdAt,
    // The per-reference `webhook_url` is no longer read or shown (ADR 0043 D9).
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
 * Whether any application uses the file, and since when none has (ADR 0043
 * D5). The owner's view: an account's file not in use is shown as such and
 * never removed for them; `trashedAt` is when it entered trash.
 */
function serializeLifecycle(file: FileRecord) {
  return {
    inUse: file.links.length > 0,
    unreferencedSince: file.links.length > 0 ? null : (file.unreferencedSince ?? null),
    trashedAt: file.trashedAt ?? null,
  };
}

/**
 * Whether the session may act on `file` as its OWNER: the file's account is
 * the session's subject, or the human operating that session (an operated
 * session speaks as a managed account, but its authority is the operator's —
 * `middleware/operator.ts`). A file no account owns (a system namespace, an
 * application) has no owner a session can be.
 *
 * The operator is read only when the subject does not match, so an ordinary
 * request costs no session lookup.
 */
async function sessionOwnsFile(req: AuthenticatedRequest, file: FileRecord): Promise<boolean> {
  if (!file.ownerUserId || !req.user?._id) return false;
  if (file.ownerUserId === req.user._id.toString()) return true;
  return file.ownerUserId === (await resolveOperatorId(req));
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
  mediaToken?: string,
): string {
  const host = req.get('host') ?? '';
  const url = new URL(
    `${req.protocol}://${host}${req.baseUrl}/${encodeURIComponent(fileId)}/stream`,
  );
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

/** The CSP of a download, and of anything sandboxed: nothing loads, nothing runs. */
const ATTACHMENT_CSP = "sandbox; default-src 'none'";

/** The placeholder SVG the stream route draws is served like any sanitized SVG. */
const SVG_PLACEHOLDER_CSP = contentSecurityPolicyFor('image/svg+xml') ?? ATTACHMENT_CSP;

// Auth applied per-route: authMiddleware for private routes,
// optionalAuthMiddleware for public stream/download endpoints.
// AssetService is a shared singleton (services/assetServiceSingleton.ts) so
// every consumer (assets routes, email controller, email service) shares the
// same in-memory fileCache.

// Validation schemas
const initUploadSchema = z.object({
  // Hex, and lowercased: it is the content's identity (dedupe, the presigned
  // PUT's enforced checksum, the takedown blocklist).
  sha256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'SHA256 must be 64 hexadecimal characters')
    .transform((value) => value.toLowerCase()),
  size: z.number().positive('Size must be positive'),
  mime: z.string().min(1, 'MIME type is required'),
});

const completeUploadSchema = z.object({
  fileId: z.string().min(1, 'File ID is required'),
  originalName: z.string().min(1, 'Original name is required'),
  size: z.number().positive('Size must be positive'),
  mime: z.string().min(1, 'MIME type is required'),
  visibility: z.enum(['private', 'public', 'unlisted']).optional(),
  metadata: z.record(z.any()).optional(),
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
 *       resized renditions), and any entity links. Each file says whether an
 *       application uses it (`inUse`) and, when none does, since when
 *       (`unreferencedSince`) — a file not in use is never removed for you
 *       (ADR 0043 D5). `inUse=false` lists only those. The list is your
 *       library — `active` files, and `blocked` ones removed after a legal
 *       claim — newest first; `status=trash` lists instead the files you moved
 *       to trash (`trashedAt`, most recently trashed first), which you can
 *       restore (`POST /assets/{id}/restore`) or delete for good.
 *     parameters:
 *       - name: status
 *         in: query
 *         required: false
 *         schema:
 *           type: string
 *           enum: ['trash']
 *       - name: inUse
 *         in: query
 *         required: false
 *         schema:
 *           type: string
 *           enum: ['true', 'false']
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
router.get(
  '/',
  ownAssetAuth,
  validate({ query: listAssetsQuerySchema }),
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
    const user = req.user;
    if (!user?._id) {
      throw new UnauthorizedError('Authentication required');
    }

    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const inUseQuery = singleQueryValue(req.query.inUse);
    const inUse = inUseQuery === undefined ? undefined : inUseQuery === 'true';
    const listing = singleQueryValue(req.query.status) === 'trash' ? 'trash' : 'library';

    const { files, total } = await assetService.listFilesByUser(user._id, limit, offset, {
      inUse,
      listing,
    });

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
        ...serializeLifecycle(file),
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        links: file.links.map(serializeLink),
        variants: file.variants.map(serializeVariant),
        metadata: file.metadata,
      })),
      total,
      hasMore: offset + files.length < total,
    });
  }),
);

/**
 * @route GET /api/assets/admin/lifecycle/sweeps
 * @desc The file lifecycle sweep's newest runs (ADR 0043 D5): per step
 *       (`purge`, `purgeBlocked`, `trash`, `staleUploads`,
 *       `unpublishTrashed`) how many files were DUE at the run's instant and
 *       how many were acted on, with up to 100 named per step; the
 *       `deletedApplications` step (D8 for an application deleted before D8
 *       shipped) counts and names applications, with the files and
 *       references each still has. In `report` mode nothing is acted on: this is what
 *       an operator reviews before switching the sweep to `enforce`. `limit`
 *       1–50, default 10.
 * @access Oxy platform staff
 */
router.get(
  '/admin/lifecycle/sweeps',
  authMiddleware,
  requireStaff,
  validate({ query: listLifecycleSweepsQuerySchema }),
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
    const rawLimit = singleQueryValue(req.query.limit);
    const limit = Math.min(Math.max(rawLimit ? Number.parseInt(rawLimit, 10) : 10, 1), 50);
    const sweeps = await listFileLifecycleSweeps(limit);
    sendSuccess(res, {
      mode: fileLifecycleMode(),
      sweeps: sweeps.map((sweep) => ({
        id: sweep.id,
        mode: sweep.mode,
        status: sweep.status,
        startedAt: sweep.startedAt,
        finishedAt: sweep.finishedAt,
        counts: sweep.counts,
        samples: sweep.samples,
        ...(sweep.error ? { error: sweep.error } : {}),
      })),
    });
  }),
);

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
 *       415:
 *         description: >
 *           `SVG_UPLOAD_REQUIRES_SANITIZATION` — an SVG is never uploaded by
 *           presigned PUT (Oxy must read it to sanitize it); use
 *           `POST /assets/upload`.
 *       401:
 *         description: Missing or invalid bearer token.
 */
router.post(
  '/init',
  ownAssetAuth,
  validate({ body: initUploadSchema }),
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
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
      validatedData.mime,
    );

    logger.info('Asset upload initialized', {
      userId: user._id,
      fileId: result.fileId,
      sha256: result.sha256,
    });

    sendSuccess(res, result);
  }),
);

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
 *                   description: >
 *                     The committed asset: `id`, `sha256`, `size`, `mime`,
 *                     `ext`, `originalName`, `visibility`, `metadata`,
 *                     `status`, `usageCount`, `createdAt`, `updatedAt`,
 *                     `links`, `variants` — every field `/assets/upload`
 *                     answers, and the record's lifecycle.
 *       400:
 *         description: Validation failed.
 *       401:
 *         description: Missing or invalid bearer token.
 */
router.post(
  '/complete',
  ownAssetAuth,
  validate({ body: completeUploadSchema }),
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
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

    if (
      validatedData.visibility &&
      validatedData.visibility !== 'private' &&
      (await isSupervised(user._id))
    ) {
      throw new ForbiddenError('Supervised accounts must keep uploaded files private');
    }
    const file = await assetService.completeUpload(validatedData, user._id);

    logger.info('Asset upload completed', {
      userId: user._id,
      fileId: file.id,
      originalName: validatedData.originalName,
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
        // As `POST /assets/upload` answers them, so a client's upload returns
        // one shape whichever path the bytes took.
        visibility: file.visibility,
        metadata: file.metadata,
        status: file.status,
        usageCount: file.links.length,
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        links: file.links.map(serializeLink),
        variants: file.variants.map(serializeVariant),
      },
    });
  }),
);

/**
 * @route POST /api/assets/:id/upload-direct
 * @desc Direct upload via API (bypasses browser CORS for presigned PUT)
 *       At most 90 MiB, like `/assets/upload`: 413 `USE_PRESIGNED_UPLOAD` over it.
 * @access Private
 */
router.post(
  '/:id/upload-direct',
  ownAssetAuth,
  validate({ params: assetIdParams }),
  singleMultipartFile,
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
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
    // A lost file stays lost (ADR 0043 D13): its owner deletes it, and the
    // same bytes uploaded again are a new file.
    if (file.status === 'lost') {
      throw new ApiError(409, 'This file was lost; upload it again as a new file', 'FILE_LOST');
    }
    // Only the row's owner writes its bytes. The key is content-addressed and
    // SHARED by every owner's row for the same content, so the bytes written
    // must also BE that content: anything else would replace what other owners
    // serve from this key.
    if (file.ownerUserId !== user._id) {
      throw new ForbiddenError('You do not own this file');
    }
    if (AssetService.calculateSHA256(req.file.buffer) !== file.sha256) {
      throw new BadRequestError('Uploaded bytes do not match the declared sha256');
    }

    // Upload buffer to the predetermined storageKey
    await s3Service.uploadBuffer(file.storageKey, req.file.buffer, {
      // The row's declared type, never the part's: the object is served as the
      // row says (an SVG row cannot exist on this path — `/init` refuses SVG).
      contentType: file.mime || 'application/octet-stream',
      cacheControl: IMMUTABLE_ASSET_CACHE_CONTROL,
    });

    sendSuccess(res, { fileId, key: file.storageKey });
  }),
);

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
 *       benefit of direct-to-S3 streaming. A file over 90 MiB is refused
 *       with 413 `USE_PRESIGNED_UPLOAD`: upload it with `/assets/init`, a PUT
 *       to the presigned URL and `/assets/complete` (the SDK's
 *       `assets.upload` does so itself above 64 MiB).
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
 *       413:
 *         description: >
 *           `USE_PRESIGNED_UPLOAD` — the file is over 90 MiB
 *           (`details.maxBytes`); upload it by presigned PUT
 *           (`/assets/init`, PUT, `/assets/complete`).
 */
router.post(
  '/upload',
  ownAssetAuth,
  singleMultipartFile,
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
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
    if (visibility !== 'private' && (await isSupervised(user._id))) {
      throw new ForbiddenError('Supervised accounts must keep uploaded files private');
    }
    let metadata: Record<string, unknown> | undefined;
    if (req.body.metadata) {
      try {
        metadata = JSON.parse(req.body.metadata);
      } catch {
        throw new BadRequestError('Invalid metadata JSON');
      }
    }

    // An SVG is stored only as its sanitized document (ADR 0043 stage 4c).
    const file = await assetService.uploadFileDirect(
      user._id,
      req.file.buffer,
      req.file.mimetype || 'application/octet-stream',
      req.file.originalname || req.file.fieldname || 'upload',
      visibility,
      metadata,
      { svg: 'sanitize' },
    );

    logger.info('File uploaded via direct endpoint', {
      userId: user._id,
      fileId: file.id,
      sha256: file.sha256,
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
        variants: file.variants.map(serializeVariant),
      },
    });
  }),
);

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

/** The narrow staff-granted scope for `POST /service/user-media`. */
const USER_MEDIA_WRITE_SCOPE: ApplicationScope = 'files:user-media:write';

function requireServiceScope(req: ServiceAuthRequest, scope: string): void {
  if (!hasServiceAuthority(req.serviceApp, scope)) {
    throw new ForbiddenError(`Missing required scope: ${scope}`);
  }
}

function getSingleHeader(req: express.Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Image, video or audio (ADR 0043 stage 4c added audio) of a type the media
 * pipeline admits — what the streamed service uploads and imports store.
 */
function isStorableMediaMime(mime: string): boolean {
  return (
    (mime.startsWith('image/') || mime.startsWith('video/') || mime.startsWith('audio/')) &&
    isAllowedCacheMime(mime)
  );
}

/** `x-audio-options` (JSON `{ normalizeLoudness?, previewStartSeconds? }`) of a streamed upload. */
function audioOptionsHeader(req: express.Request): AudioOptions | undefined {
  const raw = getSingleHeader(req, 'x-audio-options');
  if (raw === undefined || raw.trim() === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestError('x-audio-options must be a JSON object');
  }
  const result = audioOptionsSchema.safeParse(parsed);
  if (!result.success) {
    throw new BadRequestError(
      'x-audio-options must be { normalizeLoudness?: boolean, previewStartSeconds?: number }',
    );
  }
  return result.data;
}

/**
 * A caller's file metadata with the server-owned keys put right: the caller
 * cannot set `audioOptions` (how renditions are made) through free-form
 * metadata — only through the dedicated option (ADR 0043 stage 4c).
 */
function withAudioOptions(
  metadata: Record<string, unknown> | undefined,
  audio: AudioOptions | undefined,
): Record<string, unknown> | undefined {
  const { audioOptions: _ignored, ...rest } = metadata ?? {};
  const options = audio && Object.keys(audio).length > 0 ? audio : undefined;
  if (!options && !metadata) return undefined;
  return options ? { ...rest, audioOptions: options } : rest;
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
        FEDERATION_CACHE_MAX_BYTES,
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
        throw new ApiError(
          413,
          'Cached media exceeds the maximum allowed size',
          'PAYLOAD_TOO_LARGE',
        );
      }
      throw error;
    }
  }),
);

/**
 * @route POST /api/assets/service/federation
 * @desc Stream-upload durable federated media into a normal public file owned by
 *       the resolved federated Oxy user. Unlike `/service/cache`, files created
 *       here are not in the eviction namespace and can safely be referenced from
 *       persisted Mention posts.
 *
 *       Idempotent per (owner, application, bytes): re-uploading content that is
 *       already this federated owner's media from this application answers 200
 *       with the EXISTING id and `deduplicated: true` — the same id can then be
 *       referenced by several posts, so reference-check before deleting it.
 *       Content that already belongs to a different owner or was uploaded by a
 *       different application is a 409 `FEDERATED_MEDIA_OWNED_ELSEWHERE`: only one
 *       live row may hold a content hash, and it is never handed across owners.
 * @access Service token only (requires files:write)
 * @response 200 federatedMediaUploadResponse The stored asset; `deduplicated` is true when an existing row was reused.
 * @response 409 Error The bytes already belong to another owner or application.
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
      throw new ApiError(
        415,
        'Unsupported media type for federation upload',
        'UNSUPPORTED_MEDIA_TYPE',
      );
    }

    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > FEDERATION_CACHE_MAX_BYTES) {
      throw new ApiError(
        413,
        'Federated media exceeds the maximum allowed size',
        'PAYLOAD_TOO_LARGE',
      );
    }

    const originalNameHeader = getSingleHeader(req, 'x-original-name');
    const originalName =
      originalNameHeader && originalNameHeader.trim().length > 0
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

    const uploaderAppId = req.serviceApp?.appId;
    if (typeof uploaderAppId !== 'string' || uploaderAppId.length === 0) {
      throw new ForbiddenError('Service token carries no application id');
    }

    try {
      const { file, deduplicated } = await assetService.uploadFederatedMediaStream(
        req,
        mime,
        originalName,
        FEDERATION_CACHE_MAX_BYTES,
        ownerUserId,
        uploaderAppId,
        {
          ...(metadata || {}),
          serviceAppName: req.serviceApp?.appName,
        },
      );

      logger.info('Federation media persisted', {
        appId: uploaderAppId,
        appName: req.serviceApp?.appName,
        ownerUserId,
        fileId: file.id,
        deduplicated,
        mime,
        size: file.size,
      });

      const body: z.infer<typeof federatedMediaUploadResponse> = {
        data: {
          file: {
            id: file.id,
            sha256: file.sha256,
            size: file.size,
            mime: file.mime,
            visibility: file.visibility,
          },
          deduplicated,
        },
      };
      res.status(200).json(body);
    } catch (error) {
      if (error instanceof Error && error.name === 'CacheMediaTooLargeError') {
        throw new ApiError(
          413,
          'Federated media exceeds the maximum allowed size',
          'PAYLOAD_TOO_LARGE',
        );
      }
      throw error;
    }
  }),
);

/**
 * The account a `/service/user-media*` call writes into, after the act-as
 * authority check — shared by the upload and the import (ADR 0043 D7), so the
 * two can never disagree on who may attribute a file to a person.
 *
 * Own workloads use a verified requester session/task account; the explicit
 * owner must match it. A task may select only its root account or exact self bot
 * with live operator membership. External credentials retain files:user-media:write
 * or the legacy files:write + federation:write pair. An owner header alone is
 * never requester proof for an own workload.
 */
async function requireUserMediaOwner(req: ServiceAuthRequest): Promise<string> {
  if (!hasServiceAuthority(req.serviceApp, USER_MEDIA_WRITE_SCOPE)) {
    requireServiceScope(req, 'files:write');
    requireServiceScope(req, 'federation:write');
  }

  const ownerUserId = getSingleHeader(req, 'x-owner-user-id')?.trim();
  if (!ownerUserId) {
    throw new BadRequestError('x-owner-user-id must be a valid user id');
  }

  if (
    req.serviceApp?.authority === 'first_party' &&
    (req.serviceExternalMedia?.effectiveAccountId ?? req.serviceRequester?.subjectAccountId) !==
      ownerUserId
  ) {
    throw new ForbiddenError('User media requires the authenticated requester account.');
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
  return ownerUserId;
}

/**
 * @route POST /api/assets/service/user-media
 * @desc Stream-upload durable media into a file owned by an existing local Oxy
 *       user (`x-owner-user-id`), e.g. Mention MCP intent-media or a product
 *       storing what a person made in it. Raw bytes as the body; image, video
 *       or audio (SVG is sanitized first), at most 40 MiB. `x-visibility`
 *       (`public` default | `unlisted` | `private`): a private file is never
 *       under `public/` or on the CDN. The calling application may read the
 *       file back (`/service/linked-url`, play sessions) because it stored it
 *       for the person (ADR 0043 stage 4c) — until the person revokes that.
 *       `x-audio-options` (JSON `{ normalizeLoudness?, previewStartSeconds?
 *       }`) shapes an audio file's renditions. Rows are per owner: bytes the
 *       person already holds answer that file, its visibility unchanged.
 * @access Privileged service token only: files:user-media:write, or
 *         files:write together with federation:write
 */
router.post(
  '/service/user-media',
  serviceAuthMiddleware,
  cacheUploadLimiter,
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const ownerUserId = await requireUserMediaOwner(req);
    const appId = req.serviceApp?.appId;
    if (typeof appId !== 'string' || appId.length === 0) {
      throw new ForbiddenError('Service token carries no application id');
    }

    const visibilityHeader = getSingleHeader(req, 'x-visibility')?.trim();
    const parsedVisibility = updateVisibilitySchema.shape.visibility.safeParse(
      visibilityHeader && visibilityHeader.length > 0 ? visibilityHeader : 'public',
    );
    if (!parsedVisibility.success) {
      throw new BadRequestError('x-visibility must be one of: public, unlisted, private');
    }

    const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!mime) {
      throw new BadRequestError('Content-Type header is required');
    }
    if (!isStorableMediaMime(mime)) {
      throw new ApiError(415, 'Unsupported media type for user upload', 'UNSUPPORTED_MEDIA_TYPE');
    }
    const audio = audioOptionsHeader(req);

    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > USER_MEDIA_MAX_BYTES) {
      throw new ApiError(413, 'User media exceeds the maximum allowed size', 'PAYLOAD_TOO_LARGE');
    }

    const originalNameHeader = getSingleHeader(req, 'x-original-name');
    const originalName =
      originalNameHeader && originalNameHeader.trim().length > 0
        ? originalNameHeader.trim().slice(0, 255)
        : 'user-media';

    const metadataHeader = getSingleHeader(req, 'x-media-metadata');
    let metadata: Record<string, unknown> | undefined;
    if (metadataHeader) {
      try {
        const parsed: unknown = JSON.parse(metadataHeader);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        metadata = parsed as Record<string, unknown>;
      } catch {
        throw new BadRequestError('x-media-metadata must be valid JSON');
      }
    }

    try {
      const { file, deduplicated } = await assetService.uploadUserMediaStreamDetailed(
        req,
        mime,
        originalName,
        USER_MEDIA_MAX_BYTES,
        ownerUserId,
        parsedVisibility.data,
        {
          source: 'mention-service',
          ...(withAudioOptions(metadata, audio) ?? {}),
          serviceAppId: appId,
          serviceAppName: req.serviceApp?.appName,
        },
      );
      // The application stored this file for the person: it may read it back.
      await grantUploadAccess(file.id, appId);

      logger.info('User media persisted', {
        appId,
        appName: req.serviceApp?.appName,
        ownerUserId,
        fileId: file.id,
        mime,
        size: file.size,
        visibility: file.visibility,
        deduplicated,
      });

      sendSuccess(res, {
        file: {
          id: file.id,
          sha256: file.sha256,
          size: file.size,
          mime: file.mime,
          visibility: file.visibility,
        },
        deduplicated,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'CacheMediaTooLargeError' ||
          (error instanceof ApiError && error.code === 'STORAGE_STREAM_TOO_LARGE'))
      ) {
        throw new ApiError(413, 'User media exceeds the maximum allowed size', 'PAYLOAD_TOO_LARGE');
      }
      throw error;
    }
  }),
);

// ---------------------------------------------------------------------------
// Application-owned files (ADR 0043)
//
// Files an Oxy APPLICATION owns — platform artwork no person owns. The owner
// is ALWAYS the verified service token's `appId`: no header, body field or
// query parameter names it, so a token can only ever reach its own
// application's files. Another application's file answers exactly like no file
// (404), so an id is never an ownership oracle.
// ---------------------------------------------------------------------------

/** Per-app ceiling for application-file uploads: an S3 write, like the cache's. */
const appFileUploadLimiter = rateLimit({
  prefix: 'rl:asset-app:upload:',
  windowMs: CACHE_RATE_WINDOW_MS,
  max: CACHE_UPLOAD_MAX_PER_MINUTE,
  message: 'Too many application file uploads. Please slow down.',
  keyGenerator: (req: express.Request) => {
    const serviceApp = (req as ServiceAuthRequest).serviceApp;
    if (serviceApp?.appId) {
      return `asset-app:upload:${serviceApp.appId}`;
    }
    return `asset-app:upload:ip:${hashedIpKey(req)}`;
  },
});

/** Per-app ceiling for the cheaper application-file reads and writes. */
const appFileManageLimiter = rateLimit({
  prefix: 'rl:asset-app:manage:',
  windowMs: CACHE_RATE_WINDOW_MS,
  max: CACHE_DELETE_MAX_PER_MINUTE,
  message: 'Too many application file requests. Please slow down.',
  keyGenerator: (req: express.Request) => {
    const serviceApp = (req as ServiceAuthRequest).serviceApp;
    if (serviceApp?.appId) {
      return `asset-app:manage:${serviceApp.appId}`;
    }
    return `asset-app:manage:ip:${hashedIpKey(req)}`;
  },
});

/** Rows per `GET /service/app` page. */
const APP_FILE_LIST_DEFAULT_LIMIT = 50;
const APP_FILE_LIST_MAX_LIMIT = 100;

/**
 * The calling application, admitted to act on its own files or references: it
 * holds one of `scopes` AND, read live rather than from the hour-old token, it
 * is `active`. The scope alone is not enough — a suspended application keeps a
 * valid token until it expires.
 *
 * Any application type may hold these scopes (ADR 0043 D11): staff grant them
 * to Oxy's own applications, a third-party application grants them to itself
 * and its files count against its developer's plan (D3). The application is
 * always the verified token's `appId` — never a header, body or query field.
 */
async function requireActiveApplication(
  req: ServiceAuthRequest,
  scopes: readonly ApplicationScope[],
): Promise<string> {
  if (!scopes.some((scope) => hasServiceAuthority(req.serviceApp, scope))) {
    throw new ForbiddenError(`Missing required scope: ${scopes.join(' or ')}`);
  }
  const appId = req.serviceApp?.appId;
  if (typeof appId !== 'string' || appId.length === 0) {
    throw new ForbiddenError('Service token carries no application id');
  }
  const [application] = await getDb()
    .select({ status: applications.status })
    .from(applications)
    .where(eq(applications.id, appId))
    .limit(1);
  if (application?.status !== 'active') {
    throw new ForbiddenError('This application is not active');
  }
  return appId;
}

/** The wire shape of one application-owned file. */
function serializeApplicationFile(file: FileRecord) {
  return {
    id: file.id,
    sha256: file.sha256,
    size: file.size,
    mime: file.mime,
    ext: file.ext,
    ...(file.originalName === null ? {} : { originalName: file.originalName }),
    ownerApplicationId: file.ownerApplicationId,
    status: file.status,
    visibility: file.visibility,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
  };
}

/** `<created_at ISO>|<id>`, base64url — opaque to callers, total order with the id tiebreak. */
function encodeApplicationFileCursor(file: FileRecord): string {
  return Buffer.from(`${file.createdAt.toISOString()}|${file.id}`, 'utf8').toString('base64url');
}

function decodeApplicationFileCursor(cursor: string): { createdAt: Date; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  const createdAt = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (separator <= 0 || id.length === 0 || Number.isNaN(createdAt.getTime())) {
    throw new BadRequestError('Invalid cursor');
  }
  return { createdAt, id };
}

/**
 * @route POST /api/assets/service/app
 * @desc Stream-upload a file the CALLING APPLICATION owns (ADR 0043). Raw bytes
 *       as the body (not multipart); `Content-Type` must be an image, video or
 *       audio type (an SVG is stored as its sanitized document), at most 40
 *       MiB; `x-audio-options` (JSON `{ normalizeLoudness?,
 *       previewStartSeconds? }`) shapes an audio file's renditions. `x-visibility` (`public` | `unlisted` |
 *       `private`) is REQUIRED — an application's file has no default audience.
 *       Optional `x-original-name` and `x-media-metadata` (JSON) as on
 *       `/service/user-media`. Idempotent per (application, bytes): a re-upload
 *       answers 200 with the existing file, `deduplicated: true`, and its
 *       visibility unchanged. A third-party application's bytes count toward
 *       its developer account's storage plan, and over it the upload is refused
 *       with 413 `STORAGE_QUOTA_EXCEEDED` (existing files keep being served);
 *       Oxy's own applications are not metered (ADR 0043 D2/D3).
 * @access Service token only: `files:app:write`, on an active application
 */
router.post(
  '/service/app',
  serviceAuthMiddleware,
  appFileUploadLimiter,
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const appId = await requireActiveApplication(req, ['files:app:write']);

    const visibility = getSingleHeader(req, 'x-visibility')?.trim();
    const parsedVisibility = updateVisibilitySchema.shape.visibility.safeParse(visibility);
    if (!parsedVisibility.success) {
      throw new BadRequestError('x-visibility must be one of: public, unlisted, private');
    }

    const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!mime) {
      throw new BadRequestError('Content-Type header is required');
    }
    if (!isStorableMediaMime(mime)) {
      throw new ApiError(
        415,
        'Unsupported media type for an application file',
        'UNSUPPORTED_MEDIA_TYPE',
      );
    }
    const audio = audioOptionsHeader(req);

    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > USER_MEDIA_MAX_BYTES) {
      throw new ApiError(
        413,
        'Application file exceeds the maximum allowed size',
        'PAYLOAD_TOO_LARGE',
      );
    }

    const originalNameHeader = getSingleHeader(req, 'x-original-name');
    const originalName =
      originalNameHeader && originalNameHeader.trim().length > 0
        ? originalNameHeader.trim().slice(0, 255)
        : 'application-file';

    const metadataHeader = getSingleHeader(req, 'x-media-metadata');
    let metadata: Record<string, unknown> | undefined;
    if (metadataHeader) {
      try {
        const parsed: unknown = JSON.parse(metadataHeader);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        metadata = parsed as Record<string, unknown>;
      } catch {
        throw new BadRequestError('x-media-metadata must be a JSON object');
      }
    }

    try {
      const { file, deduplicated } = await assetService.uploadApplicationFileStream(
        req,
        mime,
        originalName,
        USER_MEDIA_MAX_BYTES,
        appId,
        parsedVisibility.data,
        withAudioOptions(metadata, audio),
      );

      logger.info('Application file persisted', {
        appId,
        appName: req.serviceApp?.appName,
        fileId: file.id,
        deduplicated,
        mime,
        size: file.size,
      });

      sendSuccess(res, { file: serializeApplicationFile(file), deduplicated });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'CacheMediaTooLargeError' ||
          (error instanceof ApiError && error.code === 'STORAGE_STREAM_TOO_LARGE'))
      ) {
        throw new ApiError(
          413,
          'Application file exceeds the maximum allowed size',
          'PAYLOAD_TOO_LARGE',
        );
      }
      // Only a third-party application is metered (ADR 0043 D3): say whose
      // plan is full, so its developer knows where to look.
      if (error instanceof ApiError && error.code === 'STORAGE_QUOTA_EXCEEDED') {
        throw new ApiError(
          413,
          "This application's files count toward its developer account's storage plan, which is full. Existing files are still served.",
          'STORAGE_QUOTA_EXCEEDED',
        );
      }
      throw error;
    }
  }),
);

/**
 * @route GET /api/assets/service/app
 * @desc One page of the calling application's own live files, newest first.
 *       `limit` (1–100, default 50) and the opaque `cursor` a previous page
 *       returned as `nextCursor` (absent on the last page).
 * @access Service token only: `files:app:write` or `files:app:delete`
 */
router.get(
  '/service/app',
  serviceAuthMiddleware,
  appFileManageLimiter,
  validate({ query: listApplicationFilesQuerySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const appId = await requireActiveApplication(req, ['files:app:write', 'files:app:delete']);
    const rawLimit = singleQueryValue(req.query.limit);
    const limit = Math.min(
      Math.max(rawLimit ? Number.parseInt(rawLimit, 10) : APP_FILE_LIST_DEFAULT_LIMIT, 1),
      APP_FILE_LIST_MAX_LIMIT,
    );
    const rawCursor = singleQueryValue(req.query.cursor);
    const after = rawCursor ? decodeApplicationFileCursor(rawCursor) : undefined;

    // One row past the page says whether another page exists.
    const rows = await assetService.listApplicationFiles(appId, limit + 1, after);
    const page = rows.slice(0, limit);
    const last = page.at(-1);

    sendSuccess(res, {
      files: page.map(serializeApplicationFile),
      ...(rows.length > limit && last ? { nextCursor: encodeApplicationFileCursor(last) } : {}),
    });
  }),
);

/**
 * @route PATCH /api/assets/service/app/:id/visibility
 * @desc Change the visibility of one of the calling application's own files.
 *       The objects are copied to the matching key spelling (`public/` or not)
 *       and the old spelling is owed a delete, exactly as for an account's
 *       file. 404 for any file that is not this application's live file.
 * @access Service token only: `files:app:write`
 */
router.patch(
  '/service/app/:id/visibility',
  serviceAuthMiddleware,
  appFileManageLimiter,
  validate({ params: assetIdParams, body: updateVisibilitySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const appId = await requireActiveApplication(req, ['files:app:write']);
    const { visibility } = req.body as z.infer<typeof updateVisibilitySchema>;

    const file = await assetService.setApplicationFileVisibility(req.params.id, appId, visibility);
    if (!file) {
      throw new NotFoundError('File not found');
    }

    logger.info('Application file visibility updated', {
      appId,
      fileId: file.id,
      visibility: file.visibility,
    });

    sendSuccess(res, { file: serializeApplicationFile(file) });
  }),
);

/**
 * @route DELETE /api/assets/service/app/:id
 * @desc Delete one of the calling application's own files: the row is
 *       tombstoned and its storage owed in the same transaction, then purged
 *       (`storage_object_deletions`, account `app:<appId>`). 404 for any file
 *       that is not this application's live file; 409 `FILE_IN_USE` when
 *       somebody else holds it (a link, a mail attachment, a listing
 *       screenshot), which is kept.
 * @access Service token only: `files:app:delete`
 */
router.delete(
  '/service/app/:id',
  serviceAuthMiddleware,
  appFileManageLimiter,
  validate({ params: assetIdParams }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const appId = await requireActiveApplication(req, ['files:app:delete']);
    const fileId = req.params.id;

    const result = await assetService.deleteApplicationFile(fileId, appId);
    logger.info('Audit: application file delete', {
      event: 'application_file_delete',
      appId,
      credentialId: req.serviceApp?.credentialId,
      fileId,
      result,
    });

    if (result === 'not_found') {
      throw new NotFoundError('File not found');
    }
    if (result === 'in_use') {
      throw new ApiError(409, 'File is still in use', 'FILE_IN_USE');
    }
    sendSuccess(res, { id: fileId, result });
  }),
);

/** Concurrent fetches one import batch runs at a time. */
const IMPORT_BATCH_CONCURRENCY = 4;

/** The source part of an import's answer: never the URL itself, which the caller sent. */
function serializeImportSource(result: ImportResult) {
  return {
    host: result.source.host,
    fetchedAt: result.source.fetchedAt,
    ...(result.source.etag === null ? {} : { etag: result.source.etag }),
    ...(result.source.lastModified === null ? {} : { lastModified: result.source.lastModified }),
  };
}

function serializeAppImport(result: ImportResult) {
  return {
    file: serializeApplicationFile(result.file),
    outcome: result.outcome,
    deduplicated: result.deduplicated,
    source: serializeImportSource(result),
    ...(result.reference ? { reference: { result: result.reference } } : {}),
  };
}

function serializeUserMediaImport(result: ImportResult) {
  return {
    file: {
      id: result.file.id,
      sha256: result.file.sha256,
      size: result.file.size,
      mime: result.file.mime,
      visibility: result.file.visibility,
      status: result.file.status,
    },
    outcome: result.outcome,
    deduplicated: result.deduplicated,
    source: serializeImportSource(result),
    ...(result.reference ? { reference: { result: result.reference } } : {}),
  };
}

/** A large import's first answer (`202`): it is being fetched in the background (ADR 0043 stage 4c). */
function serializePendingImport(pending: PendingImport) {
  return {
    importId: pending.ingest.id,
    status: 'importing' as const,
    source: { host: pending.ingest.sourceHost },
  };
}

/** A large import as it stands (`GET …/imports/:importId`). */
function serializeImportJob(view: IngestView, kind: IngestOwner['kind']) {
  const status =
    view.status === 'completed'
      ? 'completed'
      : view.status === 'verifying'
        ? 'verifying'
        : view.status === 'failed' || view.status === 'aborted'
          ? 'failed'
          : 'importing';
  return {
    importId: view.id,
    status,
    source: {
      host: view.sourceHost,
      ...(view.fetchedAt ? { fetchedAt: view.fetchedAt } : {}),
      ...(view.etag === null ? {} : { etag: view.etag }),
      ...(view.lastModified === null ? {} : { lastModified: view.lastModified }),
    },
    ...(view.file
      ? {
          file:
            kind === 'application'
              ? serializeApplicationFile(view.file)
              : serializeUserMediaFile(view.file),
          outcome: 'downloaded' as const,
          deduplicated: view.deduplicated ?? false,
          ...(view.reference ? { reference: { result: view.reference } } : {}),
        }
      : {}),
    ...(view.error
      ? { error: { status: view.error.status, code: view.error.code, message: view.error.message } }
      : {}),
  };
}

type AppImportItem = z.infer<typeof appImportBodySchema>;

/**
 * Admit an application import: `files:app:write` on an active application,
 * and `files:references:write` too when it asks for a reference — the same
 * rule as `POST /assets/service/references` (ADR 0043 D7).
 */
async function admitAppImport(req: ServiceAuthRequest, wantsReference: boolean): Promise<string> {
  const appId = await requireActiveApplication(req, ['files:app:write']);
  if (wantsReference) await requireActiveApplication(req, ['files:references:write']);
  return appId;
}

/**
 * @route POST /api/assets/service/app/import
 * @desc Import a file by URL; the CALLING APPLICATION owns it (ADR 0043 D7).
 *       Body `{ sourceUrl, visibility, reference?: { entityType, entityId },
 *       revalidate?, audio?: { normalizeLoudness?, previewStartSeconds? } }`.
 *       Oxy fetches `sourceUrl` itself — `https` only on every hop, public
 *       addresses only, at most 5 redirects, no credentials — and stores it
 *       through the ordinary upload pipeline (image, video or audio; SVG
 *       sanitized; deduplicated by content per application; variants). A
 *       source of at most 40 MiB is stored within 60 s in the request. A
 *       larger one (up to 8 GiB), or audio/video that declares no size,
 *       answers `202 { importId, status: 'importing', source: { host } }` and
 *       is fetched in the background (at most an hour, a minute without
 *       bytes) by multipart streaming, hashed, then stored the same way: poll
 *       `GET /assets/service/app/imports/{importId}`.
 *       The same URL imported again by the same application answers the
 *       existing file without any request (`outcome: 'existing'`);
 *       `revalidate: true` asks the source conditionally (ETag /
 *       Last-Modified): `not_modified`, or `downloaded` with the new bytes as
 *       a file of their own. `reference` registers this application's use of
 *       the file in the same request (needs `files:references:write`), so an
 *       import is never left unreferenced. Errors: 400 `INVALID_SOURCE_URL`,
 *       422 `SOURCE_URL_REFUSED`, 502 `SOURCE_FETCH_FAILED`, 504
 *       `SOURCE_FETCH_TIMEOUT`, 415 `UNSUPPORTED_MEDIA_TYPE`, 413
 *       `PAYLOAD_TOO_LARGE` / `STORAGE_QUOTA_EXCEEDED`.
 * @access Service token only: `files:app:write`, on an active application
 */
router.post(
  '/service/app/import',
  serviceAuthMiddleware,
  appFileUploadLimiter,
  validate({ body: appImportBodySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const body = req.body as AppImportItem;
    const appId = await admitAppImport(req, body.reference !== undefined);
    const result = await fileImportService.importFromUrl(
      { kind: 'application', applicationId: appId },
      body,
      appId,
    );
    if (isPendingImport(result)) {
      sendSuccess(res, serializePendingImport(result), 202);
      return;
    }
    sendSuccess(res, serializeAppImport(result));
  }),
);

/**
 * @route POST /api/assets/service/app/import/batch
 * @desc Up to 50 imports as above, `{ items: [...] }`, run 4 at a time;
 *       items naming the same source run one after another, so a repeat is
 *       answered from the first without fetching again. The batch is 200; each item answers on its own, in order: `{ index, ok:
 *       true, file, outcome, deduplicated, source, reference? }`, a large
 *       source still being fetched `{ index, ok: true, pending: true,
 *       importId, status: 'importing', source }`, or `{ index, ok: false,
 *       error: { status, code, message } }`.
 * @access Service token only: `files:app:write` (and `files:references:write`
 *         when an item asks for a reference), on an active application
 */
router.post(
  '/service/app/import/batch',
  serviceAuthMiddleware,
  appFileUploadLimiter,
  validate({ body: appImportBatchBodySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const { items: requested } = req.body as { items: unknown };
    // The schema already bounds the batch; restated here so the loop below is
    // bounded by a real array of at most MAX_IMPORT_BATCH_ITEMS, never by a
    // length the request body claims.
    if (!Array.isArray(requested) || requested.length > MAX_IMPORT_BATCH_ITEMS) {
      throw new BadRequestError(`items must be an array of at most ${MAX_IMPORT_BATCH_ITEMS}`);
    }
    const items: AppImportItem[] = requested;
    const appId = await admitAppImport(
      req,
      items.some((item) => item.reference !== undefined),
    );

    const results: Array<Record<string, unknown>> = new Array(items.length);
    // Items naming one source (normalized: a fragment is not a new source) run
    // one after another, never side by side. The later one then answers the
    // earlier one's file without fetching again, where in parallel both
    // fetched and raced to insert the same bytes. Each still answers on its
    // own, with its own visibility and reference.
    const bySource = new Map<string, Promise<ImportResult | PendingImport>>();
    const sourceKey = (item: AppImportItem): string | undefined => {
      try {
        return normalizeSourceUrl(item.sourceUrl).sha256;
      } catch {
        // Unordered: `importFromUrl` refuses the same URL with its own error.
        return undefined;
      }
    };
    let next = 0;
    const work = async () => {
      while (next < items.length) {
        const index = next++;
        const key = sourceKey(items[index]);
        const start = () =>
          fileImportService.importFromUrl(
            { kind: 'application', applicationId: appId },
            items[index],
            appId,
          );
        const earlier = key === undefined ? undefined : bySource.get(key);
        // After the earlier item settles either way; its own worker reports it.
        const run = earlier ? earlier.then(start, start) : start();
        if (key !== undefined) bySource.set(key, run);
        try {
          const result = await run;
          results[index] = isPendingImport(result)
            ? { index, ok: true, pending: true, ...serializePendingImport(result) }
            : { index, ok: true, ...serializeAppImport(result) };
        } catch (error) {
          if (!(error instanceof ApiError)) {
            logger.error('Application import batch item failed', {
              appId,
              index,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          results[index] = {
            index,
            ok: false,
            error:
              error instanceof ApiError
                ? { status: error.statusCode, code: error.code, message: error.message }
                : { status: 500, code: 'INTERNAL_ERROR', message: 'The import failed' },
          };
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(IMPORT_BATCH_CONCURRENCY, items.length) }, work),
    );

    logger.info('Application import batch', {
      appId,
      requested: items.length,
      failed: results.filter((item) => item.ok === false).length,
    });
    sendSuccess(res, { results });
  }),
);

/**
 * @route POST /api/assets/service/user-media/import
 * @desc Import a file by URL into an ACCOUNT's files (ADR 0043 D7): the
 *       account-owned equivalent of `/service/app/import`, with the authority
 *       and owner of `/service/user-media` — `x-owner-user-id` names an
 *       existing local user. Body `{ sourceUrl, visibility? (default public),
 *       reference?, revalidate?, audio? }`; the same fetch, policies,
 *       once-per-URL memory (per account) and answers, a large source
 *       included (`202`, poll `GET /assets/service/user-media/imports/{importId}`).
 *       `reference` registers the CALLING application's use of the file
 *       (needs `files:references:write`). The calling application may read the
 *       file back (ADR 0043 stage 4c) until the person revokes that.
 * @access Privileged service token only: files:user-media:write, or
 *         files:write together with federation:write
 */
router.post(
  '/service/user-media/import',
  serviceAuthMiddleware,
  cacheUploadLimiter,
  validate({ body: userMediaImportBodySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const ownerUserId = await requireUserMediaOwner(req);
    const body = req.body as z.infer<typeof userMediaImportBodySchema>;
    const appId = req.serviceApp?.appId;
    if (typeof appId !== 'string' || appId.length === 0) {
      throw new ForbiddenError('Service token carries no application id');
    }
    if (body.reference && req.serviceExternalMedia)
      throw new ForbiddenError(
        'External media creation does not authorize application references.',
      );
    if (body.reference) await requireActiveApplication(req, ['files:references:write']);

    const result = await fileImportService.importFromUrl(
      { kind: 'account', userId: ownerUserId },
      { ...body, visibility: body.visibility ?? 'public' },
      appId,
    );
    if (isPendingImport(result)) {
      logger.info('User media import continues in the background', {
        appId,
        ownerUserId,
        importId: result.ingest.id,
      });
      sendSuccess(res, serializePendingImport(result), 202);
      return;
    }
    logger.info('User media imported by URL', {
      appId,
      ownerUserId,
      fileId: result.file.id,
      outcome: result.outcome,
    });
    sendSuccess(res, serializeUserMediaImport(result));
  }),
);

// ---------------------------------------------------------------------------
// Large imports and recording targets (ADR 0043 stage 4c): bytes Oxy fetches
// or receives before their hash is known (`services/fileIngest.service.ts`).
// ---------------------------------------------------------------------------

/**
 * @route GET /api/assets/service/app/imports/:importId
 * @desc A large import of this application's (answered `202` by the import
 *       routes) as it stands: `{ importId, status: 'importing' | 'verifying' |
 *       'completed' | 'failed', source: { host, fetchedAt?, etag?,
 *       lastModified? }, file?, outcome?: 'downloaded', deduplicated?,
 *       reference?, error?: { status, code, message } }`. Kept a week after it
 *       finished. Another application's import is 404.
 * @access Service token only: `files:app:write`, on an active application
 */
router.get(
  '/service/app/imports/:importId',
  serviceAuthMiddleware,
  appFileManageLimiter,
  validate({ params: ingestImportParams }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const appId = await requireActiveApplication(req, ['files:app:write']);
    const row = await fileIngestService.load(
      req.params.importId,
      'import',
      { kind: 'application', applicationId: appId },
      appId,
    );
    sendSuccess(res, serializeImportJob(await fileIngestService.view(row), 'application'));
  }),
);

/**
 * @route GET /api/assets/service/user-media/imports/:importId
 * @desc As `GET /service/app/imports/:importId`, for a large import into an
 *       account's files (`x-owner-user-id`), by the application that started it.
 * @access Privileged service token only: files:user-media:write, or
 *         files:write together with federation:write
 */
router.get(
  '/service/user-media/imports/:importId',
  serviceAuthMiddleware,
  appFileManageLimiter,
  validate({ params: ingestImportParams }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const ownerUserId = await requireUserMediaOwner(req);
    const appId = req.serviceApp?.appId;
    if (typeof appId !== 'string' || appId.length === 0) {
      throw new ForbiddenError('Service token carries no application id');
    }
    const row = await fileIngestService.load(
      req.params.importId,
      'import',
      { kind: 'account', userId: ownerUserId },
      appId,
    );
    sendSuccess(res, serializeImportJob(await fileIngestService.view(row), 'account'));
  }),
);

type RecordingTargetBody = z.infer<typeof appRecordingTargetBodySchema>;

/** A recording target as its creator sees it; credentials only in `create`'s answer. */
function serializeRecordingTarget(view: IngestView, kind: IngestOwner['kind']) {
  return {
    targetId: view.id,
    status: view.status,
    expiresAt: view.expiresAt,
    ...(view.size === null ? {} : { size: view.size }),
    ...(view.file
      ? {
          file:
            kind === 'application'
              ? serializeApplicationFile(view.file)
              : serializeUserMediaFile(view.file),
          deduplicated: view.deduplicated ?? false,
          ...(view.reference ? { reference: { result: view.reference } } : {}),
        }
      : {}),
    ...(view.error ? { error: { code: view.error.code, message: view.error.message } } : {}),
  };
}

/** The S3 configuration a recording target hands out — LiveKit's `S3Upload`, and the generic one. */
function recordingCredentials(req: express.Request, row: FileIngestRow, secret: string) {
  const host = req.get('host') ?? '';
  const endpoint = `${req.protocol}://${host}${req.baseUrl}/recording-ingest`;
  const filepath = fileIngestService.recordingFilepath(row);
  return {
    filepath,
    s3: {
      accessKey: row.id,
      secret,
      region: RECORDING_REGION,
      endpoint,
      bucket: RECORDING_BUCKET,
      forcePathStyle: true,
    },
    livekit: {
      filepath,
      s3: {
        access_key: row.id,
        secret,
        region: RECORDING_REGION,
        endpoint,
        bucket: RECORDING_BUCKET,
        force_path_style: true,
      },
    },
  };
}

/** The creator's owner and application for a recording target route family. */
type RecordingAdmission = (
  req: ServiceAuthRequest,
  wantsReference: boolean,
) => Promise<{ owner: IngestOwner; creatorApplicationId: string }>;

const admitAppRecording: RecordingAdmission = async (req, wantsReference) => {
  const appId = await admitAppImport(req, wantsReference);
  return { owner: { kind: 'application', applicationId: appId }, creatorApplicationId: appId };
};

const admitUserMediaRecording: RecordingAdmission = async (req, wantsReference) => {
  const ownerUserId = await requireUserMediaOwner(req);
  const appId = req.serviceApp?.appId;
  if (typeof appId !== 'string' || appId.length === 0) {
    throw new ForbiddenError('Service token carries no application id');
  }
  if (wantsReference) await requireActiveApplication(req, ['files:references:write']);
  return { owner: { kind: 'account', userId: ownerUserId }, creatorApplicationId: appId };
};

/** The four recording-target handlers for one owner family (mounted below, each documented). */
function recordingTargetHandlers(
  kind: IngestOwner['kind'],
  admit: RecordingAdmission,
  defaultVisibility: FileVisibility | null,
) {
  const load = async (req: ServiceAuthRequest) => {
    const { owner, creatorApplicationId } = await admit(req, false);
    return fileIngestService.load(req.params.targetId, 'recording', owner, creatorApplicationId);
  };
  return {
    create: asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
      const body = req.body as RecordingTargetBody;
      const { owner, creatorApplicationId } = await admit(req, body.reference !== undefined);
      const visibility = body.visibility ?? defaultVisibility;
      if (!visibility) throw new BadRequestError('visibility is required');
      const { row, secret } = await fileIngestService.createRecordingTarget({
        owner,
        creatorApplicationId,
        visibility,
        ...(body.filename ? { filename: body.filename } : {}),
        // `metadata.svg` and `metadata.audioOptions` are the server's records, never the caller's.
        ...(withAudioOptions(withoutServerSvgMetadata(body.metadata), body.audio)
          ? { metadata: withAudioOptions(withoutServerSvgMetadata(body.metadata), body.audio) }
          : {}),
        ...(body.reference ? { reference: body.reference } : {}),
        ...(body.maxBytes ? { maxBytes: body.maxBytes } : {}),
        ...(body.expiresInSeconds ? { expiresInSeconds: body.expiresInSeconds } : {}),
      });
      res.setHeader('Cache-Control', 'no-store');
      sendSuccess(
        res,
        {
          ...serializeRecordingTarget(await fileIngestService.view(row), kind),
          ...recordingCredentials(req, row, secret),
        },
        201,
      );
    }),
    describe: asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
      const row = await load(req);
      sendSuccess(res, serializeRecordingTarget(await fileIngestService.view(row), kind));
    }),
    complete: asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
      const row = await load(req);
      const view = await fileIngestService.view(await fileIngestService.completeRecording(row));
      if ((view.status === 'failed' || view.status === 'aborted') && view.error) {
        throw new ApiError(view.error.status, view.error.message, view.error.code, {
          targetId: view.id,
        });
      }
      sendSuccess(
        res,
        serializeRecordingTarget(view, kind),
        view.status === 'verifying' ? 202 : 200,
      );
    }),
    abort: asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
      const row = await load(req);
      const view = await fileIngestService.view(await fileIngestService.abort(row));
      sendSuccess(res, serializeRecordingTarget(view, kind));
    }),
  };
}

const appRecordingTarget = recordingTargetHandlers('application', admitAppRecording, null);
const userMediaRecordingTarget = recordingTargetHandlers(
  'account',
  admitUserMediaRecording,
  'private',
);

/**
 * @route POST /api/assets/service/app/recording-targets
 * @desc A place a LiveKit egress (or any S3 client) records into, for a file
 *       the CALLING APPLICATION will own (ADR 0043 stage 4c). Body `{
 *       visibility, filename?, metadata?, reference?, maxBytes? (≤ 8 GiB,
 *       default 8 GiB), expiresInSeconds? (60–604800, default 86400), audio? }`
 *       → 201 `{ targetId, status: 'awaiting_upload', expiresAt, filepath, s3:
 *       { accessKey, secret, region, endpoint, bucket, forcePathStyle }, livekit:
 *       { filepath, s3: { access_key, secret, region, endpoint, bucket,
 *       force_path_style } } }` — `livekit` is exactly an `EncodedFileOutput`'s
 *       `filepath` and `s3`. The credentials are an S3-compatible endpoint of
 *       Oxy's own (`/assets/recording-ingest`, path-style, SigV4) that accepts
 *       ONE recording under `filepath` (the egress appends its extension;
 *       audio or video) plus small side objects such as its manifest, which
 *       are discarded; `PutObject` and the multipart calls the AWS SDK makes.
 *       The bytes never touch `public/`; once the object is complete Oxy
 *       hashes it and stores it as a file through the large-upload
 *       finalization (dedupe, blocklist, a third-party application's plan),
 *       with the `reference` asked for. The secret is shown only here.
 * @access Service token only: `files:app:write` (and `files:references:write`
 *         for `reference`), on an active application
 */
router.post(
  '/service/app/recording-targets',
  serviceAuthMiddleware,
  appFileUploadLimiter,
  validate({ body: appRecordingTargetBodySchema }),
  appRecordingTarget.create,
);

/**
 * @route GET /api/assets/service/app/recording-targets/:targetId
 * @desc A recording target as it stands: `status` (`awaiting_upload` |
 *       `receiving` | `verifying` | `completed` | `failed` | `aborted`),
 *       `size`, the `file` once completed, the `error` once failed. Another
 *       application's target is 404.
 * @access Service token only: `files:app:write`, on an active application
 */
router.get(
  '/service/app/recording-targets/:targetId',
  serviceAuthMiddleware,
  appFileManageLimiter,
  validate({ params: recordingTargetParams }),
  appRecordingTarget.describe,
);

/**
 * @route POST /api/assets/service/app/recording-targets/:targetId/complete
 * @desc Wait for the recording to be a file (Oxy finalizes it on its own once
 *       the object is complete; this is how the creator learns the outcome):
 *       200 `{ status: 'completed', file, deduplicated, reference? }`, 202 `{
 *       status: 'verifying' }` after 20 s (call again or poll the GET), 409
 *       `RECORDING_NOT_RECEIVED` before the object is complete, a failed
 *       target's own error (451 `CONTENT_BLOCKED`, 413
 *       `STORAGE_QUOTA_EXCEEDED` / `PAYLOAD_TOO_LARGE`, 410 `EXPIRED` /
 *       `ABORTED` / `OWNER_GONE`, 422 `EMPTY_RECORDING`). Idempotent.
 * @access Service token only: `files:app:write`, on an active application
 */
router.post(
  '/service/app/recording-targets/:targetId/complete',
  serviceAuthMiddleware,
  appFileUploadLimiter,
  validate({ params: recordingTargetParams }),
  appRecordingTarget.complete,
);

/**
 * @route DELETE /api/assets/service/app/recording-targets/:targetId
 * @desc Abort a recording target nothing was recorded into yet (or whose
 *       upload is in progress): its credentials stop working and what it
 *       received is deleted. 409 while it is being verified.
 * @access Service token only: `files:app:write`, on an active application
 */
router.delete(
  '/service/app/recording-targets/:targetId',
  serviceAuthMiddleware,
  appFileManageLimiter,
  validate({ params: recordingTargetParams }),
  appRecordingTarget.abort,
);

/**
 * @route POST /api/assets/service/user-media/recording-targets
 * @desc The account-owned twin of `POST /service/app/recording-targets`, with
 *       `/service/user-media`'s authority and owner (`x-owner-user-id` on
 *       EVERY call); `visibility` defaults to `private`. The recording becomes
 *       the person's file, which the creating application may read back
 *       until the person revokes that (ADR 0043 stage 4c).
 * @access Privileged service token only: files:user-media:write, or
 *         files:write together with federation:write
 */
router.post(
  '/service/user-media/recording-targets',
  serviceAuthMiddleware,
  cacheUploadLimiter,
  validate({ body: userMediaRecordingTargetBodySchema }),
  userMediaRecordingTarget.create,
);

/**
 * @route GET /api/assets/service/user-media/recording-targets/:targetId
 * @desc As `GET /service/app/recording-targets/:targetId`, for an account's target.
 * @access Privileged service token only: files:user-media:write, or
 *         files:write together with federation:write
 */
router.get(
  '/service/user-media/recording-targets/:targetId',
  serviceAuthMiddleware,
  appFileManageLimiter,
  validate({ params: recordingTargetParams }),
  userMediaRecordingTarget.describe,
);

/**
 * @route POST /api/assets/service/user-media/recording-targets/:targetId/complete
 * @desc As `POST /service/app/recording-targets/:targetId/complete`, for an account's target.
 * @access Privileged service token only: files:user-media:write, or
 *         files:write together with federation:write
 */
router.post(
  '/service/user-media/recording-targets/:targetId/complete',
  serviceAuthMiddleware,
  cacheUploadLimiter,
  validate({ params: recordingTargetParams }),
  userMediaRecordingTarget.complete,
);

/**
 * @route DELETE /api/assets/service/user-media/recording-targets/:targetId
 * @desc As `DELETE /service/app/recording-targets/:targetId`, for an account's target.
 * @access Privileged service token only: files:user-media:write, or
 *         files:write together with federation:write
 */
router.delete(
  '/service/user-media/recording-targets/:targetId',
  serviceAuthMiddleware,
  appFileManageLimiter,
  validate({ params: recordingTargetParams }),
  userMediaRecordingTarget.abort,
);

// ---------------------------------------------------------------------------
// Large uploads (ADR 0043 stage 4b): any type, up to 8 GiB, resumable. The
// client PUTs parts to S3 on presigned URLs; the API verifies the assembled
// bytes against the declared SHA-256 before they become a file
// (`services/fileUploadSession.service.ts`).
// ---------------------------------------------------------------------------

type LargeUploadBody = z.infer<typeof appLargeUploadBodySchema>;

function serializeUserMediaFile(file: FileRecord) {
  return {
    id: file.id,
    sha256: file.sha256,
    size: file.size,
    mime: file.mime,
    visibility: file.visibility,
    status: file.status,
  };
}

/** The wire view of an upload: `file` in the shape of the route family's other answers. */
function serializeLargeUpload(view: LargeUploadView, kind: LargeUploadOwner['kind']) {
  return {
    uploadId: view.uploadId,
    status: view.status,
    size: view.size,
    ...(view.partSize === undefined ? {} : { partSize: view.partSize, partCount: view.partCount }),
    ...(view.expiresAt && (view.status === 'uploading' || view.status === 'verifying')
      ? { expiresAt: view.expiresAt }
      : {}),
    ...(view.parts ? { parts: view.parts } : {}),
    ...(view.uploadedParts ? { uploadedParts: view.uploadedParts } : {}),
    ...(view.file
      ? {
          file:
            kind === 'application'
              ? serializeApplicationFile(view.file)
              : serializeUserMediaFile(view.file),
          deduplicated: view.deduplicated ?? false,
        }
      : {}),
    ...(view.reference ? { reference: { result: view.reference } } : {}),
    ...(view.error ? { error: { code: view.error.code, message: view.error.message } } : {}),
  };
}

/**
 * `complete`'s answer: 200 with the file, 202 while it is still being
 * verified, and a failed upload's own error (422 `CHECKSUM_MISMATCH` /
 * `SIZE_MISMATCH`, 451 `CONTENT_BLOCKED`, 413 `STORAGE_QUOTA_EXCEEDED`, 410
 * `EXPIRED` / `ABORTED` / `OWNER_GONE`).
 */
function sendLargeUploadOutcome(
  res: express.Response,
  view: LargeUploadView,
  kind: LargeUploadOwner['kind'],
): void {
  if ((view.status === 'failed' || view.status === 'aborted') && view.error) {
    throw new ApiError(view.error.status, view.error.message, view.error.code, {
      uploadId: view.uploadId,
    });
  }
  sendSuccess(res, serializeLargeUpload(view, kind), view.status === 'verifying' ? 202 : 200);
}

/** The calling application, admitted to its own large uploads (and their reference). */
async function admitAppLargeUpload(
  req: ServiceAuthRequest,
  wantsReference: boolean,
): Promise<{ owner: LargeUploadOwner; uploaderApplicationId: string }> {
  const appId = await admitAppImport(req, wantsReference);
  return { owner: { kind: 'application', applicationId: appId }, uploaderApplicationId: appId };
}

/** An account's large uploads: `/service/user-media`'s authority and owner, by the calling application. */
async function admitUserMediaLargeUpload(
  req: ServiceAuthRequest,
  wantsReference: boolean,
): Promise<{ owner: LargeUploadOwner; uploaderApplicationId: string }> {
  const ownerUserId = await requireUserMediaOwner(req);
  const appId = req.serviceApp?.appId;
  if (typeof appId !== 'string' || appId.length === 0) {
    throw new ForbiddenError('Service token carries no application id');
  }
  if (wantsReference) await requireActiveApplication(req, ['files:references:write']);
  return { owner: { kind: 'account', userId: ownerUserId }, uploaderApplicationId: appId };
}

/**
 * The five large-upload handlers for one owner family. Both families share
 * every rule; only who owns the file (and so who may continue the upload)
 * differs. Mounted below with literal paths, each documented.
 */
function largeUploadHandlers(
  kind: LargeUploadOwner['kind'],
  admit: (
    req: ServiceAuthRequest,
    wantsReference: boolean,
  ) => Promise<{ owner: LargeUploadOwner; uploaderApplicationId: string | null }>,
  defaultVisibility: FileVisibility = 'public',
) {
  const load = async (req: ServiceAuthRequest) => {
    const { owner, uploaderApplicationId } = await admit(req, false);
    return fileUploadSessionService.load(req.params.uploadId, owner, uploaderApplicationId);
  };
  return {
    open: asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
      const body = req.body as LargeUploadBody;
      const { owner, uploaderApplicationId } = await admit(req, body.reference !== undefined);
      const { audio, metadata, ...rest } = body;
      const withAudio = withAudioOptions(metadata, audio);
      const view = await fileUploadSessionService.open(owner, uploaderApplicationId, {
        ...rest,
        ...(withAudio ? { metadata: withAudio } : {}),
        visibility: body.visibility ?? defaultVisibility,
      });
      sendSuccess(res, serializeLargeUpload(view, kind), view.uploadId ? 201 : 200);
    }),
    describe: asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
      const row = await load(req);
      sendSuccess(res, serializeLargeUpload(await fileUploadSessionService.describe(row), kind));
    }),
    parts: asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
      const row = await load(req);
      const { partNumbers } = req.body as { partNumbers: number[] };
      const view = await fileUploadSessionService.requestPartUrls(row, partNumbers);
      sendSuccess(res, serializeLargeUpload(view, kind));
    }),
    complete: asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
      const row = await load(req);
      sendLargeUploadOutcome(res, await fileUploadSessionService.complete(row), kind);
    }),
    abort: asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
      const row = await load(req);
      sendSuccess(res, serializeLargeUpload(await fileUploadSessionService.abort(row), kind));
    }),
  };
}

const appLargeUpload = largeUploadHandlers('application', admitAppLargeUpload);
const userMediaLargeUpload = largeUploadHandlers('account', admitUserMediaLargeUpload);

/**
 * @route POST /api/assets/service/app/uploads
 * @desc Open (or resume) a large upload of a file the CALLING APPLICATION will
 *       own (ADR 0043 stage 4b). Body `{ sha256, size, mime, visibility,
 *       filename?, metadata?, reference? }`: any type but executables,
 *       installers and active documents (HTML, SVG, XML, scripts — 415), at
 *       most 8 GiB (413), never blocked bytes (451), within a third-party
 *       application's developer plan (413 `STORAGE_QUOTA_EXCEEDED`, D3).
 *       201 `{ uploadId, status: 'uploading', partSize, partCount, expiresAt,
 *       parts: [{ partNumber, url, size }] }` — the first 100 part URLs; PUT
 *       exactly `size` bytes to each. The same bytes already open answer that
 *       session, with the parts storage holds (`uploadedParts`) and URLs for
 *       the missing ones. Bytes the application already owns answer 200
 *       `{ uploadId: null, status: 'completed', file, deduplicated: true }`.
 *       An upload not completed within a day of its last part-URL request (a
 *       week at most) is aborted. Non-media types are stored and served with
 *       `Content-Disposition: attachment`.
 * @access Service token only: `files:app:write` (and `files:references:write`
 *         for `reference`), on an active application
 */
router.post(
  '/service/app/uploads',
  serviceAuthMiddleware,
  appFileUploadLimiter,
  validate({ body: appLargeUploadBodySchema }),
  appLargeUpload.open,
);

/**
 * @route GET /api/assets/service/app/uploads/:uploadId
 * @desc One of this application's large uploads as it stands: `status`
 *       (`uploading` | `verifying` | `completed` | `failed` | `aborted`), the
 *       parts storage holds while uploading (`uploadedParts`), the `file` once
 *       completed, the `error` once failed. Poll it after a 202 `complete`.
 *       Another application's upload is 404.
 * @access Service token only: `files:app:write`, on an active application
 */
router.get(
  '/service/app/uploads/:uploadId',
  serviceAuthMiddleware,
  appFileManageLimiter,
  validate({ params: largeUploadParams }),
  appLargeUpload.describe,
);

/**
 * @route POST /api/assets/service/app/uploads/:uploadId/parts
 * @desc Presigned part URLs: `{ partNumbers }` (1–100) → `{ parts: [{
 *       partNumber, url, size }] }`, valid an hour; also slides the upload's
 *       idle deadline. 409 once the upload is no longer `uploading`.
 * @access Service token only: `files:app:write`, on an active application
 */
router.post(
  '/service/app/uploads/:uploadId/parts',
  serviceAuthMiddleware,
  appFileManageLimiter,
  validate({ params: largeUploadParams, body: largeUploadPartsBodySchema }),
  appLargeUpload.parts,
);

/**
 * @route POST /api/assets/service/app/uploads/:uploadId/complete
 * @desc Assemble the parts, then VERIFY: Oxy hashes the assembled file and
 *       only bytes matching the declared `sha256` become a file. 200 `{
 *       status: 'completed', file, deduplicated, reference? }`; 202 `{ status:
 *       'verifying' }` when it takes longer (poll the GET); 409
 *       `UPLOAD_INCOMPLETE` naming missing or mis-sized parts (the upload stays
 *       open); a failed upload's own error — 422 `CHECKSUM_MISMATCH` /
 *       `SIZE_MISMATCH`, 451 `CONTENT_BLOCKED`, 413 `STORAGE_QUOTA_EXCEEDED`,
 *       410 `EXPIRED` / `ABORTED` / `OWNER_GONE`. Idempotent.
 * @access Service token only: `files:app:write`, on an active application
 */
router.post(
  '/service/app/uploads/:uploadId/complete',
  serviceAuthMiddleware,
  appFileUploadLimiter,
  validate({ params: largeUploadParams }),
  appLargeUpload.complete,
);

/**
 * @route DELETE /api/assets/service/app/uploads/:uploadId
 * @desc Abort an unfinished large upload: storage discards its parts and any
 *       reservation is released. 409 while it is being verified.
 * @access Service token only: `files:app:write`, on an active application
 */
router.delete(
  '/service/app/uploads/:uploadId',
  serviceAuthMiddleware,
  appFileManageLimiter,
  validate({ params: largeUploadParams }),
  appLargeUpload.abort,
);

/**
 * @route POST /api/assets/service/user-media/uploads
 * @desc The account-owned twin of `POST /service/app/uploads`, with
 *       `/service/user-media`'s authority and owner: `x-owner-user-id` names an
 *       existing local user, on EVERY call of the upload; `visibility`
 *       defaults to `public`. Only the application that opened an upload can
 *       continue it, for that owner.
 * @access Privileged service token only: files:user-media:write, or
 *         files:write together with federation:write
 */
router.post(
  '/service/user-media/uploads',
  serviceAuthMiddleware,
  cacheUploadLimiter,
  validate({ body: userMediaLargeUploadBodySchema }),
  userMediaLargeUpload.open,
);

/**
 * @route GET /api/assets/service/user-media/uploads/:uploadId
 * @desc As `GET /service/app/uploads/:uploadId`, for an account's upload.
 * @access Privileged service token only: files:user-media:write, or
 *         files:write together with federation:write
 */
router.get(
  '/service/user-media/uploads/:uploadId',
  serviceAuthMiddleware,
  appFileManageLimiter,
  validate({ params: largeUploadParams }),
  userMediaLargeUpload.describe,
);

/**
 * @route POST /api/assets/service/user-media/uploads/:uploadId/parts
 * @desc As `POST /service/app/uploads/:uploadId/parts`, for an account's upload.
 * @access Privileged service token only: files:user-media:write, or
 *         files:write together with federation:write
 */
router.post(
  '/service/user-media/uploads/:uploadId/parts',
  serviceAuthMiddleware,
  appFileManageLimiter,
  validate({ params: largeUploadParams, body: largeUploadPartsBodySchema }),
  userMediaLargeUpload.parts,
);

/**
 * @route POST /api/assets/service/user-media/uploads/:uploadId/complete
 * @desc As `POST /service/app/uploads/:uploadId/complete`, for an account's upload.
 * @access Privileged service token only: files:user-media:write, or
 *         files:write together with federation:write
 */
router.post(
  '/service/user-media/uploads/:uploadId/complete',
  serviceAuthMiddleware,
  cacheUploadLimiter,
  validate({ params: largeUploadParams }),
  userMediaLargeUpload.complete,
);

/**
 * @route DELETE /api/assets/service/user-media/uploads/:uploadId
 * @desc As `DELETE /service/app/uploads/:uploadId`, for an account's upload.
 * @access Privileged service token only: files:user-media:write, or
 *         files:write together with federation:write
 */
router.delete(
  '/service/user-media/uploads/:uploadId',
  serviceAuthMiddleware,
  appFileManageLimiter,
  validate({ params: largeUploadParams }),
  userMediaLargeUpload.abort,
);

// ---------------------------------------------------------------------------
// A person's own large uploads (ADR 0043 stage 4b, ADR 0047): the same resumable
// multipart sessions, opened by the signed-in person's own session. The client
// PUTs every part straight to storage; no byte passes through the API (or
// through any proxy's body limit). The SDK's `assets.uploadLarge`, and
// `assets.upload` for anything over one part, go this way.
// ---------------------------------------------------------------------------

/** Per-person ceiling on opening and completing uploads: each is a storage write. */
const ownLargeUploadLimiter = rateLimit({
  prefix: 'rl:asset-own:upload:',
  windowMs: CACHE_RATE_WINDOW_MS,
  max: CACHE_UPLOAD_MAX_PER_MINUTE,
  message: 'Too many uploads. Please slow down.',
  keyGenerator: (req: express.Request) =>
    `asset-own:upload:${(req as AuthRequest).user?.id ?? hashedIpKey(req)}`,
});

/** Per-person ceiling on part URLs, status reads and aborts. */
const ownLargeUploadManageLimiter = rateLimit({
  prefix: 'rl:asset-own:manage:',
  windowMs: CACHE_RATE_WINDOW_MS,
  max: CACHE_DELETE_MAX_PER_MINUTE,
  message: 'Too many upload requests. Please slow down.',
  keyGenerator: (req: express.Request) =>
    `asset-own:manage:${(req as AuthRequest).user?.id ?? hashedIpKey(req)}`,
});

/**
 * The signed-in person owns the file; the session's application (NULL on Oxy's
 * shared device session) is the uploader, so only the same session kind can
 * continue it, and a third-party application may read back what it uploaded
 * for them. Never a reference: a person's upload is not an application's use.
 */
async function admitOwnLargeUpload(
  req: ServiceAuthRequest,
): Promise<{ owner: LargeUploadOwner; uploaderApplicationId: string | null }> {
  const authed = req as unknown as AuthRequest;
  const userId = authed.user?.id;
  if (!userId) throw new UnauthorizedError('Authentication required');
  return {
    owner: { kind: 'account', userId },
    uploaderApplicationId: authed.oxyToken?.applicationId ?? null,
  };
}

const ownLargeUpload = largeUploadHandlers('account', admitOwnLargeUpload, 'private');

/**
 * @route POST /api/assets/uploads
 * @desc Open (or resume) a large upload of a file the SIGNED-IN PERSON will own.
 *       Body `{ sha256, size, mime, visibility?, filename?, metadata?, audio? }`
 *       (visibility defaults to `private`, as `/assets/complete`'s): any type
 *       but executables, installers and active documents (415), at most 8 GiB
 *       (413), never blocked bytes (451), within the person's storage plan (413
 *       `STORAGE_QUOTA_EXCEEDED`, reserved for the whole file). 201 `{ uploadId,
 *       status: 'uploading', partSize, partCount, expiresAt, parts }` (the first
 *       100 presigned part URLs; PUT exactly `size` bytes to each, straight to
 *       storage). The same bytes already open answer that session with the parts
 *       storage holds (`uploadedParts`) — the resume after a dropped connection.
 *       Bytes the person already owns answer 200 `{ uploadId: null, status:
 *       'completed', file, deduplicated: true }`. An upload not completed within
 *       a day of its last part-URL request (a week at most) is aborted, and the
 *       bucket's lifecycle discards any part left after ten days.
 * @access Signed-in person (own session)
 */
router.post(
  '/uploads',
  ownAssetAuth,
  ownLargeUploadLimiter,
  validate({ body: ownLargeUploadBodySchema }),
  ownLargeUpload.open,
);

/**
 * @route GET /api/assets/uploads/:uploadId
 * @desc One of the person's large uploads as it stands (as
 *       `GET /service/app/uploads/:uploadId`): poll it after a 202 `complete`.
 * @access Signed-in person (own session)
 */
router.get(
  '/uploads/:uploadId',
  ownAssetAuth,
  ownLargeUploadManageLimiter,
  validate({ params: largeUploadParams }),
  ownLargeUpload.describe,
);

/**
 * @route POST /api/assets/uploads/:uploadId/parts
 * @desc Presigned part URLs: `{ partNumbers }` (1–100) → `{ parts }`, valid an
 *       hour, also sliding the upload's idle deadline.
 * @access Signed-in person (own session)
 */
router.post(
  '/uploads/:uploadId/parts',
  ownAssetAuth,
  ownLargeUploadManageLimiter,
  validate({ params: largeUploadParams, body: largeUploadPartsBodySchema }),
  ownLargeUpload.parts,
);

/**
 * @route POST /api/assets/uploads/:uploadId/complete
 * @desc Assemble and verify (as `POST /service/app/uploads/:uploadId/complete`):
 *       200 with the file, 202 `verifying` (poll the GET), 409
 *       `UPLOAD_INCOMPLETE` naming missing parts, or the upload's own error.
 * @access Signed-in person (own session)
 */
router.post(
  '/uploads/:uploadId/complete',
  ownAssetAuth,
  ownLargeUploadLimiter,
  validate({ params: largeUploadParams }),
  ownLargeUpload.complete,
);

/**
 * @route DELETE /api/assets/uploads/:uploadId
 * @desc Abort an unfinished upload: storage discards its parts and any
 *       reservation is released.
 * @access Signed-in person (own session)
 */
router.delete(
  '/uploads/:uploadId',
  ownAssetAuth,
  ownLargeUploadManageLimiter,
  validate({ params: largeUploadParams }),
  ownLargeUpload.abort,
);

/** How widely each visibility shows a file: an adopted copy may not show it wider. */
const VISIBILITY_REACH: Record<FileVisibility, number> = { private: 0, unlisted: 1, public: 2 };

/**
 * @route POST /api/assets/service/app/adopt
 * @desc The CALLING APPLICATION takes ownership of a file it can read,
 *       without uploading it again (ADR 0043 stage 4b): `{ fileId,
 *       visibility, reference? }` → its own row of the same bytes (the stored
 *       object is shared; a server-side copy only when the spelling the
 *       visibility needs does not exist yet). Readable means what a reference
 *       may name: any owner's active `public` or `unlisted` file, an account's
 *       private file its owner attached to this application (ADR 0021), or the
 *       application's own file (answered as it is). The copy may not be MORE
 *       visible than the source (400 `VISIBILITY_WIDER_THAN_SOURCE`): a
 *       person's private file shared with the application stays private.
 *       Anything else is 404, like no file; blocked bytes are 451. The
 *       application's existing file of the same bytes answers
 *       `deduplicated: true`, visibility unchanged. Answer `{ file, outcome:
 *       'adopted' | 'existing', deduplicated, reference? }`. The adopted file
 *       is the application's: it outlives the source (whose owner may delete
 *       it), is collected when unused (D5) and counts toward a third-party
 *       application's plan (D3).
 * @access Service token only: `files:app:write` (and `files:references:write`
 *         for `reference`), on an active application
 */
router.post(
  '/service/app/adopt',
  serviceAuthMiddleware,
  appFileUploadLimiter,
  validate({ body: appAdoptBodySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const body = req.body as z.infer<typeof appAdoptBodySchema>;
    const appId = await admitAppImport(req, body.reference !== undefined);

    const source = await assetService.getFile(body.fileId);
    if (!source || source.status === 'deleted') throw new NotFoundError('File not found');
    // Taken-down bytes answer as such whoever holds them (ADR 0043 D10).
    if (
      source.status === 'blocked' &&
      mayApplicationReference({ ...source, status: 'active' }, appId)
    ) {
      throw new ContentBlockedError();
    }
    if (!mayApplicationReference(source, appId)) throw new NotFoundError('File not found');

    let result: { file: FileRecord; deduplicated: boolean };
    let outcome: 'adopted' | 'existing';
    if (source.ownerApplicationId === appId) {
      result = {
        file: await assetService.reuseOwnLiveFile(source, {
          ownerUserId: null,
          systemOwner: null,
          ownerApplicationId: appId,
        }),
        deduplicated: true,
      };
      outcome = 'existing';
    } else {
      if (VISIBILITY_REACH[body.visibility] > VISIBILITY_REACH[source.visibility]) {
        throw new ApiError(
          400,
          `The adopted file cannot be more visible than the source (${source.visibility})`,
          'VISIBILITY_WIDER_THAN_SOURCE',
        );
      }
      result = await assetService.adoptFileForApplication(source, appId, body.visibility);
      outcome = result.deduplicated ? 'existing' : 'adopted';
    }

    let reference: 'created' | 'exists' | 'not_found' | undefined;
    if (body.reference) {
      if (mayApplicationReference(result.file, appId)) {
        const { created } = await assetService.linkFile(result.file.id, {
          applicationId: appId,
          entityType: body.reference.entityType,
          entityId: body.reference.entityId,
          createdByUserId: null,
        });
        reference = created ? 'created' : 'exists';
        result.file = (await assetService.getFile(result.file.id)) ?? result.file;
      } else {
        reference = 'not_found';
      }
    }

    logger.info('Application file adopted', {
      appId,
      sourceFileId: source.id,
      fileId: result.file.id,
      outcome,
    });
    sendSuccess(res, {
      file: serializeApplicationFile(result.file),
      outcome,
      deduplicated: result.deduplicated,
      ...(reference ? { reference: { result: reference } } : {}),
    });
  }),
);

/** One item of a reference batch, as the body names it. */
type ServiceReferenceItem = { fileId: string; entityType: string; entityId: string };

/**
 * @route POST /api/assets/service/references
 * @desc The calling application records that it uses files (ADR 0043 D4):
 *       `{ references: [{ fileId, entityType, entityId }] }`, 1–100. The
 *       application is the token's `appId`; a body naming one is refused.
 *       Allowed: the application's OWN file (a trashed one comes back to
 *       `active`); any owner's `active` `public` or `unlisted` file; an
 *       account's `active` private file its owner attached to this
 *       application (ADR 0021). Never another application's private file.
 *       A reference never changes the file's visibility.
 *
 *       Per item: `created`, `exists` (already referenced, nothing changed) or
 *       `not_found` — a file that does not exist and one the application may
 *       not reference answer alike. The batch itself is 200.
 * @access Service token only: `files:references:write`, on an active application
 */
router.post(
  '/service/references',
  serviceAuthMiddleware,
  appFileManageLimiter,
  validate({ body: serviceReferencesBodySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const appId = await requireActiveApplication(req, ['files:references:write']);
    const { references } = req.body as { references: ServiceReferenceItem[] };

    const files = new Map(
      (await assetService.getFilesByIds([...new Set(references.map((item) => item.fileId))])).map(
        (file) => [file.id, file],
      ),
    );

    const results: Array<ServiceReferenceItem & { result: 'created' | 'exists' | 'not_found' }> =
      [];
    for (const item of references) {
      const file = files.get(item.fileId);
      if (!file || !mayApplicationReference(file, appId)) {
        results.push({ ...item, result: 'not_found' });
        continue;
      }
      const { file: updated, created } = await assetService.linkFile(item.fileId, {
        applicationId: appId,
        entityType: item.entityType,
        entityId: item.entityId,
        createdByUserId: null,
      });
      files.set(updated.id, updated);
      results.push({ ...item, result: created ? 'created' : 'exists' });
    }

    logger.info('Application references added', {
      appId,
      requested: references.length,
      created: results.filter((item) => item.result === 'created').length,
      refused: results.filter((item) => item.result === 'not_found').length,
    });

    sendSuccess(res, { results });
  }),
);

/**
 * @route DELETE /api/assets/service/references
 * @desc The calling application stops using files (ADR 0043 D4): the same
 *       body as POST. Removes only references THIS application holds — never
 *       another application's, never a person's from another application.
 *       Removing a reference never trashes, deletes or re-publishes the file.
 *
 *       Per item: `removed` or `not_found` (no such reference for this
 *       application). The batch itself is 200.
 * @access Service token only: `files:references:write`, on an active application
 */
router.delete(
  '/service/references',
  serviceAuthMiddleware,
  appFileManageLimiter,
  validate({ body: serviceReferencesBodySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const appId = await requireActiveApplication(req, ['files:references:write']);
    const { references } = req.body as { references: ServiceReferenceItem[] };

    const results: Array<ServiceReferenceItem & { result: 'removed' | 'not_found' }> = [];
    for (const item of references) {
      let removed = false;
      try {
        ({ removed } = await assetService.unlinkFile(item.fileId, {
          applicationId: appId,
          entityType: item.entityType,
          entityId: item.entityId,
        }));
      } catch (error) {
        if (!(error instanceof Error && error.message === 'File not found')) throw error;
      }
      results.push({ ...item, result: removed ? 'removed' : 'not_found' });
    }

    logger.info('Application references removed', {
      appId,
      requested: references.length,
      removed: results.filter((item) => item.result === 'removed').length,
    });

    sendSuccess(res, { results });
  }),
);

/**
 * Its own limiter: an inventory of a large entity type is hundreds of pages,
 * and must not starve the same application's per-write reference calls. It
 * counts the begin and the PAGES only; the session's control calls have their
 * own (below).
 */
const appReferenceReconcileLimiter = rateLimit({
  prefix: 'rl:asset-app:reconcile:',
  windowMs: CACHE_RATE_WINDOW_MS,
  max: CACHE_DELETE_MAX_PER_MINUTE,
  message: 'Too many reconciliation requests. Please slow down.',
  keyGenerator: (req: express.Request) => {
    const serviceApp = (req as ServiceAuthRequest).serviceApp;
    if (serviceApp?.appId) {
      return `asset-app:reconcile:${serviceApp.appId}`;
    }
    return `asset-app:reconcile:ip:${hashedIpKey(req)}`;
  },
});

/**
 * The commit, the status read and the release of a session, on a budget of
 * their own. A client that has spent the page budget must still be able to
 * finish or let go of its session: when the release shared it, the refusal
 * that ended an inventory refused its release too, and the session stayed
 * open, blocking its entity type until it expired.
 */
const appReferenceReconcileControlLimiter = rateLimit({
  prefix: 'rl:asset-app:reconcile-control:',
  windowMs: CACHE_RATE_WINDOW_MS,
  max: CACHE_DELETE_MAX_PER_MINUTE,
  message: 'Too many reconciliation requests. Please slow down.',
  keyGenerator: (req: express.Request) => {
    const serviceApp = (req as ServiceAuthRequest).serviceApp;
    if (serviceApp?.appId) {
      return `asset-app:reconcile-control:${serviceApp.appId}`;
    }
    return `asset-app:reconcile-control:ip:${hashedIpKey(req)}`;
  },
});

/**
 * @route POST /api/assets/service/references/reconcile
 * @desc Begin reconciling the calling application's references of ONE entity
 *       type (ADR 0043 D6): `{ entityType }` → `{ sessionId, entityType,
 *       expiresAt }`. Then send the full inventory with `PUT
 *       …/reconcile/:sessionId` and apply it with `POST …/commit`. One session
 *       per (application, entity type) at a time: 409
 *       `RECONCILIATION_IN_PROGRESS` while another is open. A session expires
 *       an hour after its last page.
 * @access Service token only: `files:references:write`, on an active application
 */
router.post(
  '/service/references/reconcile',
  serviceAuthMiddleware,
  appReferenceReconcileLimiter,
  validate({ body: beginReconcileBodySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const appId = await requireActiveApplication(req, ['files:references:write']);
    const { entityType } = req.body as z.infer<typeof beginReconcileBodySchema>;
    const session = await beginReconciliation(appId, entityType);
    logger.info('Reference reconciliation begun', { appId, entityType, sessionId: session.id });
    sendSuccess(res, {
      sessionId: session.id,
      entityType: session.entityType,
      expiresAt: session.expiresAt,
    });
  }),
);

/**
 * @route PUT /api/assets/service/references/reconcile/:sessionId
 * @desc One page of the inventory: `{ items: [{ fileId, entityId }] }`, 1–1000
 *       pairs. A pair sent twice counts once. Answers `{ accepted, total,
 *       expiresAt }`; each page moves the deadline an hour ahead. 404 for no
 *       such session of this application, 410 `RECONCILIATION_EXPIRED`, 409
 *       `RECONCILIATION_NOT_OPEN` once committed, 413 past 5,000,000 pairs.
 * @access Service token only: `files:references:write`, on an active application
 */
router.put(
  '/service/references/reconcile/:sessionId',
  serviceAuthMiddleware,
  appReferenceReconcileLimiter,
  validate({ params: reconcileSessionParams, body: reconcilePageBodySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const appId = await requireActiveApplication(req, ['files:references:write']);
    const { items } = req.body as z.infer<typeof reconcilePageBodySchema>;
    const result = await putReconciliationItems(appId, req.params.sessionId, items);
    sendSuccess(res, { sessionId: req.params.sessionId, ...result });
  }),
);

/**
 * @route POST /api/assets/service/references/reconcile/:sessionId/commit
 * @desc Diff the inventory against this application's references of the
 *       session's entity type and apply it: add each missing reference the
 *       application may hold (the rules of `POST /assets/service/references`;
 *       a file it may not reference, or none, is `refused`), remove each
 *       reference created before the session began that the inventory does
 *       not list — which never trashes or deletes a file — and count the rest
 *       `unchanged`. `{ dryRun: true }` counts the same, changes nothing and
 *       releases the session (the real run is a new one). Answers `{ sessionId, entityType, dryRun,
 *       added, removed, unchanged, refused }`.
 *
 *       A large inventory can take longer than a request may: with
 *       `{ background: true }` the commit answers 202 `{ sessionId,
 *       entityType, dryRun, status: 'committing' }` when it is still running
 *       after a few seconds, goes on under a lease (resumed by another task if
 *       this one dies), and `GET …/reconcile/:sessionId` reads the outcome.
 *       Without it, the request waits for the commit however long it takes.
 * @access Service token only: `files:references:write`, on an active application
 */
router.post(
  '/service/references/reconcile/:sessionId/commit',
  serviceAuthMiddleware,
  appReferenceReconcileControlLimiter,
  validate({ params: reconcileSessionParams, body: commitReconcileBodySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const appId = await requireActiveApplication(req, ['files:references:write']);
    const { dryRun, background } = req.body as z.infer<typeof commitReconcileBodySchema>;
    if (!background) {
      sendSuccess(res, await commitReconciliation(appId, req.params.sessionId, { dryRun }));
      return;
    }
    const started = await startReconciliationCommit(appId, req.params.sessionId, { dryRun });
    if (!started.pending) {
      sendSuccess(res, started.result);
      return;
    }
    const { sessionId, entityType } = started;
    sendSuccess(res, { sessionId, entityType, dryRun: started.dryRun, status: 'committing' }, 202);
  }),
);

/**
 * @route GET /api/assets/service/references/reconcile/:sessionId
 * @desc Read a session back: `{ sessionId, entityType, status, itemCount,
 *       expiresAt, dryRun, result, error }`. While a `background` commit runs
 *       `status` is `committing` (`dryRun` says which kind); once it is done, a
 *       real commit is `committed` and a dry run `abandoned` (released), each
 *       with `result`
 *       (the commit's counts); a failed commit is `open` with `error`, and can
 *       be committed again. 404 for no such session of this application.
 * @access Service token only: `files:references:write`, on an active application
 */
router.get(
  '/service/references/reconcile/:sessionId',
  serviceAuthMiddleware,
  appReferenceReconcileControlLimiter,
  validate({ params: reconcileSessionParams }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const appId = await requireActiveApplication(req, ['files:references:write']);
    sendSuccess(res, await getReconciliation(appId, req.params.sessionId));
  }),
);

/**
 * @route DELETE /api/assets/service/references/reconcile/:sessionId
 * @desc Release an open session without committing it, so the next `begin`
 *       for its entity type need not wait for it to expire. 404 when this
 *       application holds no such open session.
 * @access Service token only: `files:references:write`, on an active application
 */
router.delete(
  '/service/references/reconcile/:sessionId',
  serviceAuthMiddleware,
  appReferenceReconcileControlLimiter,
  validate({ params: reconcileSessionParams }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const appId = await requireActiveApplication(req, ['files:references:write']);
    if (!(await abandonReconciliation(appId, req.params.sessionId))) {
      throw new NotFoundError('Reconciliation session not found');
    }
    sendSuccess(res, { sessionId: req.params.sessionId, status: 'abandoned' });
  }),
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
  }),
);

/**
 * Per-app limiter for federated media deletes (single and batch share it). Its
 * own prefix, so it neither double-counts with nor borrows from the cache
 * eviction budget. A batch is ONE request here but up to
 * {@link MAX_FEDERATED_ASSET_DELETE_IDS} deletes, which the schema bounds.
 */
const federationDeleteLimiter = rateLimit({
  prefix: 'rl:asset-federation:delete:',
  windowMs: CACHE_RATE_WINDOW_MS,
  max: CACHE_DELETE_MAX_PER_MINUTE,
  message: 'Too many federated media deletions. Please slow down.',
  keyGenerator: (req: express.Request) => {
    const serviceApp = (req as ServiceAuthRequest).serviceApp;
    if (serviceApp?.appId) {
      return `asset-federation:delete:${serviceApp.appId}`;
    }
    return `asset-federation:delete:ip:${hashedIpKey(req)}`;
  },
});

/**
 * Both scopes, like `/service/user-media`'s original pair: `files:write` is the
 * scope the matching upload (`POST /service/federation`) requires, and
 * `federation:write` — privileged, staff-granted — is what makes acting on a
 * federated account's content a platform decision rather than a self-grant.
 * The row-level bound (only media THIS app uploaded, owned by a federated
 * account) is enforced in the delete itself; the scopes gate who may ask.
 */
function requireFederatedDeleteScopes(req: ServiceAuthRequest): string {
  requireServiceScope(req, 'files:write');
  requireServiceScope(req, 'federation:write');
  const appId = req.serviceApp?.appId;
  if (typeof appId !== 'string' || appId.length === 0) {
    throw new ForbiddenError('Service token carries no application id');
  }
  return appId;
}

/** One audit line per id — the record of who removed which federated object. */
function auditFederatedDelete(
  req: ServiceAuthRequest,
  fileId: string,
  result: z.infer<typeof federatedAssetDeleteResult>,
): void {
  const fields = {
    event: 'federated_media_delete',
    appId: req.serviceApp?.appId,
    appName: req.serviceApp?.appName,
    credentialId: req.serviceApp?.credentialId,
    fileId,
    result,
  };
  if (result === 'forbidden') {
    logger.warn('Audit: federated media delete refused', fields);
  } else {
    logger.info('Audit: federated media delete', fields);
  }
}

/**
 * @route DELETE /api/assets/service/federation/:id
 * @desc Delete durable federated media (created by `POST /service/federation`)
 *       when its federated source is gone. Only a live asset owned by a
 *       federated account AND uploaded by the calling application qualifies;
 *       anything else is a 403 and is left untouched. The row is tombstoned and
 *       its storage (original, variants, HLS segments) recorded as owed in the
 *       same transaction, then purged in the background — durably, guarded
 *       against a concurrent re-upload of the same bytes, with a CDN
 *       invalidation. Idempotent: an unknown or already-deleted id answers 200
 *       with `result: "not_found"`. An asset another account holds (content-
 *       addressed dedup shares one row per hash) answers 200 `in_use` and is
 *       kept.
 * @access Service token only (requires files:write and federation:write)
 * @response 200 federatedAssetDeleteResponse `deleted`, `not_found` (nothing to delete) or `in_use` (kept: another account holds it).
 * @response 403 Error Missing scope, or the asset is not this application's federated media.
 */
router.delete(
  '/service/federation/:id',
  serviceAuthMiddleware,
  federationDeleteLimiter,
  validate({ params: assetIdParams }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const appId = requireFederatedDeleteScopes(req);
    const { id: fileId } = req.params;

    const result = await assetService.deleteFederatedMediaForApp(fileId, appId);
    auditFederatedDelete(req, fileId, result);

    if (result === 'forbidden') {
      throw new ForbiddenError('Asset is not federated media uploaded by this application');
    }

    const body: z.infer<typeof federatedAssetDeleteResponse> = { data: { id: fileId, result } };
    res.status(200).json(body);
  }),
);

/**
 * @route POST /api/assets/service/federation/delete
 * @desc Batch form of `DELETE /service/federation/:id` for up to 20 ids (e.g.
 *       every media object and poster of one deleted federated post). Always
 *       200; each distinct id gets its own `deleted` / `not_found` / `in_use` /
 *       `forbidden` result, so one out-of-scope id never blocks the rest.
 * @access Service token only (requires files:write and federation:write)
 * @response 200 federatedAssetBatchDeleteResponse One result per distinct id, in request order.
 * @response 403 Error Missing scope.
 */
router.post(
  '/service/federation/delete',
  serviceAuthMiddleware,
  federationDeleteLimiter,
  validate({ body: federatedAssetDeleteBodySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const appId = requireFederatedDeleteScopes(req);
    const { ids } = req.body as z.infer<typeof federatedAssetDeleteBodySchema>;

    // Sequential on purpose: each id is one short transaction (tombstone +
    // ledger rows); the S3 purge drains in the background, so the request never
    // waits on it. A database failure propagates as a 5xx; ids already
    // processed stay processed, and retrying the whole batch is safe because
    // every step is idempotent.
    const results: Array<{ id: string; result: z.infer<typeof federatedAssetDeleteResult> }> = [];
    for (const fileId of [...new Set(ids)]) {
      const result = await assetService.deleteFederatedMediaForApp(fileId, appId);
      auditFederatedDelete(req, fileId, result);
      results.push({ id: fileId, result });
    }

    const body: z.infer<typeof federatedAssetBatchDeleteResponse> = { data: { results } };
    res.status(200).json(body);
  }),
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
 *                       hlsReadyAt:
 *                         type: string
 *                         format: date-time
 *                         description: >
 *                           When the adaptive HLS ladder for this asset finished
 *                           transcoding. ABSENT when there is none — transcoding
 *                           is asynchronous and per-rendition failures are
 *                           swallowed, so a video may never get one. Consumers
 *                           must treat absence as "no adaptive stream" and play
 *                           the progressive original: the `?variant=hls_master`
 *                           URL is derivable from the id, and building it without
 *                           this field is what made players fail on a 403 and
 *                           fall back, once per video per play.
 *                       ownerUserId:
 *                         type: [string, "null"]
 *                         description: >
 *                           The owning Oxy user (null for a system- or
 *                           application-owned file).
 *                           Present ONLY for Oxy's own applications (internal-tier
 *                           service tokens), so a first-party service can check an
 *                           attached asset belongs to the acting user.
 *                       ownerApplicationId:
 *                         type: string
 *                         description: >
 *                           The owning application, for an application-owned
 *                           file only (ADR 0043). Revealed on the same terms as
 *                           `ownerUserId`.
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
    //
    // `hlsReadyAt` is NOT the variant list arriving through the back door. The
    // list is storage detail — keys, formats, renditions — and stays private.
    // This is one bit of PLAYABILITY, and withholding it forced every consumer
    // into the same broken guess: the adaptive URL is derivable from the id
    // (`?variant=hls_master`), so callers built it unconditionally and shipped it
    // to players, because nothing here would tell them whether the ladder
    // existed. Upload-time transcoding is asynchronous and per-rendition
    // failures are swallowed, so for many videos it does not — and the player
    // discovered that by failing: a 403 on the manifest, a playback error, and a
    // fallback to the progressive original, once per video per play. Measured in
    // Mention on a Pixel 10 Pro. A consumer that can ask stops guessing.
    // `ownerUserId` is the one exception to "no owner ids", and it is granted
    // only to verified first-party workload authority. Branding an external
    // credential as internal never reveals ownership. A first-party service that is handed an asset id by a user
    // (Mention ingesting a post from Oxy Move) must be able to check the asset is
    // that user's, or any caller could attach anyone's file. `files:read` is
    // self-grantable, so for an external app the owner stays hidden: it would
    // turn every guessable file id into an "whose is this?" oracle.
    const revealOwner = req.serviceApp?.authority === 'first_party';
    const data = files
      .filter((file) => file.status !== 'deleted')
      .map((file) => {
        const media = resolveFileMediaMetadata(file);
        // The same readiness test the service itself uses before serving a
        // variant (`assetService`/`variantService`): a row exists AND it has
        // been stamped ready. A row without `readyAt` is a transcode that was
        // started, not one that finished.
        const hlsReadyAt = readyVariantRevision(file, 'hls_master');
        return {
          id: file.id,
          sha256: file.sha256,
          mime: file.mime,
          size: file.size,
          status: file.status,
          ...(hlsReadyAt ? { hlsReadyAt } : {}),
          ...(media.width !== undefined ? { width: media.width } : {}),
          ...(media.height !== undefined ? { height: media.height } : {}),
          ...(media.durationSec !== undefined ? { durationSec: media.durationSec } : {}),
          ...(media.orientation !== undefined ? { orientation: media.orientation } : {}),
          ...(media.aspectRatio !== undefined ? { aspectRatio: media.aspectRatio } : {}),
          ...(revealOwner ? { ownerUserId: file.ownerUserId ?? null } : {}),
          ...(revealOwner && file.ownerApplicationId
            ? { ownerApplicationId: file.ownerApplicationId }
            : {}),
        };
      });

    logger.debug('POST /assets/service/by-ids', {
      appId: req.serviceApp?.appId,
      requested: ids.length,
      resolved: data.length,
    });

    sendSuccess(res, data);
  }),
);

/**
 * TTL of a minted download URL.
 *
 * Short because a presigned S3 URL is BEARER AUTHORITY over the bytes with no
 * further check: whoever holds the string is the reader, and nothing about the
 * relying app's own entitlement is re-evaluated when it is used. Five minutes is
 * the shortest window that still lets a client follow a redirect and begin the
 * transfer, and it matches the lifetime of the entitlement grant on the other
 * side of this call (Mercaria's download grant, also 300s) so neither outlives
 * the other.
 *
 * It bounds when a transfer may START, not how long one may take — S3 evaluates
 * `X-Amz-Expires` once, at request time — so an 8 GiB deliverable downloads
 * fine on a slow link. What it does NOT survive is a RESUME: a client that
 * drops at 4 GiB and retries with a `Range` header ten minutes later gets a
 * 403 and must ask for a new URL. That is deliberate, and it is why the relying
 * app's grant is redeemable more than once rather than this window being wide.
 */
const LINKED_URL_TTL_SECONDS = 300;

/**
 * Per-app rate limit for minting download URLs.
 *
 * Its own limiter rather than a share of {@link assetServiceLookupLimiter}, and a
 * FIFTH of that ceiling, because the two bound different costs. That one bounds a
 * projected read of rows by id; this one bounds how many live bearer credentials
 * for file CONTENT an app can have outstanding — 120/min × 25 ids × 300s TTL, so
 * at most ~15,000 valid URLs exist at any moment for a runaway caller, rather
 * than the ~750,000 a shared 600/min budget would allow.
 *
 * Unique redis prefix per the rate-limiter convention: a duplicated prefix on a
 * shared store makes one request increment the same counter twice
 * (`ERR_ERL_DOUBLE_COUNT`) and silently halves the budget.
 */
const LINKED_URL_MAX_PER_MINUTE = 120;

const assetLinkedUrlLimiter = rateLimit({
  prefix: 'rl:asset-linked-url:',
  windowMs: CACHE_RATE_WINDOW_MS,
  max: LINKED_URL_MAX_PER_MINUTE,
  message: 'Too many asset download URL requests. Please slow down.',
  keyGenerator: (req: express.Request) => {
    const serviceApp = (req as ServiceAuthRequest).serviceApp;
    if (serviceApp?.appId) {
      return `asset-linked-url:${serviceApp.appId}`;
    }
    return `asset-linked-url:ip:${hashedIpKey(req)}`;
  },
});

// The linked-url predicate — the application's own file, or a person's file
// the person consented to it reading (it stored the file for them, or they
// attached it to it — ADR 0021 — and never after they revoked it; ADR 0043
// stage 4c) — is `mayApplicationRead` in `services/fileReference.service.ts`,
// shared with the reference routes and play sessions.

/**
 * @openapi
 * /assets/service/linked-url:
 *   post:
 *     tags:
 *       - Files
 *     summary: Mint short-lived download URLs for files linked to the calling app
 *     description: >
 *       Service-token-only. Given up to 25 file ids, returns a short-lived
 *       direct download URL for each of the caller's OWN files (ADR 0043) and
 *       for each person's file the person consented to the calling application
 *       reading (ADR 0043 stage 4c): one the application stored for them
 *       (`/service/user-media` upload, import, large upload or recording), or
 *       one THE FILE'S OWN OWNER attached to it (a `file_references` row whose
 *       `application_id` is the caller's and whose `created_by_user_id` is the
 *       file's `owner_user_id`) — unless the person revoked the application's
 *       access (`DELETE /assets/{id}/access/{applicationId}`). Any other id is
 *       silently OMITTED from `data`: unknown, not active, system-owned,
 *       another application's, not consented, or revoked (an application's own
 *       service-made reference never qualifies). The
 *       batch never 404s as a whole and never returns a placeholder or an empty
 *       string for a refused id, so a caller cannot tell "no such file" from
 *       "not yours" — and must treat absence as "no URL", never as an error to
 *       retry.
 *
 *       Requires the `files:linked:read` scope, which is NOT implied by
 *       `files:read`: that one is metadata-only and grants no authority over
 *       file contents. The returned URL is bearer authority over the bytes for
 *       `expiresIn` seconds with no further check, so it must not be logged,
 *       cached or handed to anyone the caller has not itself authorized.
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
 *                 maxItems: 25
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: >
 *           Minted download URLs (order not guaranteed, and SHORTER than `ids`
 *           whenever any id was refused).
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
 *                       url:
 *                         type: string
 *                         description: >
 *                           Direct download URL. Expires in `expiresIn` seconds;
 *                           the deadline applies to when the transfer STARTS, so
 *                           a large file may take longer than that to finish but
 *                           a resumed range request after expiry will fail.
 *                       expiresIn:
 *                         type: integer
 *                       mime:
 *                         type: string
 *                       size:
 *                         type: integer
 *                       sha256:
 *                         type: string
 *       400:
 *         description: Validation failed (empty array or more than 25 ids).
 *       401:
 *         description: Missing or expired service token.
 *       403:
 *         description: Not a service token, or missing the files:linked:read scope.
 */
router.post(
  '/service/linked-url',
  serviceAuthMiddleware,
  assetLinkedUrlLimiter,
  validate({ body: assetsLinkedUrlBodySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    requireServiceScope(req, 'files:linked:read');

    const appId = req.serviceApp?.appId;
    if (!appId) {
      // `serviceAuthMiddleware` always populates this, so reaching here means the
      // middleware changed shape. Refusing is the only safe answer: an absent
      // appId would make the link predicate below compare against `undefined`
      // and admit nothing — or, if the comparison were ever loosened, everything.
      throw new ForbiddenError('Service token carries no application identity');
    }

    const { ids } = req.body as { ids: string[] };

    const files = await assetService.getFilesByIds(ids);

    const requesterAccount =
      req.serviceApp?.authority === 'first_party'
        ? req.serviceRequester?.subjectAccountId
        : undefined;
    const readable = await Promise.all(
      files.map(async (file) => {
        if (!isServableStatus(file)) return null;
        if (mayApplicationRead(file, appId)) return file;
        // Account authority comes from the separately verified requester proof,
        // never from the file owner or an arbitrary account header.
        if (
          requesterAccount &&
          !file.ownerApplicationId &&
          (await assetService.canUserAccessFile(file, requesterAccount))
        )
          return file;
        return null;
      }),
    );
    const data = await Promise.all(
      readable
        .filter((file): file is NonNullable<typeof file> => file !== null)
        .map(async (file) => ({
          id: file.id,
          url: await s3Service.getPresignedDownloadUrl(file.storageKey, LINKED_URL_TTL_SECONDS),
          expiresIn: LINKED_URL_TTL_SECONDS,
          mime: file.mime,
          size: file.size,
          sha256: file.sha256,
        })),
    );

    // `requested` and `resolved` but never the ids themselves, and never a URL: a
    // minted URL in a log line is a credential in a log line.
    logger.debug('POST /assets/service/linked-url', {
      appId,
      requested: ids.length,
      resolved: data.length,
    });

    sendSuccess(res, data);
  }),
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
 *
 *       Asset rows are per OWNER: several accounts that uploaded the same bytes
 *       each hold their own row (sharing the stored object). Pass `ownerUserId`
 *       to resolve each hash to THAT account's own row — the id it may
 *       reference as its own media. Without it (the legacy form) each hash
 *       resolves to the oldest live row of any owner: good for "is this content
 *       stored" and for its public `url`, but that id belongs to whoever
 *       uploaded first and must not be attached to another account's content.
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
 *               ownerUserId:
 *                 type: string
 *                 description: Resolve each hash to this account's own live row only.
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

    const { sha256s, ownerUserId } = req.body as { sha256s: string[]; ownerUserId?: string };

    // Dedupe so a single batch never issues duplicate work; the schema already
    // lowercased + validated each entry as a 64-char hex digest.
    const uniqueShas = Array.from(new Set(sha256s));

    // One live record per hash. Rows are per owner, so several can share a
    // hash: with `ownerUserId` the answer is that account's own row (at most
    // one, by the per-owner unique); without it — the legacy form — the oldest
    // live row of any owner, so the sha256 -> id mapping stays stable across
    // calls for existing callers.
    const files = await assetService.findActiveFilesBySha256(uniqueShas, { ownerUserId });

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
      }),
    );

    logger.debug('POST /assets/service/by-sha256', {
      appId: req.serviceApp?.appId,
      requested: uniqueShas.length,
      resolved: data.length,
    });

    sendSuccess(res, data);
  }),
);

// ---------------------------------------------------------------------------
// Play sessions (ADR 0043 stage 4c): per-play, revocable access to a file's
// HLS ladder, optionally AES-128 encrypted with a key the product authorizes.
// `services/playSession.service.ts` and `services/hlsStreamServing.ts`.
// ---------------------------------------------------------------------------

/** Per-application ceiling for opening and revoking play sessions. */
const PLAY_SESSION_MAX_PER_MINUTE = 600;

const playSessionLimiter = rateLimit({
  prefix: 'rl:asset-play-session:',
  windowMs: CACHE_RATE_WINDOW_MS,
  max: PLAY_SESSION_MAX_PER_MINUTE,
  message: 'Too many play session requests. Please slow down.',
  keyGenerator: (req: express.Request) => {
    const serviceApp = (req as ServiceAuthRequest).serviceApp;
    if (serviceApp?.appId) {
      return `asset-play-session:${serviceApp.appId}`;
    }
    return `asset-play-session:ip:${hashedIpKey(req)}`;
  },
});

/**
 * The public stream surface is exempt from the per-address browser limiters
 * (`middleware/security.isCapabilityUrlPath`): a player is machine-paced and
 * many listeners share an address. These two are its budgets instead — a
 * per-address flood ceiling, then a per-session one (a few segments a second
 * is far above any real player).
 */
const streamObjectAddressLimiter = rateLimit({
  prefix: 'rl:asset-stream-object:ip:',
  windowMs: 15 * 60 * 1000,
  max: 60_000,
  message: 'Too many stream requests from this address.',
  keyGenerator: (req: express.Request) => `asset-stream-object:ip:${hashedIpKey(req)}`,
});

const streamObjectSessionLimiter = rateLimit({
  prefix: 'rl:asset-stream-object:session:',
  windowMs: CACHE_RATE_WINDOW_MS,
  max: 600,
  message: 'Too many requests for this play session.',
  keyGenerator: (req: express.Request) => {
    const token = typeof req.params.token === 'string' ? req.params.token : '';
    const dot = token.indexOf('.');
    return `asset-stream-object:session:${dot > 0 ? token.slice(0, Math.min(dot, 64)) : 'malformed'}`;
  },
});

/** The stored ladder's playlists, read from storage once per task (immutable objects). */
const readStoredPlaylist = cachedPlaylistReader((key) => s3Service.downloadBuffer(key));

function playlistBasename(key: string): string {
  return key.slice(key.lastIndexOf('/') + 1);
}

function variantBandwidth(variant: FileVariantRecord): number | null {
  const bandwidth = variant.metadata?.bandwidth;
  return typeof bandwidth === 'number' && Number.isFinite(bandwidth) ? bandwidth : null;
}

/**
 * A session as its application sees it. The URLs exist only in the answer
 * that opened it (`base`): the URL secret is not stored.
 */
function serializePlaySession(row: FilePlaySessionRow, file: FileRecord | null, base?: string) {
  return {
    sessionId: row.id,
    fileId: row.fileId,
    kind: file?.mime.startsWith('audio/') ? 'audio' : 'video',
    status: playSessionStatus(row),
    encryption: row.encryption,
    keyAuthorization: row.keyAuthorization,
    endUserId: row.endUserId,
    expiresAt: row.expiresAt,
    /** The rungs this session may serve; `null`: the whole ladder. */
    allowedRenditions: row.renditions ?? null,
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
    ...(base && file
      ? {
          masterUrl: `${base}${MASTER_PLAYLIST_NAME}`,
          renditions: readyRenditions(file, renditionAllowList(row)).map((variant) => ({
            type: variant.type,
            url: `${base}${playlistBasename(variant.key)}`,
            bandwidth: variantBandwidth(variant),
          })),
          ...(file.variants.some((variant) => variant.type === 'preview' && variant.readyAt)
            ? { previewUrl: `${base}${PREVIEW_NAME}` }
            : {}),
          ...(file.variants.some((variant) => variant.type === 'waveform' && variant.readyAt)
            ? { waveformUrl: `${base}${WAVEFORM_NAME}` }
            : {}),
        }
      : {}),
  };
}

/**
 * @route POST /api/assets/service/streams
 * @desc Open a play session over a file's HLS ladder (ADR 0043 stage 4c): a
 *       short-lived, revocable set of URLs for ONE file, optionally for one
 *       end user. Body `{ fileId, endUserId?, ttlSeconds? (60–43200, default
 *       3600), encryption? ('aes-128' default | 'none'), keyAuthorization?
 *       ('none' default | 'webhook'), renditions? }`. `renditions` is an
 *       allow-list of the ladder's rungs (`hls_a64` | `hls_a128` | `hls_a256`
 *       | `hls_360p` | `hls_720p` | `hls_1080p`): the master lists only those,
 *       and any other rung's playlist, segment or key is 404 for this session
 *       (409 `STREAM_RENDITIONS_NOT_READY` when the file has none of them
 *       ready); omitted, the whole ladder. The file must be the calling
 *       application's own, or a person's file the application may read (it
 *       stored it for them, or they attached it to it, and did not revoke
 *       that — `files:linked:read`); anything else is 404, like no file. 409
 *       `STREAM_NOT_READY` until the ladder is made. 201 `{ sessionId,
 *       fileId, kind: 'video' | 'audio', status: 'active', encryption,
 *       keyAuthorization, endUserId, expiresAt, allowedRenditions, masterUrl,
 *       renditions: [{ type, url, bandwidth }], previewUrl?, waveformUrl? }`
 *       (`renditions`: the ready rungs the session serves) — the URLs are
 *       bearer authority for this session only and are shown once. Every
 *       request under them re-checks the session, so revoking it (`DELETE`),
 *       the owner revoking the application's access, or the file leaving
 *       `active` stops the next segment. With `aes-128` the segments are
 *       encrypted as served under a key of this session, released at
 *       `<base>/key`; with `keyAuthorization: 'webhook'` only after the
 *       application's verified file-events endpoint answers `{ "allow": true
 *       }` to a signed `stream.key_authorization` request (409
 *       `FILES_WEBHOOK_REQUIRED` without one).
 * @access Service token only: `files:linked:read` (a person's file) or
 *         `files:app:write` (the application's own), on an active application
 */
router.post(
  '/service/streams',
  serviceAuthMiddleware,
  playSessionLimiter,
  validate({ body: playSessionBodySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const appId = await requireActiveApplication(req, ['files:linked:read', 'files:app:write']);
    const body = req.body as z.infer<typeof playSessionBodySchema>;
    const file = await assetService.getFile(body.fileId);
    const consent = file && isServableStatus(file) ? applicationReadConsent(file, appId) : null;
    if (!file || !consent) throw new NotFoundError('File not found');
    // Reading a PERSON's file is `files:linked:read`'s authority, never `files:app:write`'s.
    if (consent !== 'owner') requireServiceScope(req, 'files:linked:read');
    if (!readyMasterPlaylist(file)) {
      throw new ApiError(409, 'This file has no streaming renditions yet', 'STREAM_NOT_READY');
    }
    const renditions = normalizeRenditionAllowList(body.renditions);
    if (renditions && readyRenditions(file, new Set(renditions)).length === 0) {
      throw new ApiError(
        409,
        'None of the requested renditions is ready for this file',
        'STREAM_RENDITIONS_NOT_READY',
      );
    }
    const { row, secret } = await openPlaySession({
      file,
      applicationId: appId,
      endUserId: body.endUserId ?? null,
      ttlSeconds: body.ttlSeconds ?? PLAY_SESSION_DEFAULT_TTL_SECONDS,
      encryption: body.encryption ?? 'aes-128',
      keyAuthorization: body.keyAuthorization ?? 'none',
      renditions,
    });
    const host = req.get('host') ?? '';
    const base = `${req.protocol}://${host}${req.baseUrl}/streams/${row.id}.${secret}/`;
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, serializePlaySession(row, file, base), 201);
  }),
);

/**
 * @route POST /api/assets/service/streams/revoke
 * @desc Revoke every live play session of the calling application for a file
 *       and/or an end user: `{ fileId?, endUserId? }` (at least one) → `{
 *       revoked }`, the number ended. Effective on every API task at once.
 * @access Service token only: `files:linked:read` or `files:app:write`, on an active application
 */
router.post(
  '/service/streams/revoke',
  serviceAuthMiddleware,
  playSessionLimiter,
  validate({ body: revokePlaySessionsBodySchema }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const appId = await requireActiveApplication(req, ['files:linked:read', 'files:app:write']);
    const body = req.body as z.infer<typeof revokePlaySessionsBodySchema>;
    const revoked = await revokePlaySessionsWhere(appId, body, 'application');
    sendSuccess(res, { revoked });
  }),
);

/**
 * @route GET /api/assets/service/streams/:sessionId
 * @desc One of the calling application's play sessions: `status` (`active` |
 *       `revoked` | `expired`), `revokedAt`, `expiresAt`. The URLs are not
 *       shown again. Another application's session is 404.
 * @access Service token only: `files:linked:read` or `files:app:write`, on an active application
 */
router.get(
  '/service/streams/:sessionId',
  serviceAuthMiddleware,
  playSessionLimiter,
  validate({ params: playSessionParams }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const appId = await requireActiveApplication(req, ['files:linked:read', 'files:app:write']);
    const row = await loadApplicationPlaySession(req.params.sessionId, appId);
    sendSuccess(res, serializePlaySession(row, await assetService.getFile(row.fileId)));
  }),
);

/**
 * @route DELETE /api/assets/service/streams/:sessionId
 * @desc Revoke one of the calling application's play sessions NOW: the next
 *       playlist, segment or key request under its URLs is refused, on every
 *       API task. Idempotent: `{ sessionId, revoked: true }`. Another
 *       application's session is 404.
 * @access Service token only: `files:linked:read` or `files:app:write`, on an active application
 */
router.delete(
  '/service/streams/:sessionId',
  serviceAuthMiddleware,
  playSessionLimiter,
  validate({ params: playSessionParams }),
  asyncHandler(async (req: ServiceAuthRequest, res: express.Response) => {
    const appId = await requireActiveApplication(req, ['files:linked:read', 'files:app:write']);
    const row = await loadApplicationPlaySession(req.params.sessionId, appId);
    await revokePlaySession(row, 'application');
    sendSuccess(res, { sessionId: row.id, revoked: true });
  }),
);

/** A session object request that is not (or no longer) servable — said the same for every cause. */
function invalidPlaySession(): ApiError {
  return new ApiError(404, 'This play session is not valid', 'PLAY_SESSION_INVALID');
}

/**
 * @route GET /api/assets/streams/:token/:name
 * @desc What a play session's URLs name (ADR 0043 stage 4c): `master.m3u8`,
 *       a rendition playlist, a segment it lists, `key` (the AES-128 key, 16
 *       bytes), `preview.m4a` and `waveform.json` (audio). A session with a
 *       rendition allow-list serves only those rungs — the master lists only
 *       them, any other rung's playlist or segment is 404 — and has one key
 *       per rung, `<rung>.key` (its own `key` is 404). The token is
 *       `<sessionId>.<secret>`; every request checks the session (live, not
 *       revoked, not expired), the file (`active`) and that the application
 *       may still read it — anything else is 404 `PLAY_SESSION_INVALID`. An
 *       encrypted session's rendition playlists declare the key and its
 *       segments are AES-128-CBC encrypted as served (IV = media sequence
 *       number). The key with key authorization: 403
 *       `KEY_AUTHORIZATION_DENIED` unless the application allowed it. CORS is
 *       open (`*`, no credentials): the URL is the credential.
 * @access Public — the URL token is the authority
 */
router.get(
  '/streams/:token/:name',
  mediaHeadersMiddleware,
  streamObjectAddressLimiter,
  validate({ params: streamObjectParams }),
  streamObjectSessionLimiter,
  asyncHandler(async (req: express.Request, res: express.Response) => {
    // The URL is the credential: any origin may play it, and no cookie or
    // bearer is ever involved.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.removeHeader('Access-Control-Allow-Credentials');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');

    const session = await resolveServingSession(req.params.token);
    const file = session ? await assetService.getFile(session.row.fileId) : null;
    if (
      !session ||
      !file ||
      !isServableStatus(file) ||
      !mayApplicationRead(file, session.row.applicationId)
    ) {
      res.setHeader('Cache-Control', 'no-store');
      throw invalidPlaySession();
    }
    const allowed = session.allowedRenditions;
    const object = await resolveStreamObject(file, req.params.name, readStoredPlaylist, allowed);
    if (!object) {
      res.setHeader('Cache-Control', 'no-store');
      throw new NotFoundError('Not part of this stream');
    }

    if (object.kind === 'key') {
      res.setHeader('Cache-Control', 'no-store');
      if (!session.contentKey) throw new NotFoundError('This stream is not encrypted');
      if (!(await authorizeKeyRelease(session))) {
        throw new ApiError(
          403,
          'The application did not authorize this key',
          'KEY_AUTHORIZATION_DENIED',
        );
      }
      const key = object.rendition
        ? renditionContentKey(session.contentKey, object.rendition)
        : session.contentKey;
      res.setHeader('Content-Type', streamContentType(object));
      res.setHeader('Content-Length', String(key.length));
      return res.status(200).end(key);
    }

    if (object.kind === 'master' || object.kind === 'rendition') {
      const playlist = await readStoredPlaylist(object.variant.key);
      let text = playlist.text;
      if (object.kind === 'master' && allowed) {
        const names = new Set(
          readyRenditions(file, allowed).map((variant) => playlistBasename(variant.key)),
        );
        text = restrictedMasterPlaylist(text, names);
      } else if (object.kind === 'rendition' && session.contentKey) {
        text = encryptedRenditionPlaylist(
          text,
          allowed ? renditionKeyName(object.variant.type) : undefined,
        );
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', streamContentType(object));
      return res.status(200).end(text);
    }

    const key = object.kind === 'segment' ? object.key : object.variant.key;
    const encrypt = object.kind === 'segment' && session.contentKey !== null;
    const rangeHeader =
      !encrypt && typeof req.headers.range === 'string' ? req.headers.range : undefined;
    let stored: Awaited<ReturnType<typeof s3Service.getObjectStreamRange>>;
    try {
      stored = await s3Service.getObjectStreamRange(key, rangeHeader);
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'NoSuchKey' || name === 'NotFound') throw new NotFoundError('Not found');
      throw error;
    }
    res.setHeader('Content-Type', streamContentType(object, stored.contentType));
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (encrypt && object.kind === 'segment' && session.contentKey) {
      if (stored.contentLength != null) {
        res.setHeader('Content-Length', String(encryptedLength(stored.contentLength)));
      }
      res.status(200);
      const segmentKey = allowed
        ? renditionContentKey(session.contentKey, object.rendition)
        : session.contentKey;
      const cipher = segmentCipher(segmentKey, object.mediaSequence);
      const body = stored.body as unknown as NodeJS.ReadableStream;
      body.on('error', (error: Error) => cipher.destroy(error));
      cipher.on('error', (error: Error) => {
        logger.error('Encrypted segment stream failed', { error: error.message });
        res.destroy(error);
      });
      body.pipe(cipher).pipe(res);
      return;
    }
    if (stored.contentLength != null) res.setHeader('Content-Length', String(stored.contentLength));
    if (stored.contentRange) res.setHeader('Content-Range', stored.contentRange);
    res.setHeader('Accept-Ranges', 'bytes');
    res.status(stored.statusCode);
    stored.body.on('error', (error: Error) => {
      logger.error('Stream session object failed', { error: error.message });
      res.destroy(error);
    });
    stored.body.pipe(res);
  }),
);

/**
 * @route GET /api/assets/:id/access
 * @desc The applications that can read the caller's file with their service
 *       token right now (ADR 0043 stage 4c), for "Apps with access": `{
 *       fileId, applications: [{ applicationId, name, icon, via: ('upload' |
 *       'link')[], since }] }` — `upload`: the application stored the file
 *       for you; `link`: you attached the file to it. Anybody but the owner
 *       gets 404.
 * @access Private — the file's owner only
 */
router.get(
  '/:id/access',
  ownAssetAuth,
  validate({ params: assetIdParams }),
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
    if (!req.user?._id) throw new UnauthorizedError('Authentication required');
    const file = await assetService.getFile(req.params.id);
    if (!file || file.status === 'deleted' || !(await sessionOwnsFile(req, file))) {
      throw new NotFoundError('File not found');
    }
    const access = await listApplicationAccess(file);
    sendSuccess(res, {
      fileId: file.id,
      applications: access.map((entry) => ({ ...entry, since: entry.since.toISOString() })),
    });
  }),
);

/**
 * @route DELETE /api/assets/:id/access/:applicationId
 * @desc The owner withdraws an application's access to their file (ADR 0043
 *       stage 4c): whatever gave it — the application stored it for them, or
 *       they attached it to it — the application can no longer read it
 *       (`/service/linked-url`, play sessions), and every play session it
 *       holds for the file ends now. It stays withdrawn when the application
 *       uploads the same bytes again; attaching the file to that application
 *       again (`POST /assets/{id}/links`) gives it back. References the
 *       application holds are kept: they record its USE, which is not access.
 *       Idempotent: `{ fileId, applicationId, revoked: true, streamsRevoked }`.
 *       404 for anybody but the owner, and for an unknown application.
 * @access Private — the file's owner only
 */
router.delete(
  '/:id/access/:applicationId',
  ownAssetAuth,
  validate({ params: fileAccessParams }),
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
    if (!req.user?._id) throw new UnauthorizedError('Authentication required');
    const { id: fileId, applicationId } = req.params;
    const file = await assetService.getFile(fileId);
    if (!file || file.status === 'deleted' || !(await sessionOwnsFile(req, file))) {
      throw new NotFoundError('File not found');
    }
    if (!(await applicationExists(applicationId))) {
      throw new NotFoundError('Application not found');
    }
    const { streamsRevoked } = await revokeApplicationAccess(
      file.id,
      applicationId,
      req.user._id.toString(),
    );
    logger.info('Owner revoked an application’s access to a file', {
      fileId: file.id,
      applicationId,
      streamsRevoked,
    });
    sendSuccess(res, { fileId: file.id, applicationId, revoked: true, streamsRevoked });
  }),
);

/**
 * The application a signed-in session's reference is recorded under (ADR 0043
 * D4, the compatibility surface).
 *
 * A session bound to ONE application (an untrusted OAuth client's) is that
 * application, whatever the body says; a body naming a different application
 * is refused. The shared device session every official app uses cannot say
 * which app it is (`sessions.application_id` is NULL by design), so for it the
 * body's `app` is all there is: an application id, or one of the legacy
 * strings migration 0171 maps (`utils/legacyFileLinkApplications.ts`). A
 * string that names no single active application is refused — a reference is
 * never recorded against free text again.
 */
async function resolveSessionReferenceApplication(
  req: AuthenticatedRequest,
  app: string,
): Promise<string> {
  const bound = req.oxyToken?.applicationId ?? null;
  const named = await resolveReferenceApplicationId(app);
  if (bound) {
    if (named !== null && named !== bound) {
      throw new ForbiddenError('This session belongs to a different application');
    }
    return bound;
  }
  if (!named) {
    throw new BadRequestError(`"${app}" names no application`);
  }
  return named;
}

/**
 * @route POST /api/assets/:id/links
 * @desc Record that an application uses the caller's file (`file_references`,
 *       ADR 0043 D4). Compatibility surface: an application should use
 *       `POST /assets/service/references` with its own token. `visibility`,
 *       when sent, is an explicit change by the owner — a reference itself
 *       never changes visibility.
 * @access Private — the file's owner only; anybody else gets 403
 */
router.post(
  '/:id/links',
  authMiddleware,
  validate({ params: assetIdParams, body: linkFileSchema }),
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
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

    // A reference is a USE of the file and pulls it out of trash, and the
    // body may change its visibility. Naming someone else's id used to do all
    // of that to their file.
    const target = await assetService.getFile(fileId);
    if (!target) {
      throw new NotFoundError('File not found');
    }
    if (!(await sessionOwnsFile(req, target))) {
      throw new ForbiddenError('You do not own this file');
    }

    const applicationId = await resolveSessionReferenceApplication(req, validatedData.app);

    // The owner's explicit choice, never inferred from the entity type.
    if (validatedData.visibility && validatedData.visibility !== target.visibility) {
      await assetService.updateFileVisibility(fileId, validatedData.visibility);
    }

    const { file } = await assetService.linkFile(fileId, {
      applicationId,
      entityType: validatedData.entityType,
      entityId: validatedData.entityId,
      createdByUserId: user._id.toString(),
      // `webhookUrl` in the body is ignored (ADR 0043 D9): file events go to
      // the application's own verified endpoint.
    });
    // Attaching their file to the application is the owner's explicit consent
    // for it to read the file (ADR 0021), which lifts an earlier revocation of
    // that application's access (ADR 0043 stage 4c).
    if (target.ownerUserId) {
      await restoreAccessByOwner(fileId, applicationId, user._id.toString());
    }

    logger.info('File linked successfully', {
      userId: user._id,
      fileId,
      applicationId,
      entityType: validatedData.entityType,
    });

    sendSuccess(res, {
      assetId: file.id,
      file: {
        id: file.id,
        usageCount: file.links.length,
        links: file.links.map(serializeLink),
        status: file.status,
      },
    });
  }),
);

/**
 * @route DELETE /api/assets/:id/links
 * @desc Remove one application's use of a file. The file's OWNER may remove
 *       any reference to it; anybody else only a reference they created
 *       themselves (404 otherwise). Removing a reference never trashes or
 *       deletes the file — not even the owner's last one (ADR 0043 D5): the
 *       file stays `active` and is reported `inUse: false`.
 *       An application removes the references it holds with its own token
 *       (`DELETE /assets/service/references`) — how GoWay must withdraw a
 *       contributor's photo from a place (ADR 0043 D12).
 * @access Private
 */
router.delete(
  '/:id/links',
  authMiddleware,
  validate({ params: assetIdParams, body: unlinkFileSchema }),
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
    const user = req.user;
    if (!user?._id) {
      throw new UnauthorizedError('Authentication required');
    }

    const { id: fileId } = req.params;
    let validatedData: z.infer<typeof unlinkFileSchema>;
    try {
      validatedData = unlinkFileSchema.parse(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ValidationError('Invalid request data', { details: error.errors });
      }
      throw error;
    }

    const target = await assetService.getFile(fileId);
    if (!target) {
      throw new NotFoundError('File not found');
    }
    const isOwner = await sessionOwnsFile(req, target);
    const applicationId = await resolveSessionReferenceApplication(req, validatedData.app);

    // A non-owner removes only what it made: the subject's own references,
    // or its operator's. It used to remove anybody's link on anybody's file.
    const operatorId = isOwner ? null : await resolveOperatorId(req);
    const creators = [user._id.toString(), ...(operatorId ? [operatorId] : [])];
    const { file, removed } = await assetService.unlinkFile(
      fileId,
      {
        applicationId,
        entityType: validatedData.entityType,
        entityId: validatedData.entityId,
      },
      isOwner ? {} : { createdByUserIds: creators },
    );
    if (!isOwner && !removed) {
      throw new NotFoundError('Reference not found');
    }

    logger.info('File unlinked successfully', {
      userId: user._id,
      fileId,
      applicationId,
      removed,
    });

    // A non-owner sees only its own references, as on `GET /assets/:id`.
    const visibleLinks = isOwner
      ? file.links
      : file.links.filter(
          (link) => link.createdByUserId !== null && creators.includes(link.createdByUserId),
        );

    sendSuccess(res, {
      file: {
        id: file.id,
        usageCount: file.links.length,
        links: visibleLinks.map(serializeLink),
        status: file.status,
      },
    });
  }),
);

/**
 * @openapi
 * /assets/{id}:
 *   get:
 *     tags:
 *       - Files
 *     summary: Get file metadata
 *     description: >
 *       Return metadata for the file (size, MIME, SHA-256, variants, links,
 *       usage count, status). The owner (the session's subject or its
 *       operator) gets every link. Anybody else gets a `public` or `unlisted`
 *       file — one already readable by whoever has its link — with only the
 *       links they created themselves, and a 404 for a `private` one. Signed
 *       URLs (`/assets/:id/url` or `/assets/:id/stream`) are the access path
 *       for bytes.
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
router.get(
  '/:id',
  ownAssetAuth,
  validate({ params: assetIdParams }),
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
    const user = req.user;
    if (!user?._id) {
      throw new UnauthorizedError('Authentication required');
    }

    const { id: fileId } = req.params;
    const file = await assetService.getFile(fileId);

    // A PRIVATE application-owned file (ADR 0043) is readable by no person:
    // only its owning application, through its own service token. Its
    // metadata — variant keys, links, original name — is not served to a
    // session either; to a session it does not exist.
    if (!file || (file.ownerApplicationId && file.visibility === 'private')) {
      throw new NotFoundError('File not found');
    }

    // Somebody else's PRIVATE file does not exist to this caller. A public or
    // unlisted one may be described — whoever has the link can read the bytes
    // anyway, and Mercaria's catalog check reads a store's or a manufacturer's
    // public file this way — but its links are the owner's record of where it
    // is used (other people's entity ids, webhook URLs), so a non-owner sees
    // only the links it created itself.
    const isOwner = await sessionOwnsFile(req, file);
    if (!isOwner && file.visibility === 'private') {
      throw new NotFoundError('File not found');
    }
    if (!(await assetService.canUserAccessFile(file, user._id)))
      throw new ForbiddenError('Access denied');
    const operatorId = isOwner ? null : await resolveOperatorId(req);
    const visibleLinks = isOwner
      ? file.links
      : file.links.filter(
          (link) =>
            link.createdByUserId !== null &&
            (link.createdByUserId === user._id.toString() || link.createdByUserId === operatorId),
        );

    logger.debug('File metadata retrieved', {
      userId: user._id,
      fileId,
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
        // Present only on an application-owned file (ADR 0043), so an
        // account's file keeps exactly the wire shape it always had.
        ...(!file.ownerApplicationId ? {} : { ownerApplicationId: file.ownerApplicationId }),
        status: file.status,
        visibility: file.visibility,
        usageCount: file.links.length,
        // The owner's record of whether the file is in use; not anybody else's.
        ...(isOwner ? serializeLifecycle(file) : {}),
        createdAt: file.createdAt,
        updatedAt: file.updatedAt,
        links: visibleLinks.map(serializeLink),
        variants: file.variants.map(serializeVariant),
        metadata: file.metadata,
      },
    });
  }),
);

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
router.get(
  '/:id/url',
  ownAssetAuth,
  validate({ params: assetIdParams, query: assetUrlQuerySchema }),
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
    const user = req.user;
    if (!user?._id) {
      throw new UnauthorizedError('Authentication required');
    }

    const { id: fileId } = req.params;
    const { variant, expiresIn } = req.query;

    const variantType = singleQueryValue(variant);
    const expiry = typeof expiresIn === 'string' ? Number.parseInt(expiresIn) : 3600;

    const file = await assetService.getFile(fileId);
    // A file in trash (or deleted) is never served, so it has no URL (ADR 0043 D5).
    if (!file || !isServableStatus(file)) {
      throw new NotFoundError('File not found');
    }

    // The caller must actually be allowed to see this asset before we hand back a
    // renderable URL. `authMiddleware` proves identity; this proves authorization
    // for THIS asset (ownership, follow/block, entity context) — so we never mint
    // a media token for an asset the caller can't access.
    if (!(await assetService.canUserAccessFile(file, user._id))) {
      logger.warn('Access denied to asset URL', {
        fileId,
        userId: user._id,
        visibility: file.visibility,
      });
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
    const mediaToken =
      cdnUrl || file.visibility === 'public' ? undefined : signMediaToken(fileId, user._id);
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
  }),
);

/**
 * @route GET /api/assets/:id/exists
 * @desc Debug: return storageKey and existence of the underlying object
 * @access Private — the file's owner only; any other caller gets 404
 */
router.get(
  '/:id/exists',
  authMiddleware,
  validate({ params: assetIdParams }),
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
    const user = req.user;
    if (!user?._id) {
      throw new UnauthorizedError('Authentication required');
    }

    const { id: fileId } = req.params;
    const file = await assetService.getFile(fileId);
    // The storage key is storage detail of somebody's file, and an answer at
    // all says the id exists: neither is any caller's business but the owner's.
    if (!file || !(await sessionOwnsFile(req, file))) {
      throw new NotFoundError('File not found');
    }

    const exists = await s3Service.fileExists(file.storageKey);
    sendSuccess(res, {
      fileId,
      storageKey: file.storageKey,
      exists,
      hasVariants: Array.isArray(file.variants) && file.variants.length > 0,
    });
  }),
);

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
router.get(
  '/:id/stream',
  mediaHeadersMiddleware,
  validate({ params: assetIdParams }),
  optionalAuthMiddleware,
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
    // `<img src>` can send neither an Authorization header nor a cookie, so resolve
    // the viewer from the scoped `?mt=` media token (bound to this file id) when no
    // session user is present, so owners can render their own private media. Access
    // is still gated by canUserAccessFile.
    const userId = getMediaViewerUserId(req);
    const { id: fileId } = req.params;
    const { variant } = req.query;
    const variantType = singleQueryValue(variant);

    const fallback = typeof req.query.fallback === 'string' ? req.query.fallback : '';

    const file = await assetService.getFile(fileId);
    // Only an `active` file is served — never one in trash or deleted, by
    // origin OR by the CDN redirect below (ADR 0043 D5, OxyHQ/oxy#1284: the
    // fast path used to redirect a trashed public file to the CDN). It answers
    // exactly like a missing one.
    if (!file || !isServableStatus(file)) {
      if (fallback === 'placeholderVisible' || fallback === 'icon') {
        const svg = generateMissingFilePlaceholder(fileId);
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Content-Security-Policy', SVG_PLACEHOLDER_CSP);
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
        res.setHeader('Content-Security-Policy', SVG_PLACEHOLDER_CSP);
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
        storageKey = await assetService.variantKeyOrOriginal(file, variantType);
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
          res.setHeader('Content-Security-Policy', SVG_PLACEHOLDER_CSP);
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
        res.setHeader('Content-Security-Policy', SVG_PLACEHOLDER_CSP);
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
        res.setHeader('Cache-Control', CDN_REDIRECT_CACHE_CONTROL);
        return sendAssetRedirect(res, buildCdnUrl(stripPublicPrefix(storageKey)));
      }

      // Legacy public object whose DB key still points at a non-public key, but
      // whose bytes were copied under `public/` by the CDN backfill. Reuse the
      // same variant-aware probe `/assets/:id/url` uses so the CDN serves the
      // bytes for the REQUESTED variant (thumb/w320/original). Only fall through
      // to origin streaming when no `public/` copy exists (or the probe errors).
      try {
        const cdnUrl = await assetService.getPublicCdnUrl(file, variantType);
        if (cdnUrl) {
          res.setHeader('Cache-Control', CDN_REDIRECT_CACHE_CONTROL);
          return sendAssetRedirect(res, cdnUrl);
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
      // Only media a browser renders without running anything is inline; any
      // other type (HTML, XML… a mail attachment, a large upload) is a
      // download, and sandboxed in case a browser renders it anyway — it must
      // never run as this origin (ADR 0043 stage 4b, `fileContentPolicy.ts`).
      // An SVG is inline only when Oxy sanitized it (stage 4c) — with a CSP
      // that loads nothing and sandboxes a direct navigation; any other SVG
      // (a mail attachment kept byte for byte, a legacy row) is a download.
      const servedType = streamInfo.contentType ?? file.mime;
      const servedSvg = isSvgType(servedType) || servedType.toLowerCase().startsWith('image/svg');
      const inline = servedSvg
        ? isSanitizedSvgFile(file) && storageKey === file.storageKey
        : contentDispositionFor(servedType) === 'inline';
      const policy = inline ? contentSecurityPolicyFor(servedType) : ATTACHMENT_CSP;
      if (!inline) res.setHeader('Content-Disposition', 'attachment');
      if (policy) res.setHeader('Content-Security-Policy', policy);
      res.setHeader('X-Content-Type-Options', 'nosniff');
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
        file.visibility === 'public' ? 'public, max-age=3600' : 'private, max-age=3600',
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
          res.setHeader('Content-Security-Policy', SVG_PLACEHOLDER_CSP);
          res.setHeader('Cache-Control', 'no-store');
          return res.status(200).end(svg);
        }
        throw new NotFoundError('File not found');
      }
      throw streamError;
    }
  }),
);

/**
 * @route GET /api/assets/:id/download
 * @desc Redirect to the signed file URL (suitable for <img src> and direct downloads)
 * @access Public (with optional authentication for private files)
 */
router.get(
  '/:id/download',
  validate({ params: assetIdParams }),
  optionalAuthMiddleware,
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
    // Resolve viewer from the scoped `?mt=` media token for direct-download links
    // that cannot carry an Authorization header or cookie (owners downloading
    // their own private files). Access is still gated by canUserAccessFile below.
    const userId = getMediaViewerUserId(req);
    const { id: fileId } = req.params;
    const { variant, expiresIn } = req.query;

    // Get file and check permissions. Never a file in trash or deleted (D5).
    const file = await assetService.getFile(fileId);
    if (!file || !isServableStatus(file)) {
      throw new NotFoundError('File not found');
    }

    // Check access permissions
    if (!(await assetService.canUserAccessFile(file, userId))) {
      logger.warn('Access denied to file download', {
        fileId,
        userId,
        visibility: file.visibility,
      });
      throw new ForbiddenError('Access denied');
    }

    const variantType = singleQueryValue(variant);
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
    const mediaToken =
      cdnUrl || file.visibility === 'public' || !userId
        ? undefined
        : signMediaToken(fileId, userId);
    const url = cdnUrl ?? buildOriginStreamUrl(req, fileId, variantType, mediaToken);
    res.setHeader('Cache-Control', 'private, max-age=60');
    return sendAssetRedirect(res, url);
  }),
);

/**
 * @route POST /api/assets/:id/trash
 * @desc The owner moves their own file to trash (ADR 0043 D5): it stops being
 *       served at once (and leaves the CDN), stays in the owner's files with
 *       `status: 'trash'` and `trashedAt`, and is kept until the owner
 *       restores (`POST /:id/restore`) or deletes it — an account's trash
 *       never expires. Every application using the file is told
 *       `file.trashed` (D9). Already in trash: answered as it is. Any other
 *       caller, and a deleted file, get 404.
 * @access Private — the file's owner only
 */
router.post(
  '/:id/trash',
  ownAssetAuth,
  validate({ params: assetIdParams }),
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
    const user = req.user;
    if (!user?._id) {
      throw new UnauthorizedError('Authentication required');
    }

    const { id: fileId } = req.params;
    const existing = await assetService.getFile(fileId);
    if (!existing || existing.status === 'deleted' || !(await sessionOwnsFile(req, existing))) {
      throw new NotFoundError('File not found');
    }
    // `existing.ownerUserId` is set: `sessionOwnsFile` admits only an account's file.
    const ownerUserId = existing.ownerUserId as string;
    const file =
      existing.status === 'trash'
        ? existing
        : ((await assetService.trashFile(fileId, ownerUserId)) ??
          (await assetService.getFile(fileId)));
    if (!file || file.status !== 'trash') {
      throw new NotFoundError('File not found');
    }

    logger.info('File moved to trash', { userId: user._id, fileId });

    sendSuccess(res, {
      file: {
        id: file.id,
        status: file.status,
        trashedAt: file.trashedAt ?? null,
        usageCount: file.links.length,
      },
    });
  }),
);

/**
 * @route POST /api/assets/:id/restore
 * @desc Restore the owner's file from trash: `active` again, served again,
 *       `file.restored` to every application using it. 409
 *       `FILE_NOT_IN_TRASH` (with the file's `status`) for a file that is not
 *       in trash — restored or deleted meanwhile, or `blocked` after a content
 *       claim, which only a reinstated claim brings back (ADR 0043 D10).
 * @access Private — the file's owner only; any other caller gets 404
 */
router.post(
  '/:id/restore',
  ownAssetAuth,
  validate({ params: assetIdParams }),
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
    const user = req.user;
    if (!user?._id) {
      throw new UnauthorizedError('Authentication required');
    }

    const { id: fileId } = req.params;
    // Trash is the owner's: restoring is re-activating a file nobody else can
    // decide to bring back, and an answer at all would say the id exists.
    const existing = await assetService.getFile(fileId);
    if (!existing || !(await sessionOwnsFile(req, existing))) {
      throw new NotFoundError('File not found');
    }
    const file = await assetService.restoreFile(fileId);

    logger.info('File restored from trash', {
      userId: user._id,
      fileId,
    });

    sendSuccess(res, {
      file: {
        id: file.id,
        status: file.status,
        usageCount: file.links.length,
      },
    });
  }),
);

/**
 * @route PATCH /api/assets/:id/visibility
 * @desc Update file visibility
 * @access Private
 */
router.patch(
  '/:id/visibility',
  ownAssetAuth,
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
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

    if (visibility !== 'private' && (await isSupervised(user._id))) {
      throw new ForbiddenError('Supervised accounts keep their files private');
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
          updatedAt: file.updatedAt,
        },
      });
    }

    // Update visibility
    const updatedFile = await assetService.updateFileVisibility(
      fileId,
      visibility as FileVisibility,
    );

    logger.info('File visibility updated', {
      userId: user._id,
      fileId,
      visibility,
    });

    sendSuccess(res, {
      file: {
        id: updatedFile.id,
        visibility: updatedFile.visibility,
        updatedAt: updatedFile.updatedAt,
      },
    });
  }),
);

/**
 * @route DELETE /api/assets/:id
 * @desc Delete file with impact summary
 * @access Private
 */
router.delete(
  '/:id',
  ownAssetAuth,
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
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
        message: 'Use ?force=true to delete anyway',
      });
    }

    // Proceed with deletion
    await assetService.deleteFile(fileId, forceDelete, user._id);

    logger.info('File deleted', {
      userId: user._id,
      fileId,
      force: forceDelete,
      summary,
    });

    sendSuccess(res, {
      summary,
      message: 'File deleted successfully',
    });
  }),
);

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
router.post(
  '/batch-access',
  ownAssetAuth,
  validate({ body: batchAccessSchema }),
  asyncHandler(async (req: AuthenticatedRequest, res: express.Response) => {
    const user = req.user;
    const {
      files: requests,
      expiresIn,
      context: rawContext,
    } = req.body as {
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
    const supervisionPolicy = await createSupervisedAssetPolicy(
      fetched.map((file) => file.ownerUserId),
      user?._id,
    );

    const results: Record<string, BatchAccessResult> = {};

    await Promise.all(
      requests.map(async ({ fileId, variant }) => {
        const file = filesById.get(fileId);
        // A file in trash or deleted is never served (ADR 0043 D5).
        if (!file || !isServableStatus(file)) {
          results[fileId] = { allowed: false, error: 'File not found' };
          return;
        }

        if (!(await assetService.canUserAccessFile(file, user?._id, context, supervisionPolicy))) {
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
        const mediaToken =
          cdnUrl || file.visibility === 'public' || !user?._id
            ? undefined
            : signMediaToken(fileId, user._id);
        const url = cdnUrl ?? buildOriginStreamUrl(req, fileId, variant, mediaToken);
        results[fileId] = {
          allowed: true,
          url,
          visibility: file.visibility,
          mime: file.mime,
        };
      }),
    );

    sendSuccess(res, { results });
  }),
);

export default router;
