/**
 * User Routes
 * 
 * RESTful API routes for user management, following enterprise-grade patterns:
 * - Separation of concerns (routes -> service -> model)
 * - Consistent error handling
 * - Standardized response formats
 * - Comprehensive validation
 * - Proper logging
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { safeFetch, SsrfRejection } from '@oxyhq/core/server';
import { canonicalFederationHost, isSameFederationHost } from '@oxyhq/federation';
import { readBoundedBody } from '../services/linkPreview/boundedBody';
import { getDb } from '../config/postgres';
import { identityBackups } from '../db/schema/identityBackups';
import { users } from '../db/schema/users';
import { authMiddleware, serviceAuthMiddleware, type ServiceAuthRequest } from '../middleware/auth';
import { logger } from '../utils/logger';
import { asyncHandler, sendSuccess, sendPaginated } from '../utils/asyncHandler';
import {
  FOLLOW_GRAPH_SORTS,
  isFollowGraphSort,
  type FollowGraphSort,
} from '../types/user.types';
import {
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  BadRequestError,
} from '../utils/error';
import { userService } from '../services/user.service';
import graphCache from '../utils/graphCache';
import { assetService } from '../services/assetServiceSingleton';
import { UsersController } from '../controllers/users.controller';
import { resolveUserIdToObjectId, isAccountIdFormat } from '../utils/validation';
import userCache from '../utils/userCache';
import SignatureService from '../services/signature.service';
import { emailService } from '../services/email.service';
import { validate } from '../middleware/validate';
import {
  optionalUserOrServiceAuth,
  resolveViewerId,
  type OptionalUserOrServiceRequest,
} from '../middleware/optionalAuth';
import {
  searchUsersBodySchema,
  verifyRequestSchema,
  deleteAccountSchema,
  dataExportQuerySchema,
  identityExportQuerySchema,
  updatePrivacyBodySchema,
  usersByIdsBodySchema,
} from '../schemas/users.schemas';
import { sanitizePlainText } from '../utils/sanitize';
import { cleanDisplayName } from '../utils/displayNameSanitize';
import { rateLimit } from '../middleware/rateLimiter';
import { hashedIpKey } from '../utils/ipKey';
import { buildExportBundle } from '../services/identityExport.service';
import { exportBundleSchema } from '@oxyhq/contracts';
import sessionService from '../services/session.service';
import deviceSessionService from '../services/deviceSession.service';

// Types
interface AuthRequest extends Request {
  user?: {
    id: string;
  };
}

interface PaginationQuery {
  limit?: string;
  offset?: string;
}

/** Pagination plus the follow-graph `sort` accepted by the list endpoints. */
interface FollowGraphQuery extends PaginationQuery {
  sort?: string;
}

// Maximum number of users that can be followed in a single bulk request.
const MAX_BULK_FOLLOW = 200;

const getUserIdsFromRequestBody = (body: unknown): unknown => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }

  return (body as { userIds?: unknown }).userIds;
};

import { PAGINATION } from '../utils/constants';
import { MAX_MUTUAL_IDS, MAX_FOLLOWS_OF_FOLLOWS_IDS } from '../utils/recommendationWeights';
import { bridgeVouchesForNetwork } from '../config/federationBridgeTrust';
import { federationService, isOwnFederationDomain } from '../services/federation.service';
import { isPublicGraphTarget } from '../utils/profileQuery';

// Initialize router and controller
const router = Router();
const usersController = new UsersController();

// ============================================================================
// Middleware
// ============================================================================

/**
 * Resolves userId parameter (ObjectId or publicKey) to MongoDB ObjectId
 * Accepts both ObjectId strings and publicKey strings
 * Stores the resolved ObjectId back in req.params.userId
 */
/** 404 when the target user is archived, restricted, or private — same gate as /similar. */
async function assertDiscoverableTargetUser(userId: string): Promise<void> {
  const user = await userService.getPublicUserById(userId);
  if (!isPublicGraphTarget(user)) {
    throw new NotFoundError('User not found');
  }
}

const resolveUserId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { userId } = req.params;
    
    if (!userId) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: 'User ID is required',
      });
      return;
    }

    // Resolve userId (ObjectId or publicKey) to ObjectId
    const resolvedObjectId = await resolveUserIdToObjectId(userId);
    
    // Store the resolved ObjectId back in params for route handlers
    req.params.userId = resolvedObjectId;
    
    next();
  } catch (error) {
    if (error instanceof BadRequestError) {
      res.status(400).json({
        error: 'BAD_REQUEST',
        message: error.message,
      });
      return;
    }
    if (error instanceof NotFoundError) {
      res.status(404).json({
        error: 'NOT_FOUND',
        message: error.message,
      });
      return;
    }
    logger.error('Error resolving user ID', error instanceof Error ? error : new Error(String(error)));
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Error resolving user ID',
    });
  }
};

/**
 * Validates pagination query parameters
 */
const validatePagination = (req: Request, res: Response, next: NextFunction): void => {
  const query = req.query as PaginationQuery;
  const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined;
  const offset = query.offset ? Number.parseInt(query.offset, 10) : undefined;

  if (limit !== undefined && (isNaN(limit) || limit < 0)) {
    res.status(400).json({
      error: 'BAD_REQUEST',
      message: 'Invalid limit parameter',
    });
    return;
  }

  if (offset !== undefined && (isNaN(offset) || offset < 0)) {
    res.status(400).json({
      error: 'BAD_REQUEST',
      message: 'Invalid offset parameter',
    });
    return;
  }

  next();
};

/**
 * Validates the optional `sort` query parameter on the follow-graph list
 * endpoints. Absent ⇒ the server default (`recent`); anything outside the
 * supported vocabulary is rejected rather than silently coerced, so a client
 * asking for an ordering we do not implement finds out instead of quietly
 * receiving a different one.
 */
const validateFollowGraphSort = (req: Request, res: Response, next: NextFunction): void => {
  const { sort } = req.query as FollowGraphQuery;

  if (sort !== undefined && !isFollowGraphSort(sort)) {
    res.status(400).json({
      error: 'INVALID_SORT',
      message: `sort must be one of: ${FOLLOW_GRAPH_SORTS.join(', ')}`,
    });
    return;
  }

  next();
};

/** Read the validated `sort` off a request. Undefined ⇒ the service default. */
const readFollowGraphSort = (req: Request): FollowGraphSort | undefined => {
  const { sort } = req.query as FollowGraphQuery;
  return isFollowGraphSort(sort) ? sort : undefined;
};

/**
 * Ensures authenticated user owns the resource or is authorized
 * Note: This middleware should be used after resolveUserId, so req.params.userId is already an ObjectId
 * We need to resolve req.user.id (which might be a publicKey) to ObjectId for comparison
 */
const requireOwnership = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    const userId = req.params.userId; // Already resolved to ObjectId by resolveUserId middleware
    const currentUserId = req.user?.id;

    if (!currentUserId) {
      throw new UnauthorizedError('Authentication required');
    }

    // Resolve current user's ID to ObjectId for comparison (it might be a publicKey)
    const currentUserObjectId = await resolveUserIdToObjectId(currentUserId);

    if (userId !== currentUserObjectId) {
      throw new ForbiddenError('Not authorized to access this resource');
    }

    next();
  } catch (error) {
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      throw error;
    }
    logger.error('Error in requireOwnership middleware', error instanceof Error ? error : new Error(String(error)));
    throw new ForbiddenError('Error validating ownership');
  }
};

// ============================================================================
// Routes
// ============================================================================

