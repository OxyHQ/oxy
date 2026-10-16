/**
 * `/content-claims` — rights and privacy claims, and the takedown (ADR 0041
 * D10).
 *
 * - `POST /` is PUBLIC: the Oxy website's "Report content / rights claim" page
 *   (`oxy.so/transparency/legal`) posts here, signed in or not. A valid bearer
 *   records the submitting account; none is needed. CORS is the registry's
 *   (`config/cors.ts`): `oxy.so` is a first-party application origin. Limited
 *   per IP ({@link SUBMIT_PER_IP}) and per claimant email
 *   ({@link SUBMIT_PER_EMAIL}), 429 with `Retry-After`.
 * - Everything else is the staff review, behind the `content:claims` staff
 *   capability (`middleware/requireStaff.ts`): the queue, a claim in full (the
 *   claimant's statement opened), and the actions on it.
 * - `GET /:id/targets/:targetId/content` streams a claimed file to a reviewer
 *   on a short-lived token the review minted (`claimPreviewToken.ts`) — a
 *   blocked or private file is otherwise served to nobody.
 */

import express, { type Request, type Response } from 'express';
import {
  CONTENT_CLAIM_ERROR_CODES,
  CONTENT_CLAIM_LIMITS,
  type ContentClaimSubmission,
  type ContentClaimValidationKey,
  contentClaimSubmissionSchema,
} from '@oxy.so/contracts';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { optionalAuthMiddleware } from '../middleware/optionalAuth';
import { rateLimit } from '../middleware/rateLimiter';
import { hasStaffCapability, requireStaffCapability } from '../middleware/requireStaff';
import { validate } from '../middleware/validate';
import {
  contentClaimAttachTargetsSchema,
  contentClaimBlockSchema,
  contentClaimIdParamsSchema,
  contentClaimListQuerySchema,
  contentClaimOptionalNoteSchema,
  contentClaimPreviewQuerySchema,
  contentClaimRejectSchema,
  contentClaimRequiredNoteSchema,
  contentClaimTargetParamsSchema,
  type ContentClaimListQuery,
} from '../schemas/contentClaims.schemas';
import { s3Service } from '../services/s3ServiceSingleton';
import {
  CLAIM_PREVIEW_TOKEN_PARAM,
  signClaimPreviewToken,
  verifyClaimPreviewToken,
} from '../services/contentClaims/claimPreviewToken';
import {
  addContentClaimNote,
  attachClaimTargets,
  blockClaimTargets,
  findClaimTarget,
  getContentClaim,
  listContentClaims,
  recordCounterNotice,
  reinstateContentClaim,
  rejectContentClaim,
  startContentClaimReview,
  submitContentClaim,
  upholdContentClaim,
} from '../services/contentClaims/contentClaim.service';
import { OXY_API_HOSTS } from '../services/contentClaims/contentClaimUrls';
import { findFileById } from '../services/fileRepository';
import { asyncHandler } from '../utils/asyncHandler';
import { ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/error';
import { hashedIpKey } from '../utils/ipKey';
import { logger } from '../utils/logger';
import { SERVER_KEY_LABELS, serverHmacHex } from '../utils/serverKey';

const router = express.Router();

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Reports one network may file per hour. */
export const SUBMIT_PER_IP = 10;
/** Reports one claimant email may file per day. */
export const SUBMIT_PER_EMAIL = 5;

const RATE_LIMITED_MESSAGE = 'Too many reports in a short time. Try again later.';

const submitIpLimiter = rateLimit({
  prefix: 'rl:content-claims:submit:ip:',
  windowMs: HOUR_MS,
  max: SUBMIT_PER_IP,
  message: RATE_LIMITED_MESSAGE,
  keyGenerator: (req: Request): string => `content-claims:submit:ip:${hashedIpKey(req)}`,
});

/**
 * Keyed by the claimant's email as an HMAC under its own server key — the
 * address never reaches Redis. Runs AFTER validation, so `req.body` is the
 * parsed submission.
 */
const submitEmailLimiter = rateLimit({
  prefix: 'rl:content-claims:submit:email:',
  windowMs: DAY_MS,
  max: SUBMIT_PER_EMAIL,
  message: RATE_LIMITED_MESSAGE,
  keyGenerator: (req: Request): string =>
    `content-claims:submit:email:${serverHmacHex(
      SERVER_KEY_LABELS.contentClaimRateLimit,
      (req.body as ContentClaimSubmission).claimant.email.trim().toLowerCase(),
    )}`,
});

const staffLimiter = rateLimit({
  prefix: 'rl:content-claims:staff:',
  windowMs: 15 * 60 * 1000,
  max: 600,
  keyGenerator: (req: Request): string => {
    const userId = (req as AuthRequest).user?._id;
    return userId
      ? `content-claims:staff:${userId}`
      : `content-claims:staff:ip:${hashedIpKey(req)}`;
  },
});

const requireClaimsCapability = requireStaffCapability('content:claims');

/** Each validation key, as the sentence the API answers for it. */
const VALIDATION_MESSAGES: Record<ContentClaimValidationKey, string> = {
  'contentClaim.errors.kind': 'Choose what you are reporting.',
  'contentClaim.errors.contentUrlsRequired': 'Add at least one link to the content.',
  'contentClaim.errors.contentUrlsTooMany': `Add no more than ${CONTENT_CLAIM_LIMITS.maxUrls} links.`,
  'contentClaim.errors.contentUrlInvalid':
    'Each link must be a full address that starts with https://.',
  'contentClaim.errors.descriptionShort': `Describe the content in at least ${CONTENT_CLAIM_LIMITS.minDescription} characters.`,
  'contentClaim.errors.descriptionLong': `Keep the description to ${CONTENT_CLAIM_LIMITS.maxDescription} characters or fewer.`,
  'contentClaim.errors.originalWorkUrl': 'Enter a full address that starts with https://.',
  'contentClaim.errors.name': 'Enter your full name.',
  'contentClaim.errors.email': 'Enter an email we can reply to.',
  'contentClaim.errors.organization': `Keep the organization name to ${CONTENT_CLAIM_LIMITS.maxOrganization} characters or fewer.`,
  'contentClaim.errors.relationship': 'Choose your relationship to the content.',
  'contentClaim.errors.goodFaith': 'Confirm the good-faith statement.',
  'contentClaim.errors.accurate': 'Confirm that the information is accurate.',
  'contentClaim.errors.signature': 'Type your full name as your signature.',
};

function sentenceFor(message: string): string {
  return (VALIDATION_MESSAGES as Record<string, string>)[message] ?? 'This value is not valid.';
}

/**
 * Parse the submission; on failure answer `400 { error, code, fields }` —
 * `fields` maps each body path (`claimant.email`, `contentUrls.3`) to one
 * sentence, the shape the website maps onto its form.
 */
function validateSubmission(req: Request, res: Response, next: express.NextFunction): void {
  const parsed = contentClaimSubmissionSchema.safeParse(req.body ?? {});
  if (parsed.success) {
    req.body = parsed.data;
    next();
    return;
  }
  const fields: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'body';
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        const keyPath = path === 'body' ? key : `${path}.${key}`;
        fields[keyPath] ??= 'This field is not part of a report.';
      }
      continue;
    }
    fields[path] ??= sentenceFor(issue.message);
  }
  res.status(400).json({
    error: 'Some details of your report need attention.',
    code: CONTENT_CLAIM_ERROR_CODES.invalid,
    fields,
  });
}

