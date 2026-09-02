/**
 * Authenticated Oxy Updates publish/admin API (`/updates/v1/...`). Called by the
 * `oxy-ship` CLI (service token) and the console Updates tab (user bearer). No
 * CSRF — every write is bearer-authenticated (service JWT or user session token),
 * never an ambient cookie credential.
 *
 * Dual authorization, resolved per request against the target `applicationId`:
 *  - Service token: must carry the `updates:publish` scope AND its `appId` claim
 *    must equal the target application (a credential can only publish to its own
 *    app).
 *  - User bearer: must hold the `updates:manage` application permission, derived
 *    from the caller's effective account role over the app's owning account.
 */

import express from 'express';
import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import {
  assetInitRequestSchema,
  assetCompleteRequestSchema,
  createUpdateRequestSchema,
  rollbackRequestSchema,
  rollbackToEmbeddedRequestSchema,
  promoteRequestSchema,
  updateRolloutPatchSchema,
} from '@oxyhq/contracts';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import { verifyServiceToken, type ServiceTokenPayload } from '../middleware/serviceToken';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { asyncHandler, sendSuccess } from '../utils/asyncHandler';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../utils/error';
import { logger } from '../utils/logger';
import { getDb } from '../config/postgres';
import { applications } from '../db/schema';
import { accountService } from '../services/account.service';
import { appPermissionsForAccountAccess } from '../utils/accountRoles';
import { resolveOperatorId } from '../middleware/operator';
import * as publishService from '../services/updates/publish.service';

const router = express.Router();

/** Request augmented by {@link authenticatePrincipal} with the resolved principal. */
interface UpdatesAdminRequest extends AuthRequest {
  serviceApp?: ServiceTokenPayload;
}

const writeLimiter = rateLimit({
  prefix: 'rl:updates:publish:',
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many update publish operations. Please slow down.',
  keyGenerator: (req: express.Request) => `updates:publish:${hashedIpKey(req)}`,
});

const readLimiter = rateLimit({
  prefix: 'rl:updates:read:',
  windowMs: 60 * 1000,
  max: 240,
  message: 'Too many update read operations. Please slow down.',
  keyGenerator: (req: express.Request) => `updates:read:${hashedIpKey(req)}`,
});

/**
 * Authenticate the caller as EITHER a service token OR a user session. A valid
 * `service`-type JWT sets `req.serviceApp`; anything else falls through to the
 * standard user-session middleware. App-level authorization is deferred to
 * {@link authorizeForApp} (it needs the target applicationId from the body).
 */
function authenticatePrincipal(
  req: UpdatesAdminRequest,
  res: express.Response,
  next: express.NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length);
    const verification = verifyServiceToken(token);
    if (verification.ok) {
      req.serviceApp = verification.payload;
      next();
      return;
    }
  }
  // Not a service token → require a user session.
  void authMiddleware(req, res, next);
}

/**
 * Enforce that the authenticated principal may manage updates for
 * `applicationId`.
 *
 * There is no id-shape guard: it existed only to keep a non-ObjectId string from
 * becoming a Mongoose `CastError`. An application id that names no row is a 404,
 * which Postgres answers for any string.
 */
async function authorizeForApp(req: UpdatesAdminRequest, applicationId: string): Promise<void> {
  if (req.serviceApp) {
    const scopes = req.serviceApp.scopes ?? [];
    if (!scopes.includes('updates:publish')) {
      throw new ForbiddenError('Missing required scope: updates:publish');
    }
    if (req.serviceApp.appId !== applicationId) {
      throw new ForbiddenError('Service credential is not authorized for this application');
    }
    return;
  }

  if (!req.user?._id) {
    throw new UnauthorizedError('Authentication required');
  }
  // The OPERATOR's access over the owning account. A session acting as the
  // organization that owns the application is not a member of itself.
  const operatorId = await resolveOperatorId(req);
  const [application] = await getDb()
    .select({ ownerAccountId: applications.ownerAccountId })
    .from(applications)
    .where(and(eq(applications.id, applicationId), ne(applications.status, 'deleted')));
  if (!application) {
    throw new NotFoundError('Application not found');
  }
  const access = await accountService.resolveEffectiveAccess(
    operatorId,
    application.ownerAccountId
  );
  if (!access) {
    throw new ForbiddenError('You do not have access to this application');
  }
  // From the caller's EFFECTIVE account access, never their role: a per-member
  // revoke has to reach this gate too (issue #978). `updates:manage` answers to
  // `apps:update` — publishing an OTA update replaces the code the app ships,
  // so a member whose `apps:update` was withdrawn cannot keep doing it.
  if (!appPermissionsForAccountAccess(access).includes('updates:manage')) {
    throw new ForbiddenError('Missing required permission: updates:manage');
  }
}