/**
 * @openapi
 * /users/me:
 *   get:
 *     tags:
 *       - Users
 *     summary: Get the current authenticated user
 *     description: >
 *       Returns the full profile for the bearer-token holder, including
 *       privacy settings, identity flags, and connected account types. This
 *       is the canonical "who am I" endpoint that every Oxy app calls on
 *       startup.
 *     responses:
 *       200:
 *         description: Current user profile.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *             examples:
 *               success:
 *                 value:
 *                   id: 64f7c2a1b8e9d3f4a1c2b3d4
 *                   username: alice
 *                   name:
 *                     first: Alice
 *                     last: Example
 *                   description: Coffee, code, and open source.
 *                   type: local
 *                   _count:
 *                     followers: 42
 *                     following: 17
 *                   createdAt: '2024-01-15T12:34:56.789Z'
 *                   updatedAt: '2025-05-12T09:00:00.000Z'
 *       401:
 *         description: Missing or invalid bearer token.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get(
  '/me',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user?.id) {
      throw new UnauthorizedError('Authentication required');
    }

    const user = await userService.getCurrentUser(req.user.id);

    if (!user) {
      throw new NotFoundError('User not found');
    }

    logger.debug('GET /users/me', { userId: req.user.id });
    sendSuccess(
      res,
      userService.formatUserResponse(user, undefined, { includePrivateFields: true })
    );
  })
);

/**
 * @openapi
 * /users/me:
 *   put:
 *     tags:
 *       - Users
 *     summary: Update the current authenticated user
 *     description: >
 *       Partial profile update for the authenticated user. Only fields
 *       supplied in the body are touched — missing fields keep their existing
 *       values. The server enforces uniqueness on `email` and `username`;
 *       conflicts return 409. Always invalidates the in-memory user cache so
 *       the next read returns the updated record.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username:
 *                 type: string
 *                 minLength: 3
 *                 maxLength: 30
 *                 pattern: '^[a-zA-Z0-9]{3,30}$'
 *                 example: alice
 *               email:
 *                 type: string
 *                 format: email
 *                 example: alice@placeholder.example
 *               name:
 *                 type: object
 *                 properties:
 *                   first:
 *                     type: string
 *                     example: Alice
 *                   last:
 *                     type: string
 *                     example: Example
 *               description:
 *                 type: string
 *                 example: Updated bio.
 *               avatar:
 *                 type: string
 *                 description: Asset ID or absolute URL.
 *                 example: 64f7c2a1b8e9d3f4a1c2b3d4
 *           examples:
 *             rename:
 *               summary: Update the display name
 *               value:
 *                 name:
 *                   first: Alice
 *                   last: Example
 *     responses:
 *       200:
 *         description: Updated user profile.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       400:
 *         description: Validation failed.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Missing or invalid bearer token.
 *       409:
 *         description: Email or username conflict.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.put(
  '/me',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.user?.id) {
      throw new UnauthorizedError('Authentication required');
    }

    // Validate request body
    if (!req.body || typeof req.body !== 'object') {
      throw new BadRequestError('Invalid request body');
    }

    logger.debug('PUT /users/me', {
      userId: req.user.id,
      updateFields: Object.keys(req.body),
    });

    try {
      const updatedUser = await userService.updateUserProfile(
        req.user.id,
        req.body,
        req
      );

      // Profile media (avatar/banner) must be publicly viewable: an <img> can't
      // send a bearer token, so a private asset renders as a 403 placeholder.
      // Promote owned assets set as profile media to public (owner-gated,
      // best-effort — never blocks the profile update).
      for (const field of ['avatar', 'banner', 'coverPhoto'] as const) {
        const mediaFileId = (req.body as Record<string, unknown>)[field];
        if (typeof mediaFileId === 'string' && mediaFileId) {
          await assetService.ensureOwnedAssetPublic(mediaFileId, req.user.id);
        }
      }

      logger.info('User profile updated', {
        userId: req.user.id,
        updatedFields: Object.keys(req.body),
      });

      sendSuccess(
        res,
        userService.formatUserResponse(updatedUser, undefined, { includePrivateFields: true })
      );
    } catch (error) {
      // Handle known errors from service layer
      if (error instanceof Error) {
        if (error.message === 'Email already exists') {
          throw new ConflictError('Email already exists', {
            field: 'email',
            value: req.body.email,
          });
        }
        if (error.message === 'Username already exists') {
          throw new ConflictError('Username already exists', {
            field: 'username',
            value: req.body.username,
          });
        }
        if (error.message === 'User not found') {
          throw new NotFoundError('User not found');
        }
      }
      throw error;
    }
  })
);

/**
 * POST /users/follow/bulk
 *
 * Follow many users in a single request. Follow-only and idempotent — users
 * already followed stay followed and are never unfollowed. One bad/invalid id
 * never fails the whole batch; every supplied id gets a per-target result.
 *
 * Registered BEFORE the `/:userId` param routes so Express never treats
 * `follow` as a `:userId` value.
 *
 * @body {string[]} userIds - Target user ids to follow (max MAX_BULK_FOLLOW).
 * @returns {object} `{ message, results, followedCount }` where `results` is a
 *   per-target list of `{ userId, success, alreadyFollowing }` and
 *   `followedCount` counts only NEWLY created follows.
 */
router.post(
  '/follow/bulk',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const currentUserId = req.user?.id;

    if (!currentUserId) {
      throw new UnauthorizedError('Authentication required');
    }

    const userIds = getUserIdsFromRequestBody(req.body);

    if (!Array.isArray(userIds)) {
      throw new BadRequestError('userIds must be an array');
    }
    if (userIds.length === 0) {
      throw new BadRequestError('userIds must not be empty');
    }
    if (userIds.length > MAX_BULK_FOLLOW) {
      throw new BadRequestError(`Cannot follow more than ${MAX_BULK_FOLLOW} users at once`);
    }

    const result = await userService.bulkFollow(currentUserId, userIds);

    logger.info('Users bulk followed', {
      currentUserId,
      requested: userIds.length,
      followedCount: result.followedCount,
    });

    sendSuccess(res, {
      message: 'Bulk follow processed',
      results: result.results,
      followedCount: result.followedCount,
    });
  })
);

/**
 * POST /users/unfollow/bulk
 *
 * Unfollow many users in a single request. Unfollow-only and idempotent — ids
 * that are not currently followed are left untouched and reported as already in
 * the desired (not-following) state. One bad/invalid id never fails the whole
 * batch; every supplied id gets a per-target result.
 *
 * Registered BEFORE the `/:userId` param routes so Express never treats
 * `unfollow` as a `:userId` value.
 *
 * @body {string[]} userIds - Target user ids to unfollow (max MAX_BULK_FOLLOW).
 * @returns {object} `{ message, results, unfollowedCount }` where `results` is a
 *   per-target list of `{ userId, success, wasFollowing }` and `unfollowedCount`
 *   counts only follows that were actually removed.
 */
router.post(
  '/unfollow/bulk',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const currentUserId = req.user?.id;

    if (!currentUserId) {
      throw new UnauthorizedError('Authentication required');
    }

    const userIds = getUserIdsFromRequestBody(req.body);

    if (!Array.isArray(userIds)) {
      throw new BadRequestError('userIds must be an array');
    }
    if (userIds.length === 0) {
      throw new BadRequestError('userIds must not be empty');
    }
    if (userIds.length > MAX_BULK_FOLLOW) {
      throw new BadRequestError(`Cannot unfollow more than ${MAX_BULK_FOLLOW} users at once`);
    }

    const result = await userService.bulkUnfollow(currentUserId, userIds);

    logger.info('Users bulk unfollowed', {
      currentUserId,
      requested: userIds.length,
      unfollowedCount: result.unfollowedCount,
    });

    sendSuccess(res, {
      message: 'Bulk unfollow processed',
      results: result.results,
      unfollowedCount: result.unfollowedCount,
    });
  })
);

/**
 * POST /users/follow-status/bulk
 *
 * Resolve the authenticated viewer's follow status for MANY target users in a
 * single request. Built for list UIs (a page of N FollowButtons) that would
 * otherwise fire N `GET /users/:id/follow-status` calls — this collapses them
 * into one round-trip served by a single indexed query.
 *
 * Registered BEFORE the `/:userId` param routes so Express never treats
 * `follow-status` as a `:userId` value.
 *
 * @body {string[]} userIds - Target user ids to check (max MAX_BULK_FOLLOW).
 * @returns {{ statuses: Record<string, boolean> }} Every requested id mapped to
 *   whether the viewer follows it; unknown/unfollowed ids are `false`.
 */