/** The hosts this API answers on: the request's own and the canonical ones. */
function apiHostsFor(req: Request): string[] {
  const own = req.get('host');
  return [...OXY_API_HOSTS, ...(own ? [own.toLowerCase()] : [])];
}

/**
 * @openapi
 * /content-claims:
 *   post:
 *     tags: [Safety]
 *     summary: Report content, or make a rights or privacy claim
 *     security:
 *       - {}
 *       - bearerAuth: []
 *     description: >
 *       Public. The Oxy website's "Report content" page posts here; a valid
 *       bearer records the submitting account but is not needed. A person
 *       reviews every claim. The claimant gets a confirmation email with the
 *       reference. Limited per network (10 an hour) and per claimant email
 *       (5 a day); over that, 429 with `Retry-After`. A privacy claim by the
 *       affected person is a GDPR erasure request and is answered within 30
 *       days. The body is `contentClaimSubmissionSchema` in `@oxy.so/contracts`.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [kind, contentUrls, description, claimant, statements, signature]
 *             additionalProperties: false
 *             properties:
 *               kind: { type: string, enum: [copyright, trademark, privacy, illegal_content, other] }
 *               contentUrls:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 20
 *                 items: { type: string, format: uri, maxLength: 2048, description: An https URL }
 *               description: { type: string, minLength: 20, maxLength: 5000 }
 *               originalWorkUrl: { type: string, format: uri, maxLength: 2048 }
 *               claimant:
 *                 type: object
 *                 required: [name, email, relationship]
 *                 additionalProperties: false
 *                 properties:
 *                   name: { type: string, minLength: 1, maxLength: 200 }
 *                   email: { type: string, format: email, maxLength: 254 }
 *                   organization: { type: string, maxLength: 200 }
 *                   relationship: { type: string, enum: [rights_holder, authorized_agent, affected_person, other] }
 *               statements:
 *                 type: object
 *                 required: [goodFaith, accurate]
 *                 additionalProperties: false
 *                 properties:
 *                   goodFaith: { type: boolean, enum: [true] }
 *                   accurate: { type: boolean, enum: [true] }
 *               signature: { type: string, minLength: 1, maxLength: 200 }
 *     responses:
 *       201:
 *         description: Received.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               required: [id, reference]
 *               properties:
 *                 id: { type: string }
 *                 reference: { type: string, example: OXY-7K3M-9Q2D }
 *       400:
 *         description: >
 *           The claim has errors: `{ error, code: CONTENT_CLAIM_INVALID, fields }`,
 *           `fields` mapping each body path to a sentence.
 *       429:
 *         description: Too many reports from this network or this email; see `Retry-After`.
 */