/** Parse a body against a contract schema, or throw a 400 ValidationError. */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ValidationError('Invalid request data', { details: result.error.errors });
  }
  return result.data;
}

router.use(authenticatePrincipal);

// ============================================================================
// Assets
// ============================================================================

router.post(
  '/assets/init',
  writeLimiter,
  asyncHandler(async (req: UpdatesAdminRequest, res) => {
    const body = parseBody(assetInitRequestSchema, req.body);
    await authorizeForApp(req, body.applicationId);
    const result = await publishService.initAssets(body.applicationId, body.assets);
    sendSuccess(res, result);
  })
);

router.post(
  '/assets/complete',
  writeLimiter,
  asyncHandler(async (req: UpdatesAdminRequest, res) => {
    const body = parseBody(assetCompleteRequestSchema, req.body);
    await authorizeForApp(req, body.applicationId);
    const result = await publishService.completeAssets(body.applicationId, body.sha256s);
    sendSuccess(res, result);
  })
);

// ============================================================================
// Updates
// ============================================================================

router.post(
  '/updates',
  writeLimiter,
  asyncHandler(async (req: UpdatesAdminRequest, res) => {
    const body = parseBody(createUpdateRequestSchema, req.body);
    await authorizeForApp(req, body.applicationId);
    const update = await publishService.createUpdate(body);
    sendSuccess(res, { update });
  })
);

router.patch(
  '/updates/:updateId',
  writeLimiter,
  asyncHandler(async (req: UpdatesAdminRequest, res) => {
    const body = parseBody(updateRolloutPatchSchema, req.body);
    await authorizeForApp(req, body.applicationId);
    const update = await publishService.setRollout(
      body.applicationId,
      req.params.updateId,
      body.rolloutPercent
    );
    sendSuccess(res, { update });
  })
);

// ============================================================================
// Channel lifecycle
// ============================================================================

router.post(
  '/channels/:channel/rollback',
  writeLimiter,
  asyncHandler(async (req: UpdatesAdminRequest, res) => {
    const body = parseBody(rollbackRequestSchema, req.body);
    await authorizeForApp(req, body.applicationId);
    const result = await publishService.rollback(
      body.applicationId,
      req.params.channel,
      body.runtimeVersion,
      body.platform
    );
    sendSuccess(res, result);
  })
);

router.post(
  '/channels/:channel/rollback-to-embedded',
  writeLimiter,
  asyncHandler(async (req: UpdatesAdminRequest, res) => {
    const body = parseBody(rollbackToEmbeddedRequestSchema, req.body);
    await authorizeForApp(req, body.applicationId);
    const channel = await publishService.rollbackToEmbedded(
      body.applicationId,
      req.params.channel,
      body.runtimeVersion,
      body.platform
    );
    sendSuccess(res, { channel });
  })
);

router.post(
  '/channels/:channel/promote',
  writeLimiter,
  asyncHandler(async (req: UpdatesAdminRequest, res) => {
    const body = parseBody(promoteRequestSchema, req.body);
    await authorizeForApp(req, body.applicationId);
    const update = await publishService.promote(
      body.applicationId,
      body.updateId,
      body.toChannel ?? req.params.channel,
      body.rolloutPercent
    );
    sendSuccess(res, { update });
  })
);

// ============================================================================
// Reads
// ============================================================================

/** Shared query schema for the read endpoints — applicationId is required. */
const readQuerySchema = z.object({
  applicationId: z.string().min(1),
  runtimeVersion: z.string().min(1).optional(),
  platform: z.enum(['ios', 'android']).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

router.get(
  '/channels',
  readLimiter,
  asyncHandler(async (req: UpdatesAdminRequest, res) => {
    const query = parseBody(readQuerySchema, req.query);
    await authorizeForApp(req, query.applicationId);
    const channels = await publishService.listChannels(query.applicationId);
    sendSuccess(res, { channels });
  })
);

router.get(
  '/channels/:channel/updates',
  readLimiter,
  asyncHandler(async (req: UpdatesAdminRequest, res) => {
    const query = parseBody(readQuerySchema, req.query);
    await authorizeForApp(req, query.applicationId);
    const updates = await publishService.listUpdates(
      query.applicationId,
      req.params.channel,
      query.runtimeVersion,
      query.platform,
      query.limit
    );
    sendSuccess(res, { updates });
  })
);

router.get(
  '/updates',
  readLimiter,
  asyncHandler(async (req: UpdatesAdminRequest, res) => {
    const query = parseBody(readQuerySchema, req.query);
    await authorizeForApp(req, query.applicationId);
    const updates = await publishService.listUpdates(
      query.applicationId,
      undefined,
      query.runtimeVersion,
      query.platform,
      query.limit
    );
    sendSuccess(res, { updates });
  })
);

logger.debug('Oxy Updates admin routes registered');

export default router;