router.post(
  '/follow-status/bulk',
  authMiddleware,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const currentUserId = req.user?.id;

    if (!currentUserId) {
      throw new UnauthorizedError('Authentication required');
    }

    const userIds = getUserIdsFromRequestBody(req.body);

    if (!Array.isArray(userIds)) {
      throw new BadRequestError('userIds must be an array');
    }
    if (userIds.length === 0) {
      throw new BadRequestError('userIds must not be empty');
    }
    if (userIds.length > MAX_BULK_FOLLOW) {
      throw new BadRequestError(`Cannot request more than ${MAX_BULK_FOLLOW} follow statuses at once`);
    }

    const statuses = await userService.getFollowingStatuses(currentUserId, userIds);

    logger.debug('POST /users/follow-status/bulk', {
      currentUserId,
      requested: userIds.length,
    });

    sendSuccess(res, { statuses });
  })
);

/**
 * POST /users/by-ids
 *
 * Batch-resolve PUBLIC user DTOs for up to 100 ids in a single round-trip.
 * Returns an array of the SAME shape as `GET /users/:id` — canonical
 * `name.displayName` (server-owned) plus `_count: { followers, following }` for
 * every resolved user. Built for server-to-server feed/notification hydration so
 * consumers (Mention) avoid N+1 single-user fetches.
 *
 * Registered BEFORE the `/:userId` param routes so Express never treats
 * `by-ids` as a `:userId` value.
 *
 * Auth: optional dual-auth — accepts a service token (the server-to-server case
 * Mention uses), a user session, or an anonymous caller. The payload is exactly
 * the already-public `GET /users/:id` profile data, so no scope is required and
 * no viewer-specific fields are returned. ids that are not valid ObjectIds (or
 * match no user) are dropped from the result.
 *
 * @body {string[]} ids - User ids to resolve (1..100; 400 if empty or > 100).
 * @returns {PublicUserProfile[]} Resolved public user DTOs (order not guaranteed).
 */
router.post(
  '/by-ids',
  optionalUserOrServiceAuth,
  validate({ body: usersByIdsBodySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { ids } = req.body as { ids: string[] };

    const users = await userService.getUsersByIds(ids);

    logger.debug('POST /users/by-ids', { requested: ids.length, resolved: users.length });
    sendSuccess(res, users);
  })
);

/**
 * GET /users/mutual-ids
 *
 * The authenticated VIEWER's OWN mutual-follow user ids — the accounts the viewer
 * follows that ALSO follow the viewer back. Lean, ids-only, bounded payload built
 * to SEED Mention's "Mutuals" feed (which then hydrates and ranks the posts
 * itself), so it returns bare ids rather than the hydrated DTOs of
 * `GET /users/:userId/mutuals` ("followers you know" about ANOTHER profile).
 *
 * The viewer is derived SERVER-SIDE from the auth token via `resolveViewerId`
 * (the same dual-auth as `/mutuals` and `/by-ids`) — never a client-supplied id,
 * and there is no `:userId` param to spoof (anti-IDOR). OPTIONAL semantics: an
 * anonymous caller (or a service token with no user context) has no "you follow"
 * set → `{ data: [] }`.
 *
 * Registered BEFORE the `/:userId` param routes so Express never treats
 * `mutual-ids` as a `:userId` value.
 *
 * @query {number} limit - Max ids to return (capped at MAX_MUTUAL_IDS).
 * @returns {{ data: string[] }} The viewer's mutual-follow user ids.
 */
router.get(
  '/mutual-ids',
  optionalUserOrServiceAuth,
  validatePagination,
  asyncHandler(async (req: OptionalUserOrServiceRequest, res: Response) => {
    // Viewer is always the authenticated principal — never a client param.
    const viewerId = resolveViewerId(req);
    const { limit } = req.query as PaginationQuery;

    const parsedLimit = limit
      ? Math.min(Number.parseInt(limit, 10), MAX_MUTUAL_IDS)
      : MAX_MUTUAL_IDS;

    const ids = await userService.getMutualUserIds(viewerId, { limit: parsedLimit });

    logger.debug('GET /users/mutual-ids', {
      viewerId,
      limit: parsedLimit,
      count: ids.length,
    });

    sendSuccess(res, ids);
  })
);

/**
 * GET /users/follows-of-follows-ids
 *
 * The authenticated VIEWER's bounded "follows-of-follows" user ids — the union
 * of the accounts followed by the accounts the viewer follows (a two-hop walk of
 * the follow graph), MINUS the viewer's own follows and the viewer themselves.
 * Lean, ids-only, bounded payload built to SEED Mention's friends-of-friends
 * feed (which then hydrates and ranks the posts itself), so it returns bare ids
 * rather than hydrated DTOs. Candidates are ordered by frequency (accounts
 * followed by more of the viewer's follows first), then recency.
 *
 * The viewer is derived SERVER-SIDE from the auth token via `resolveViewerId`
 * (the same dual-auth as `/mutual-ids` and `/by-ids`) — never a client-supplied
 * id, and there is no `:userId` param to spoof (anti-IDOR). OPTIONAL semantics:
 * an anonymous caller (or a service token with no user context) has no "you
 * follow" set → `{ data: [] }`.
 *
 * Registered BEFORE the `/:userId` param routes so Express never treats
 * `follows-of-follows-ids` as a `:userId` value.
 *
 * @query {number} limit - Max ids to return (capped at MAX_FOLLOWS_OF_FOLLOWS_IDS).
 * @returns {{ data: string[] }} The viewer's follows-of-follows user ids.
 */
router.get(
  '/follows-of-follows-ids',
  optionalUserOrServiceAuth,
  validatePagination,
  asyncHandler(async (req: OptionalUserOrServiceRequest, res: Response) => {
    // Viewer is always the authenticated principal — never a client param.
    const viewerId = resolveViewerId(req);
    const { limit } = req.query as PaginationQuery;

    const parsedLimit = limit
      ? Math.min(Number.parseInt(limit, 10), MAX_FOLLOWS_OF_FOLLOWS_IDS)
      : MAX_FOLLOWS_OF_FOLLOWS_IDS;

    const ids = await userService.getFollowsOfFollowsIds(viewerId, { limit: parsedLimit });

    logger.debug('GET /users/follows-of-follows-ids', {
      viewerId,
      limit: parsedLimit,
      count: ids.length,
    });

    sendSuccess(res, ids);
  })
);

/**
 * GET /users/me/graph
 *
 * The authenticated VIEWER's OWN social graph — the accounts they follow, the
 * subset who follow back (mutuals), and the accounts they have blocked — as ONE
 * ids-only payload `{ followingIds, mutualIds, blockedIds, restrictedIds }`. Consolidates the
 * three per-viewer graph reads consuming apps (Mention, Allo, Homiio) otherwise
 * make as separate round trips on nearly every feed request.
 *
 * The viewer is derived SERVER-SIDE from the authenticated user session via
 * `resolveViewerId` — never a client-supplied id, and there is no `:userId`
 * param to spoof (anti-IDOR). Service-token delegation is intentionally not
 * accepted because blocks and restrictions are private relationship data.
 * OPTIONAL semantics: an anonymous or service-token caller has no graph →
 * every list is empty.
 *
 * Backed by a short-TTL Redis cache (`graphCache`) filled on miss and busted by
 * the follow/unfollow/block/unblock write paths; degrades to a straight Mongo
 * recompute when Redis is unconfigured.
 *
 * Registered as a two-segment `/me/graph` path (distinct from the single-segment
 * `/:userId` param route) so Express never treats it as a `:userId` value.
 *
 * @returns {ViewerGraph} `{ followingIds, mutualIds, blockedIds, restrictedIds }`.
 */