router.post(
  '/',
  submitIpLimiter,
  optionalAuthMiddleware,
  validateSubmission,
  submitEmailLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const created = await submitContentClaim(req.body as ContentClaimSubmission, {
      submittedByUserId: req.user?._id ?? null,
      apiHosts: apiHostsFor(req),
    });
    res.status(201).json(created);
  }),
);

/**
 * Whether the signed-in account may review claims — the console asks before it
 * shows the queue. Answers `{ canReview }` to anyone signed in; never a 403.
 */
router.get(
  '/access',
  authMiddleware,
  staffLimiter,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?._id;
    if (!userId) throw new UnauthorizedError();
    res.json({ canReview: await hasStaffCapability(userId, 'content:claims') });
  }),
);

/**
 * Streams a claimed file to the reviewer a preview token was minted for —
 * whatever the file's status (blocked, trashed, private, or deleted with its
 * bytes held as evidence). Never cached, never interpreted by the browser as
 * anything but the file.
 */
router.get(
  '/:id/targets/:targetId/content',
  validate({ params: contentClaimTargetParamsSchema, query: contentClaimPreviewQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id, targetId } = req.params as { id: string; targetId: string };
    const token = String((req.query as Record<string, unknown>)[CLAIM_PREVIEW_TOKEN_PARAM] ?? '');
    const granted = verifyClaimPreviewToken(token, { claimId: id, targetId });
    if (!granted) throw new ForbiddenError('This preview link is not valid or has expired');
    // Still a reviewer: a revoked capability ends a preview within its link's life.
    if (!(await hasStaffCapability(granted.userId, 'content:claims'))) {
      throw new ForbiddenError('This preview link is not valid or has expired');
    }
    const target = await findClaimTarget(id, targetId);
    if (!target || target.fileId !== granted.fileId) throw new NotFoundError('No such file');
    const file = await findFileById(granted.fileId);
    if (!file) throw new NotFoundError('No such file');
    let object: Awaited<ReturnType<typeof s3Service.getObjectStreamRange>>;
    try {
      object = await s3Service.getObjectStreamRange(file.storageKey);
    } catch (error) {
      logger.warn('[ContentClaims] Preview object unavailable', {
        claimId: id,
        fileId: file.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new NotFoundError('The bytes of this file are no longer stored');
    }
    res.setHeader('Content-Type', file.mime);
    if (object.contentLength !== undefined)
      res.setHeader('Content-Length', String(object.contentLength));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.status(200);
    (object.body as NodeJS.ReadableStream).pipe(res);
  }),
);

// Everything below is the staff review.
router.use(authMiddleware, staffLimiter, requireClaimsCapability);

/**
 * The queue. `state` and `kind` filter (comma-separated); `deadline`
 * (`overdue`, `due_soon`, `any`) lists only open erasure requests, soonest due
 * first. Otherwise newest first. Paged by the opaque `cursor`.
 */
router.get(
  '/',
  validate({ query: contentClaimListQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as unknown as ContentClaimListQuery;
    res.json(
      await listContentClaims({
        states: query.state,
        kinds: query.kind,
        deadline: query.deadline,
        limit: query.limit,
        cursor: query.cursor,
      }),
    );
  }),
);

/** One claim in full: the claimant's statement, every target, the audit trail. */
router.get(
  '/:id',
  validate({ params: contentClaimIdParamsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await getContentClaim(req.params.id));
  }),
);

function actor(req: AuthRequest): string {
  const userId = req.user?._id;
  if (!userId) throw new UnauthorizedError();
  return userId;
}

/** `received → reviewing`. */
router.post(
  '/:id/review',
  validate({ params: contentClaimIdParamsSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await startContentClaimReview(req.params.id, { actorUserId: actor(req) });
    res.json(await getContentClaim(req.params.id));
  }),
);

/** Attach files by id (what a page URL shows). */
router.post(
  '/:id/targets',
  validate({ params: contentClaimIdParamsSchema, body: contentClaimAttachTargetsSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = req.body as { fileIds: string[]; url?: string };
    const result = await attachClaimTargets(req.params.id, {
      actorUserId: actor(req),
      fileIds: body.fileIds,
      url: body.url ?? null,
    });
    res.json({ ...result, claim: await getContentClaim(req.params.id) });
  }),
);

/** A short-lived link to preview one target's file. */
router.post(
  '/:id/targets/:targetId/preview',
  validate({ params: contentClaimTargetParamsSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id, targetId } = req.params as { id: string; targetId: string };
    const target = await findClaimTarget(id, targetId);
    if (!target?.fileId) throw new NotFoundError('This target names no file');
    const { token, expiresAt } = signClaimPreviewToken({
      claimId: id,
      targetId,
      fileId: target.fileId,
      userId: actor(req),
    });
    const url = new URL(
      `${req.protocol}://${req.get('host') ?? ''}${req.baseUrl}/${encodeURIComponent(id)}/targets/${encodeURIComponent(targetId)}/content`,
    );
    url.searchParams.set(CLAIM_PREVIEW_TOKEN_PARAM, token);
    res.json({ url: url.toString(), expiresAt: expiresAt.toISOString() });
  }),
);

/** Block targets (all unblocked file targets when `targetIds` is absent). */
router.post(
  '/:id/block',
  validate({ params: contentClaimIdParamsSchema, body: contentClaimBlockSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = req.body as { targetIds?: string[]; note?: string };
    const result = await blockClaimTargets(req.params.id, {
      actorUserId: actor(req),
      targetIds: body.targetIds,
      note: body.note,
    });
    res.json({ ...result, claim: await getContentClaim(req.params.id) });
  }),
);

/** `received | reviewing → rejected`; the reason is sent to the claimant. */
router.post(
  '/:id/reject',
  validate({ params: contentClaimIdParamsSchema, body: contentClaimRejectSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await rejectContentClaim(req.params.id, {
      actorUserId: actor(req),
      reason: (req.body as { reason: string }).reason,
    });
    res.json(await getContentClaim(req.params.id));
  }),
);

/** `actioned → counter_noticed`; the note (staff's summary) is sent to the claimant. */
router.post(
  '/:id/counter-notice',
  validate({ params: contentClaimIdParamsSchema, body: contentClaimRequiredNoteSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await recordCounterNotice(req.params.id, {
      actorUserId: actor(req),
      note: (req.body as { note: string }).note,
    });
    res.json(await getContentClaim(req.params.id));
  }),
);

/** `counter_noticed → reinstated`: this claim's blocks are lifted. */
router.post(
  '/:id/reinstate',
  validate({ params: contentClaimIdParamsSchema, body: contentClaimOptionalNoteSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await reinstateContentClaim(req.params.id, {
      actorUserId: actor(req),
      note: (req.body as { note?: string }).note,
    });
    res.json({ ...result, claim: await getContentClaim(req.params.id) });
  }),
);

/** `counter_noticed → upheld`: the blocks stand. */
router.post(
  '/:id/uphold',
  validate({ params: contentClaimIdParamsSchema, body: contentClaimOptionalNoteSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await upholdContentClaim(req.params.id, {
      actorUserId: actor(req),
      note: (req.body as { note?: string }).note,
    });
    res.json(await getContentClaim(req.params.id));
  }),
);

/** A note on the audit trail. */
router.post(
  '/:id/notes',
  validate({ params: contentClaimIdParamsSchema, body: contentClaimRequiredNoteSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    await addContentClaimNote(req.params.id, {
      actorUserId: actor(req),
      note: (req.body as { note: string }).note,
    });
    res.json(await getContentClaim(req.params.id));
  }),
);

export default router;