router.get(
  '/me/graph',
  optionalUserOrServiceAuth,
  asyncHandler(async (req: OptionalUserOrServiceRequest, res: Response) => {
    // This endpoint returns private relationship data (blocks/restrictions), so
    // only a user session may select its viewer. Service delegation is limited
    // to public personalization and must not turn X-Oxy-User-Id into access to
    // another user's private graph.
    const viewerId = req.serviceApp ? undefined : resolveViewerId(req);

    // Anonymous / no-user-context callers have no graph. Short-circuit with the
    // empty graph and never touch the cache (its keys are strictly per-viewer).
    if (!viewerId) {
      sendSuccess(res, { followingIds: [], mutualIds: [], blockedIds: [], restrictedIds: [] });
      return;
    }

    const cached = await graphCache.get(viewerId);
    if (cached) {
      sendSuccess(res, cached);
      return;
    }

    const graph = await userService.getViewerGraph(viewerId);
    await graphCache.set(viewerId, graph);

    logger.debug('GET /users/me/graph', {
      viewerId,
      following: graph.followingIds.length,
      mutuals: graph.mutualIds.length,
      blocked: graph.blockedIds.length,
    });

    sendSuccess(res, graph);
  })
);

/**
 * GET /users/:userId
 *
 * Get user profile by ID
 *
 * @param {string} userId - User ID
 * @returns {User} User profile with statistics
 */
router.get(
  '/:userId',
  optionalUserOrServiceAuth,
  resolveUserId,
  asyncHandler(async (req: OptionalUserOrServiceRequest, res: Response) => {
    const { userId } = req.params;

    const user = await userService.getPublicUserById(userId);

    if (
      !user ||
      user.accountStatus === 'archived' ||
      user.reputationTier === 'restricted'
    ) {
      throw new NotFoundError('User not found');
    }

    // Get user statistics
    const stats = await userService.getUserStats(userId);

    // Format response with stats
    const response = userService.formatUserResponse(user, stats);

    // Viewer-relative relationship: computed in the SAME handler (no second
    // round-trip) from the Follow model when the request is authenticated.
    // `userId` is already resolved to the canonical ObjectId by `resolveUserId`.
    // OMITTED for anonymous requests and for a self-view.
    const viewerId = resolveViewerId(req);
    if (viewerId && viewerId !== userId) {
      response.relationship = await userService.getViewerRelationship(viewerId, userId);
    }

    logger.debug('GET /users/:userId', { userId });
    sendSuccess(res, response);
  })
);

/**
 * GET /users/:userId/followers
 * 
 * Get user's followers with pagination
 * 
 * @param {string} userId - User ID
 * @query {number} limit - Number of results (max 100, default 50)
 * @query {number} offset - Pagination offset (default 0)
 * @query {string} sort - `recent` (default) or `oldest`
 * @returns {PaginatedResponse<PublicUserProfile>} Paginated list of followers
 */
router.get(
  '/:userId/followers',
  resolveUserId,
  validatePagination,
  validateFollowGraphSort,
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;
    const { limit, offset } = req.query as FollowGraphQuery;
    const sort = readFollowGraphSort(req);

    const parsedLimit = limit
      ? Math.min(Number.parseInt(limit, 10), PAGINATION.MAX_LIMIT)
      : PAGINATION.DEFAULT_LIMIT;
    const parsedOffset = offset ? Number.parseInt(offset, 10) : 0;

    await assertDiscoverableTargetUser(userId);

    const result = await userService.getUserFollowers(userId, {
      limit: parsedLimit,
      offset: parsedOffset,
      sort,
    });

    logger.debug('GET /users/:userId/followers', {
      userId,
      limit: parsedLimit,
      offset: parsedOffset,
      sort,
      total: result.total,
    });

    sendPaginated(res, result.data, result.total, result.limit, result.offset);
  })
);

/**
 * GET /users/:userId/following
 * 
 * Get users that this user is following with pagination
 * 
 * @param {string} userId - User ID
 * @query {number} limit - Number of results (max 100, default 50)
 * @query {number} offset - Pagination offset (default 0)
 * @query {string} sort - `recent` (default) or `oldest`
 * @returns {PaginatedResponse<PublicUserProfile>} Paginated list of following
 */
router.get(
  '/:userId/following',
  resolveUserId,
  validatePagination,
  validateFollowGraphSort,
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = req.params;
    const { limit, offset } = req.query as FollowGraphQuery;
    const sort = readFollowGraphSort(req);

    const parsedLimit = limit
      ? Math.min(Number.parseInt(limit, 10), PAGINATION.MAX_LIMIT)
      : PAGINATION.DEFAULT_LIMIT;
    const parsedOffset = offset ? Number.parseInt(offset, 10) : 0;

    await assertDiscoverableTargetUser(userId);

    const result = await userService.getUserFollowing(userId, {
      limit: parsedLimit,
      offset: parsedOffset,
      sort,
    });

    logger.debug('GET /users/:userId/following', {
      userId,
      limit: parsedLimit,
      offset: parsedOffset,
      sort,
      total: result.total,
    });

    sendPaginated(res, result.data, result.total, result.limit, result.offset);
  })
);

/**
 * GET /users/:userId/mutuals
 *
 * "Followers you know" — the MUTUAL followers between the authenticated viewer
 * and the target user: users U such that the VIEWER follows U AND U follows
 * :userId.
 *
 * The viewer is derived SERVER-SIDE from the auth token (never a client-supplied
 * param) via `resolveViewerId`, the same dual-auth viewer resolution the
 * recommendation surfaces use. OPTIONAL semantics — the request is never
 * rejected: an anonymous caller (or a service token with no user context) has no
 * "you follow" set, so the response is an empty page; a self-target
 * (`:userId === viewer`) is likewise empty. The empty/self guards live in the
 * service so the route stays thin.
 *
 * @param {string} userId - Target user ID (ObjectId or publicKey; resolved first)
 * @query {number} limit - Number of results (max 100, default 50)
 * @query {number} offset - Pagination offset (default 0)
 * @query {string} sort - `recent` (default) or `oldest`
 * @returns {PaginatedResponse<PublicUserProfile>} Paginated list of mutual followers
 */
router.get(
  '/:userId/mutuals',
  optionalUserOrServiceAuth,
  resolveUserId,
  validatePagination,
  validateFollowGraphSort,
  asyncHandler(async (req: OptionalUserOrServiceRequest, res: Response) => {
    const { userId } = req.params;
    const { limit, offset } = req.query as FollowGraphQuery;
    const sort = readFollowGraphSort(req);

    // Viewer is always the authenticated principal — never a client param.
    const viewerId = resolveViewerId(req);

    const parsedLimit = limit
      ? Math.min(Number.parseInt(limit, 10), PAGINATION.MAX_LIMIT)
      : PAGINATION.DEFAULT_LIMIT;
    const parsedOffset = offset ? Number.parseInt(offset, 10) : 0;

    await assertDiscoverableTargetUser(userId);

    const result = await userService.getUserMutuals(viewerId, userId, {
      limit: parsedLimit,
      offset: parsedOffset,
      sort,
    });

    logger.debug('GET /users/:userId/mutuals', {
      viewerId,
      userId,
      limit: parsedLimit,
      offset: parsedOffset,
      sort,
      total: result.total,
    });

    sendPaginated(res, result.data, result.total, result.limit, result.offset);
  })
);

/**
 * GET /users/:userId/follow-status
 *
 * Check if current user is following target user
 *
 * @param {string} userId - Target user ID
 * @returns {boolean} Following status
 */
router.get(
  '/:userId/follow-status',
  authMiddleware,
  resolveUserId,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { userId: targetUserId } = req.params;
    const currentUserId = req.user?.id;

    if (!currentUserId) {
      throw new UnauthorizedError('Authentication required');
    }

    const isFollowing = await userService.isFollowing(currentUserId, targetUserId);

    logger.debug('GET /users/:userId/follow-status', {
      currentUserId,
      targetUserId,
      isFollowing,
    });

    sendSuccess(res, { isFollowing });
  })
);

/**
 * POST /users/:userId/follow
 * 
 * Toggle follow relationship (follow if not following, unfollow if following)
 * 
 * @param {string} userId - Target user ID to follow/unfollow
 * @returns {object} Action result with updated counts
 */
router.post(
  '/:userId/follow',
  authMiddleware,
  resolveUserId,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { userId: targetUserId } = req.params;
    const currentUserId = req.user?.id;

    if (!currentUserId) {
      throw new UnauthorizedError('Authentication required');
    }

    try {
      const result = await userService.toggleFollow(currentUserId, targetUserId);

      logger.info('User follow toggled', {
        currentUserId,
        targetUserId,
        action: result.action,
      });

      sendSuccess(res, {
        message: `Successfully ${result.action === 'follow' ? 'followed' : 'unfollowed'} user`,
        action: result.action,
        counts: result.counts,
      });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Cannot follow yourself') {
          throw new BadRequestError('Cannot follow yourself');
        }
        if (error.message === 'User not found') {
          throw new NotFoundError('User not found');
        }
      }
      throw error;
    }
  })
);

/**
 * DELETE /users/:userId/follow
 * 
 * Unfollow a user
 * 
 * @param {string} userId - Target user ID to unfollow
 * @returns {object} Action result with updated counts
 */
router.delete(
  '/:userId/follow',
  authMiddleware,
  resolveUserId,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { userId: targetUserId } = req.params;
    const currentUserId = req.user?.id;

    if (!currentUserId) {
      throw new UnauthorizedError('Authentication required');
    }

    // Check if currently following
    const isFollowing = await userService.isFollowing(currentUserId, targetUserId);

    if (!isFollowing) {
      throw new BadRequestError('Not following this user');
    }

    // Toggle will unfollow since we know they're following
    const result = await userService.toggleFollow(currentUserId, targetUserId);

    logger.info('User unfollowed', {
      currentUserId,
      targetUserId,
    });

    sendSuccess(res, {
      message: 'Successfully unfollowed user',
      action: result.action,
      counts: result.counts,
    });
  })
);

/**
 * PUT /users/:userId/privacy
 * 
 * Update user privacy settings (requires ownership)
 * 
 * @param {string} userId - User ID
 * @body {object} privacySettings - Privacy settings object
 * @returns {User} Updated user object
 */
router.put(
  '/:userId/privacy',
  authMiddleware,
  resolveUserId,
  requireOwnership,
  validate({ body: updatePrivacyBodySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { userId } = req.params;

    if (!req.body?.privacySettings || typeof req.body.privacySettings !== 'object') {
      throw new BadRequestError('Invalid privacy settings');
    }

    // Merge only the provided fields. Replacing the whole settings object would
    // wipe every toggle the client did not include, which is what Mongo's
    // dot-path `$set` existed to avoid; the service owns that merge and the
    // userCache invalidation that keeps the next session read fresh.
    const incoming = req.body.privacySettings as Record<string, unknown>;
    const updatedSettings = await userService.updatePrivacySettings(userId, incoming);
    if (!updatedSettings) {
      throw new NotFoundError('User not found');
    }

    const updatedUser = await userService.getUserById(userId);
    if (!updatedUser) {
      throw new NotFoundError('User not found');
    }

    logger.info('User privacy settings updated', { userId });

    sendSuccess(
      res,
      userService.formatUserResponse(updatedUser, undefined, { includePrivateFields: true }),
    );
  })
);

/**
 * POST /users/search
 * 
 * Search for users by username or name
 * 
 * @body {string} query - Search query
 * @returns {User[]} Array of matching users
 */
router.post(
  '/search',
  validate({ body: searchUsersBodySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    await usersController.searchUsers(req, res, () => {});
  })
);

/**
 * POST /users/verify/request
 * 
 * Request account verification
 * 
 * @body {string} reason - Reason for verification request
 * @body {string} [evidence] - Optional evidence/documentation
 * @returns {object} Confirmation with request ID
 */
router.post(
  '/verify/request',
  authMiddleware,
  validate({ body: verifyRequestSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const { reason, evidence } = req.body;
    if (!reason || typeof reason !== 'string') {
      throw new BadRequestError('Reason is required for verification request');
    }

    // Create verification request (in a real app, you'd save this to a database)
    const requestId = `VERIFY-${Date.now()}-${userId}`;
    
    // For now, we'll just log it. In production, you'd save this to a VerificationRequest model
    logger.info('Account verification requested', {
      userId,
      requestId,
      reason,
      hasEvidence: !!evidence,
    });

    sendSuccess(res, {
      message: 'Verification request submitted successfully',
      requestId,
      status: 'pending',
    });
  })
);

/**
 * GET /users/me/data
 * 
 * Download account data export
 * 
 * @query {string} [format] - Export format: 'json' or 'csv' (default: 'json')
 * @returns {Blob} Account data file
 */
router.get(
  '/me/data',
  authMiddleware,
  validate({ query: dataExportQuerySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const format = (req.query.format as string) || 'json';
    // `readAccountDocument` selects through `publicColumns(users)`, so the
    // protected set — the raw phone, the contact-discovery hashes, the refresh
    // token, and the private mail configuration — is absent by construction
    // rather than by a `-field` exclusion someone has to remember.
    const safeUserData = await userService.readAccountDocument(userId);

    if (!safeUserData) {
      throw new NotFoundError('User not found');
    }

    let data: string;
    let contentType: string;
    let filename: string;

    if (format === 'csv') {
      // Convert to CSV format (simplified - you'd want a proper CSV library)
      const fields = Object.keys(safeUserData);
      const valuesByField = Object.entries(safeUserData);
      const headers = fields.join(',');
      const values = valuesByField.map(([, value]) => {
        if (typeof value === 'object') {
          return JSON.stringify(value);
        }
        return String(value || '');
      }).join(',');
      data = `${headers}\n${values}`;
      contentType = 'text/csv';
      filename = `account-data-${Date.now()}.csv`;
    } else {
      data = JSON.stringify(safeUserData, null, 2);
      contentType = 'application/json';
      filename = `account-data-${Date.now()}.json`;
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(data);

    logger.info('Account data exported', { userId, format });
  })
);

/**
 * Per-user rate limiter for the signed identity export (5/hour). The export
 * assembles the full account snapshot and signs it — it is intentionally
 * expensive, so it is throttled per authenticated user.
 */
const identityExportLimiter = rateLimit({
  prefix: 'rl:identity:export:',
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many export requests. Please try again later.',
  keyGenerator: (req) => {
    const userId = (req as AuthRequest).user?.id;
    return userId ? `identity:export:${userId}` : `identity:export:ip:${hashedIpKey(req)}`;
  },
});

/**
 * GET /users/me/export
 *
 * Signed, open-format self-sovereign data export ("credible exit"). Returns the
 * `ExportBundle` (DID document, profile, verified domains, auth methods, signed
 * records, app data, social graph) sealed with an Oxy provenance attestation.
 * `?format=ndjson` streams each section as newline-delimited JSON for large
 * accounts.
 */
router.get(
  '/me/export',
  authMiddleware,
  identityExportLimiter,
  validate({ query: identityExportQuerySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const result = await buildExportBundle(userId);
    if (!result) {
      throw new NotFoundError('User not found');
    }

    const { bundle, attestationMissing } = result;
    const format = (req.query.format as string) || 'json';
    const stamp = Date.now();

    if (format === 'ndjson') {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Content-Disposition', `attachment; filename="oxy-identity-export-${stamp}.ndjson"`);
      const writeLine = (obj: unknown) => res.write(`${JSON.stringify(obj)}\n`);
      writeLine({
        kind: 'meta',
        $schema: bundle['$schema'],
        exportedAt: bundle.exportedAt,
        did: bundle.did,
        didDocument: bundle.didDocument,
        profile: bundle.profile,
        verifiedDomains: bundle.verifiedDomains,
        authMethods: bundle.authMethods,
      });
      for (const record of bundle.signedRecords) writeLine({ kind: 'signedRecord', record });
      for (const item of bundle.appData) writeLine({ kind: 'appData', item });
      for (const did of bundle.social.following) writeLine({ kind: 'following', did });
      for (const did of bundle.social.followers) writeLine({ kind: 'follower', did });
      writeLine({ kind: 'attestation', attestation: bundle.attestation });
      res.end();
      logger.info('Signed identity export streamed', { userId, format, attestationMissing });
      return;
    }

    // Validate the producer output against the published contract. Both the
    // signed bundle and the no-key bundle (`attestation: null`, now that the
    // contract's attestation is nullable) MUST conform.
    exportBundleSchema.parse(bundle);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="oxy-identity-export-${stamp}.json"`);
    res.json(bundle);
    logger.info('Signed identity export generated', { userId, format, attestationMissing });
  })
);

/**
 * @openapi
 * /users/me:
 *   delete:
 *     tags:
 *       - Users
 *     summary: Permanently delete the current account
 *     description: >
 *       Hard-delete the authenticated user's account. To prove identity at
 *       the time of deletion the client signs `delete:{publicKey}:{timestamp}`
 *       with the local secp256k1 private key (see `KeyManager.sign` in
 *       `@oxyhq/core`). The signature is rejected if it is older than 5
 *       minutes, if the confirmation text does not match the account's
 *       username, or if the account has no associated public key.
 *
 *       Successful deletion removes all mailboxes, messages, and S3
 *       attachments owned by the user.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - signature
 *               - timestamp
 *               - confirmText
 *             properties:
 *               signature:
 *                 type: string
 *                 description: Hex-encoded secp256k1 signature over `delete:{publicKey}:{timestamp}`.
 *                 example: 3045022100abcd...3045022100efgh
 *               timestamp:
 *                 type: integer
 *                 description: Unix milliseconds when the signature was produced.
 *                 example: 1714576800000
 *               confirmText:
 *                 type: string
 *                 description: Must equal the account's username.
 *                 example: alice
 *     responses:
 *       200:
 *         description: Account deleted.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Account deleted successfully
 *       400:
 *         description: Missing field, expired signature, or mismatched confirmText.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Invalid signature.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: User not found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.delete(
  '/me',
  authMiddleware,
  validate({ body: deleteAccountSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      throw new UnauthorizedError('Authentication required');
    }

    const { signature, timestamp, confirmText } = req.body;
    
    if (!signature || !timestamp) {
      throw new BadRequestError('Signature and timestamp are required to delete account');
    }

    if (!confirmText) {
      throw new BadRequestError('Confirmation text is required');
    }

    const [user] = await getDb()
      .select({ publicKey: users.publicKey, username: users.username })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Verify user has a publicKey for signature verification
    if (!user.publicKey) {
      throw new BadRequestError('Account does not have an identity key for signature verification');
    }

    // Verify signature using SignatureService
    const message = `delete:${user.publicKey}:${timestamp}`;
    const isValidSignature = SignatureService.verifySignature(message, signature, user.publicKey);
    
    // Check timestamp is recent (within 5 minutes), allowing modest client clock skew
    if (!SignatureService.isTimestampFresh(timestamp)) {
      throw new BadRequestError('Signature has expired. Please try again.');
    }
    
    if (!isValidSignature) {
      throw new UnauthorizedError('Invalid signature');
    }

    // Verify confirmation text matches username
    if (confirmText !== user.username) {
      throw new BadRequestError('Confirmation text does not match username');
    }

    // Delete all email data (mailboxes, messages, S3 attachments)
    await emailService.deleteAllUserData(userId);

    // Drop any encrypted off-device identity backup for this account.
    await getDb().delete(identityBackups).where(eq(identityBackups.userId, userId));

    // Revoke every active session and detach the account from all device-session
    // docs so a deleted user cannot keep minting tokens from a retained secret.
    await sessionService.deactivateAllUserSessions(userId);
    await deviceSessionService.purgeAccountFromAllDevices(userId);

    // Remove follow edges, blocks, restrictions, and repair counterparty counts
    // before deleting the user document (mirrors federation actor-delete).
    await userService.purgeUserSocialGraph(userId);

    // Delete the account row. Every remaining edge that references it is
    // removed by its own foreign key; the graph purge above ran first because it
    // is what invalidates each counterparty's cached graph by name — a cascade
    // tells nobody whose graph just changed.
    await getDb().delete(users).where(eq(users.id, userId));

    userCache.invalidate(userId);
    await graphCache.invalidate(userId);

    logger.info('Account deleted', { userId, username: user.username });

    sendSuccess(res, {
      message: 'Account deleted successfully',
    });
  })
);

/**
 * PUT /users/resolve
 *
 * Find or create a non-local user (federated, agent, or automated).
 * Called by Oxy ecosystem services when they encounter an external user
 * that needs an Oxy identity. Requires a valid service token whose
 * Application has been granted the `federation:write` scope.
 *
 * Hardening (C4):
 *  - Scope check: rejects service tokens that lack `federation:write`.
 *  - Actor URI binding (http(s) ActivityPub actors only): `actorUri.hostname`
 *    must match the asserted `domain` (so a malicious service can't claim to
 *    vouch for a user on a host they don't actually own). AT Protocol (Bluesky)
 *    actors are identified by a hostless DID (`did:plc:`/`did:web:`); the DID is
 *    stored verbatim and the host-binding check is skipped for it.
 *  - Username squatting: for `agent` / `automated`, refuse to upsert when
 *    a `local` (or other-type) user already owns the username.
 *  - Type immutability: never let `type` change on an existing user — a
 *    federated user cannot be silently upgraded to an `agent`, etc.
 *
 * @body {'federated' | 'agent' | 'automated'} type
 * @body {string} username      - Unique username (e.g. "user@mastodon.social")
 * @body {string} [actorUri]    - Actor identifier (required for federated): an
 *                                http(s) ActivityPub actor URI, or an AT Protocol
 *                                DID (`did:plc:…` / `did:web:…`) for Bluesky actors
 * @body {string} [domain]      - Origin domain (required for federated): the
 *                                handle host (e.g. `bsky.social`) for atproto
 * @body {string} [displayName] - Display name
 * @body {string} [avatar]      - Avatar URL or asset ID
 * @body {string} [bio]         - Profile bio
 * @body {string} [ownerId]     - Owner user ID (for agent/automated)
 * @body {boolean} [refresh]            - When true, force re-downloading an http
 *                                        avatar even if a stored file id already
 *                                        exists (eventually-fresh refresh).
 * @body {boolean} [forceAvatarRefresh] - Alias for `refresh`; either truthy forces it.
 * @returns {User} The resolved user document
 */
interface ResolveUserBody {
  type?: unknown;
  username?: unknown;
  actorUri?: unknown;
  domain?: unknown;
  displayName?: unknown;
  avatar?: unknown;
  bio?: unknown;
  ownerId?: unknown;
  refresh?: unknown;
  forceAvatarRefresh?: unknown;
}

function normalizeFederatedResolveUsername(username: string): string | null {
  const cleaned = username.trim().replace(/^acct:/i, '').replace(/^@/, '');
  const atIndex = cleaned.indexOf('@');
  if (atIndex <= 0 || atIndex === cleaned.length - 1) return null;

  const localPart = cleaned.substring(0, atIndex).toLowerCase();
  const domain = canonicalFederationHost(cleaned.substring(atIndex + 1));
  if (!localPart || !domain) return null;

  return `${localPart}@${domain}`;
}

/**
 * AT Protocol (Bluesky) external actors are identified by a DID, not an http(s)
 * ActivityPub actor URL. atproto uses exactly two DID methods — `did:plc:` and
 * `did:web:` — and the DID is an opaque, globally-unique identifier with no host
 * to parse. The URL/hostname binding that guards http(s) AP actors is therefore
 * meaningless (and impossible) for a DID, so a DID actorUri is accepted and
 * stored verbatim as the federation dedup key. The `did:` scheme and method
 * name are lower-case per the DID spec; require a non-empty method-specific
 * identifier after the prefix.
 */
const ATPROTO_DID_ACTOR_URI = /^did:(?:plc|web):\S+$/;
function isAtprotoDidActorUri(actorUri: string): boolean {
  return ATPROTO_DID_ACTOR_URI.test(actorUri);
}

const WEBFINGER_MAX_BYTES = 64 * 1024;

async function verifyFederatedWebFingerBinding(username: string, actorUri: string): Promise<boolean> {
  const atIndex = username.indexOf('@');
  if (atIndex === -1 || atIndex === username.length - 1) return false;

  const domain = username.substring(atIndex + 1);
  const resource = `acct:${username}`;
  const url = `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(resource)}`;

  try {
    const result = await safeFetch(url, {
      headers: { Accept: 'application/jrd+json, application/json' },
      headersTimeoutMs: 10_000,
      signal: AbortSignal.timeout(10_000),
    });

    const { response, status } = result;
    try {
      if (status < 200 || status >= 300) return false;

      const body = await readBoundedBody(response, { maxBytes: WEBFINGER_MAX_BYTES });
      const data = JSON.parse(body) as {
        subject?: unknown;
        links?: Array<{ rel?: unknown; type?: unknown; href?: unknown }>;
      };
      const normalizedSubject = typeof data.subject === 'string'
        ? normalizeFederatedResolveUsername(data.subject.replace(/^acct:/, ''))
        : null;
      if (normalizedSubject !== username) return false;

      const selfLink = data.links?.find((link) => (
        link.rel === 'self'
        && typeof link.href === 'string'
        && (
          link.type === 'application/activity+json'
          || link.type === 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"'
        )
      ));

      return selfLink?.href === actorUri;
    } finally {
      response.destroy();
    }
  } catch (error) {
    if (error instanceof SsrfRejection) {
      logger.warn('Blocked federated WebFinger binding fetch', {
        username,
        actorUri,
        reason: error.message,
      });
      return false;
    }

    logger.warn('Failed to verify federated WebFinger binding', {
      username,
      actorUri,
      reason: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Dedicated per-app limiter for PUT /users/resolve — the federated/agent user
 * find-or-create that a relying app's connectors call in BULK during a backfill
 * (one resolve per unique external author), all through a single NAT egress IP.
 *
 * This path is EXEMPT from the global browser per-IP limiter (rl:general) and the
 * slowDown penalty (see `isServiceToServiceBulkRequest` in middleware/security),
 * because that per-IP browser budget — shared across ALL of the app's oxy-api
 * calls from one NAT IP — 429'd bulk resolves (the same failure mode as the
 * federation sign surface). This is therefore its dedicated budget. Keyed by the
 * calling service app id (never the shared NAT IP), sized like
 * `federationServiceLimiter` (60000/15min ≈ 66 req/s): generous enough for a
 * large author backfill, still bounding a runaway or compromised credential.
 * Applied AFTER serviceAuthMiddleware so `req.serviceApp` is populated for the key.
 */
const userResolveServiceLimiter = rateLimit({
  prefix: 'rl:user-resolve:service:',
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'development' ? 120000 : 60000,
  message: 'Too many federated-user resolve requests, please slow down.',
  keyGenerator: (req: Request) => {
    const appId = (req as ServiceAuthRequest).serviceApp?.appId;
    return appId ? `app:${appId}` : hashedIpKey(req);
  },
});

router.put(
  '/resolve',
  serviceAuthMiddleware,
  userResolveServiceLimiter,
  asyncHandler(async (req: ServiceAuthRequest, res: Response) => {
    // Scope gate — only service tokens explicitly granted `federation:write`
    // may create or update federated/agent/automated users.
    const scopes = req.serviceApp?.scopes ?? [];
    if (!scopes.includes('federation:write')) {
      throw new ForbiddenError('Missing required scope: federation:write');
    }

    const body = req.body as ResolveUserBody;
    const { type, username, actorUri, domain, displayName, avatar, bio, ownerId } = body;
    // Either flag (truthy) forces an http avatar to be re-downloaded, replacing
    // any existing stored file id. Mention passes `refresh: true` on its
    // scheduled federated-actor refresh.
    const forceAvatarRefresh = body.refresh === true || body.forceAvatarRefresh === true;

    const RESOLVE_USER_TYPES = ['federated', 'agent', 'automated'] as const;
    type ResolveUserType = (typeof RESOLVE_USER_TYPES)[number];
    const isResolveUserType = (value: unknown): value is ResolveUserType =>
      typeof value === 'string' && (RESOLVE_USER_TYPES as readonly string[]).includes(value);
    if (!isResolveUserType(type)) {
      throw new BadRequestError('type must be "federated", "agent", or "automated"');
    }
    if (!username || typeof username !== 'string') {
      throw new BadRequestError('username is required');
    }
    if (type !== 'federated' && ownerId !== undefined && ownerId !== null) {
      if (typeof ownerId !== 'string' || !isAccountIdFormat(ownerId)) {
        throw new BadRequestError('ownerId must be a valid user id');
      }
    }

    // Build the row predicate and the column payload — never touch auth fields.
    // `existingPredicate` is what Mongo expressed as an upsert FILTER; it stays a
    // predicate because the two branches key on different unique indexes.
    let existingPredicate: SQL;
    const setFields: Record<string, unknown> = { username };

    if (type === 'federated') {
      if (!actorUri || typeof actorUri !== 'string') {
        throw new BadRequestError('actorUri is required for federated users');
      }
      if (!domain || typeof domain !== 'string') {
        throw new BadRequestError('domain is required for federated users');
      }

      // AT Protocol (Bluesky) external actors are keyed by a DID
      // (`did:plc:…` / `did:web:…`) rather than an http(s) ActivityPub actor
      // URL. A DID carries no host, so the URL parse + hostname/WebFinger
      // binding below are AP-only and are skipped for it — the DID is stored
      // verbatim as the dedup key. The `domain` carried alongside is the handle
      // host (e.g. `bsky.social`) or the did:web host; it is stored as given and
      // we never try to parse a host out of the DID itself.
      const isDidActor = isAtprotoDidActorUri(actorUri);

      // Bind the actor URI hostname to the asserted domain so a service
      // can't claim "alice@mastodon.social" actually lives at
      // attacker.example. http(s) AP actors only — a DID has no host to bind.
      let actorHostname: string | null = null;
      if (!isDidActor) {
        try {
          actorHostname = new URL(actorUri).hostname.toLowerCase();
        } catch {
          throw new BadRequestError('actorUri must be a valid http(s) URL or a did: URI');
        }
      }
      const normalisedDomain = canonicalFederationHost(domain);
      const normalisedUsername = normalizeFederatedResolveUsername(username);
      if (!normalisedUsername) {
        throw new BadRequestError('username must be a valid federated handle');
      }
      const usernameDomain = normalisedUsername.substring(normalisedUsername.indexOf('@') + 1);
      if (!isSameFederationHost(usernameDomain, normalisedDomain)) {
        throw new BadRequestError('username domain does not match domain');
      }

      // Own-domain guard: a handle like `nate@oxy.so` is a NON-ENTITY. On Oxy's
      // own apex the only valid identity is the bare local handle (`nate`); the
      // domain-qualified form must never be created or returned through the
      // federated resolve path, so it can't masquerade as a second
      // representation of the local user. Reject — never mint a
      // `type:'federated'` shadow row and never resolve to the local user.
      if (isOwnFederationDomain(normalisedDomain)) {
        throw new BadRequestError('Cannot resolve a user on an own federation domain');
      }

      // http(s) AP host binding: the actor's host must match the asserted
      // domain (or the domain must vouch for the handle via WebFinger). DID
      // actors carry no host and are not WebFinger-resolvable, so this AP-only
      // check is skipped for them — the `federation:write` scope plus the
      // username↔domain binding above are the trust anchor for atproto actors.
      //
      // A BRIDGED identity is the one case where the two legitimately differ.
      // `@wired@bird.makeup` is not a person on bird.makeup; it is WIRED on X,
      // republished — so the actor URI's host is the bridge while the identity
      // belongs to `x.com`. WebFinger cannot settle that: X publishes none, and
      // no amount of asking bird.makeup would make it authoritative for x.com.
      //
      // So the question is answered from THIS service's own reviewed trust list
      // (`config/federationBridgeTrust`) — a decision the API makes, never one the
      // caller asserts, which is the entire point of the binding. The calling
      // connector keeps its own list; the two are deliberately separate and NOT
      // duplication — drift between them fails CLOSED in both directions, and
      // consolidating them would delete that. See the note in
      // `config/federationBridgeTrust` before "tidying" it.
      // `bridgeVouchesForNetwork` requires BOTH
      // halves to match, so a listed bridge can only ever claim the single
      // network it mirrors, and an unlisted host still cannot claim anything.
      // It is checked before the WebFinger probe purely because it is a local
      // lookup and that is a network round trip.
      if (
        actorHostname !== null
        && !isSameFederationHost(actorHostname, normalisedDomain)
        && !bridgeVouchesForNetwork(actorHostname, normalisedDomain)
        && !(await verifyFederatedWebFingerBinding(normalisedUsername, actorUri))
      ) {
        throw new BadRequestError('actorUri hostname does not match domain');
      }
      existingPredicate = eq(users.federationActorUri, actorUri);
      setFields.username = normalisedUsername;
      setFields.federationActorUri = actorUri;
      setFields.federationDomain = normalisedDomain;
      setFields.federationLastResolvedAt = new Date();
      // A successful resolve clears the tombstone. NULL is what "available"
      // means on these columns, so the Mongo `$unset` is a write of NULL.
      setFields.federationUnavailableAt = null;
      setFields.federationUnavailableReason = null;
    } else {
      // For agent / automated, refuse to clobber a username already taken
      // by a local user — that would be account takeover via the
      // federation pipeline.
      // Written against the EXPRESSION the unique index is built on
      // (`lower(btrim(username))`, `db/schema/users.ts`); a plain `username = $1`
      // is correct-looking, case-sensitive, and would miss a collision the
      // index would then reject as a 500.
      const [localCollision] = await getDb()
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            sql`lower(btrim(${users.username})) = lower(btrim(${username}))`,
            sql`${users.type} not in ('agent', 'automated')`
          )
        )
        .limit(1);
      if (localCollision) {
        throw new ConflictError('Username is already taken by a non-automated user');
      }
      existingPredicate = and(
        sql`lower(btrim(${users.username})) = lower(btrim(${username}))`,
        inArray(users.type, ['agent', 'automated'])
      ) ?? sql`false`;
      if (typeof ownerId === 'string') {
        setFields.automationOwnerId = ownerId;
      }
    }

    // Type immutability check: if a user already exists, its `type` must
    // match what the caller is asserting. We never allow a federated user
    // to be silently re-typed as an agent, or vice versa. The same read also
    // supplies the existing avatar file id below, so the two Mongo round trips
    // that asked the same question collapse into one.
    const [existingByFilter] = await getDb()
      .select({ id: users.id, type: users.type, avatar: users.avatar })
      .from(users)
      .where(existingPredicate)
      .limit(1);
    if (existingByFilter && existingByFilter.type !== type) {
      throw new ConflictError('Cannot change the type of an existing user');
    }

    // Clean free-text fields sourced from untrusted remote actors
    // (federated/agent/automated) before persisting. The bio renders as TEXT in
    // client apps, so we decode entities + strip tags (sanitizePlainText) rather
    // than HTML-entity-escape it — escaping would store a literal `&#x27;`/`&amp;`
    // that the client then double-renders. XSS protection comes from tag-
    // stripping here plus the client's text-rendering auto-escape, not entity
    // escaping. (See utils/sanitize.ts sanitizePlainText.)
    if (typeof displayName === 'string') {
      // Strip disallowed characters (emoji/symbols/shortcodes) from federated
      // names. cleanDisplayName's output can never contain an XSS vector and is
      // already clean, so it owns the name field here.
      // The COLUMN PROPERTY, not Mongo's `name.first` dot path: drizzle keys
      // `set()`/`values()` by property name and SILENTLY IGNORES a key that
      // names no column, so the dot path stored nothing at all and every
      // federated actor resolved through here landed with a null display name.
      setFields.nameFirst = cleanDisplayName(displayName);
    }
    if (typeof bio === 'string') {
      setFields.bio = sanitizePlainText(bio);
    }

    // Avatar handling splits two ways:
    //  - A raw http(s) URL is downloaded into an Oxy file OFF the request path
    //    (fire-and-forget after the upsert) so we never block the response on
    //    remote I/O. The avatar field may therefore lag one refresh cycle: the
    //    response carries the previous (or absent) avatar and the new file id
    //    lands shortly after. The scheduler throttles forced re-downloads and
    //    sends conditional (ETag / Last-Modified) requests.
    //  - A non-URL value is already a stored file id; set it synchronously.
    let remoteAvatarUrl: string | undefined;
    let existingAvatarFileId: string | undefined;
    if (typeof avatar === 'string' && avatar.startsWith('http')) {
      existingAvatarFileId = existingByFilter?.avatar ?? undefined;
      remoteAvatarUrl = avatar;
    } else if (typeof avatar === 'string') {
      // Non-URL avatar (already a file ID) — set directly
      setFields.avatar = avatar;
    }

    // `type` is written only on INSERT, never on update — the immutability
    // check above already rejected a mismatched update, and re-writing it would
    // make that check the only thing standing between a caller and a silent
    // re-type. Column DEFAULTs replace Mongoose's `setDefaultsOnInsert`.
    let resolvedUserId: string;
    if (existingByFilter) {
      await getDb().update(users).set(setFields).where(eq(users.id, existingByFilter.id));
      resolvedUserId = existingByFilter.id;
    } else {
      const [inserted] = await getDb()
        .insert(users)
        .values({ ...setFields, type })
        .returning({ id: users.id });
      if (!inserted) {
        throw new Error('Failed to resolve user');
      }
      resolvedUserId = inserted.id;
    }

    const user = await userService.readAccountDocument(resolvedUserId);
    if (!user) {
      throw new Error('Failed to resolve user');
    }

    // This route mutates user state (avatar/name/bio/federation fields), so the
    // in-memory user cache must be invalidated — otherwise getUserBySession can
    // serve a stale record and silently revert this update.
    userCache.invalidate(resolvedUserId);

    // Kick the remote avatar download off the request path. The scheduler
    // resolves the user fresh, honours the throttle + conditional requests, and
    // invalidates the cache again once the new file id is persisted. Never
    // awaited — must not delay the response.
    const hasExistingStoredAvatar = typeof existingAvatarFileId === 'string'
      && existingAvatarFileId.length > 0
      && !existingAvatarFileId.startsWith('http');
    if (remoteAvatarUrl && (forceAvatarRefresh || !hasExistingStoredAvatar)) {
      federationService.scheduleAvatarRefresh(
        resolvedUserId,
        remoteAvatarUrl,
        existingAvatarFileId,
        { force: forceAvatarRefresh },
      );
    }

    logger.info('External user resolved', { type, username, userId: resolvedUserId });

    sendSuccess(res, user);
  })
);

export default router;
