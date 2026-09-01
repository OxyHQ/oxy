/**
 * `/v2/follows` — the user's follow graph, as explicit operations.
 *
 * Deliberately NOT an extension of the legacy toggle. A toggle cannot express
 * the states this graph actually has — following globally but disabled here,
 * requested and waiting, syncing to a remote server — and a client that sends
 * "toggle" has to guess the current state to know what it just did. Every
 * operation here says what it wants, and every one is idempotent, so a retry
 * after a dropped response is safe rather than a coin flip.
 *
 * ## Authority
 *
 * Nothing on this router takes a follower id or an application id from the
 * request. Both come from `resolveFollowCapability`, which derives them from
 * the verified session — a body field naming an application is exactly the
 * forgery #809 forbids, and a header is no better.
 *
 * Every route also names the scope it requires, and those scopes are asserted
 * against the follow family at module load: a typo, or a scope from another
 * domain reaching this authorization path, fails at boot rather than becoming a
 * permanently-denied request nobody can explain.
 */

import express, { type Response } from 'express';
import { and, desc, eq, lt } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { followApplicationOverrides } from '../db/schema/followApplicationOverrides';
import { followRelationships } from '../db/schema/followRelationships';
import { followTargets } from '../db/schema/followTargets';
import { authMiddleware, type AuthRequest } from '../middleware/auth';
import {
  assertFollowScopes,
  missingFollowScope,
  resolveFollowCapability,
  type FollowCapability,
} from '../services/followCapability.service';
import {
  deriveFollowEffectiveState,
  followTarget,
  getFollowStatus,
  restoreInheritance,
  setApplicationMode,
  unfollowEverywhere,
} from '../services/followCommand.service';
import { asyncHandler, sendSuccess } from '../utils/asyncHandler';
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from '../utils/error';

const router = express.Router();

router.use(authMiddleware);

const READ = ['follows:read'] as const;
const WRITE = ['follows:write'] as const;
const CONTEXT = ['follows:context:write'] as const;
const MANAGE = ['follows:manage'] as const;

// Fails at boot if any of these stops being a follow scope.
for (const scopes of [READ, WRITE, CONTEXT, MANAGE]) assertFollowScopes(scopes);

/** The largest page the central list will return, however much a caller asks for. */
const MAX_PAGE = 100;

/**
 * Resolve the caller's capability, or end the request explaining why not.
 *
 * The denial reasons are kept distinct in the response because they need
 * different things from the user: an app that was never authorized needs the
 * consent screen, and an app whose grant was revoked needs the user to decide
 * again. One opaque 403 for both would leave a client unable to say either.
 */
async function requireCapability(
  req: AuthRequest,
  res: Response,
  scopes: readonly string[]
): Promise<FollowCapability | null> {
  const userId = req.user?.id;
  const sessionId = req.sessionId;
  if (!userId || !sessionId) {
    throw new UnauthorizedError('Authentication required');
  }

  const result = await resolveFollowCapability(userId, sessionId);
  if (!result.ok) {
    throw new ForbiddenError(
      result.reason === 'no_application'
        ? 'This session was not created through an application authorization'
        : result.reason === 'application_inactive'
          ? 'This application is not active'
          : 'This application has not been granted access to your follows'
    );
  }

  const missing = missingFollowScope(result.capability, scopes);
  if (missing) {
    // Naming the scope is the point: "has not been granted permission to change
    // who you follow" is actionable, and a bare 403 is not.
    throw new ForbiddenError(`Missing scope: ${missing}`);
  }

  return result.capability;
}

/** Load a target by id, or 404. Never creates one — registration is separate. */
async function loadTarget(targetId: string) {
  const [target] = await getDb()
    .select({
      id: followTargets.id,
      canonicalUri: followTargets.canonicalUri,
      kind: followTargets.kind,
      localUserId: followTargets.localUserId,
    })
    .from(followTargets)
    .where(eq(followTargets.id, targetId))
    .limit(1);

  if (!target) throw new NotFoundError('Target not found');
  return target;
}

/**
 * PUT /v2/follows/:targetId
 *
 * Idempotent: following something already followed returns the same
 * relationship and reports `created: false`, rather than erroring or creating a
 * second edge.
 *
 * `expiresIn` is the timed follow — seconds from now, for an event or a trial.
 * Bounded, because an unbounded value is indistinguishable from a permanent
 * follow the user believes will end.
 */
router.put(
  '/:targetId',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const capability = await requireCapability(req, res, WRITE);
    if (!capability) return;

    const target = await loadTarget(req.params.targetId);

    let expiresAt: Date | undefined;
    const raw = (req.body as { expiresIn?: unknown } | undefined)?.expiresIn;
    if (raw !== undefined) {
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 365 * 24 * 60 * 60) {
        throw new BadRequestError('expiresIn must be a positive number of seconds under a year');
      }
      expiresAt = new Date(Date.now() + seconds * 1000);
    }

    const result = await followTarget({ capability, target, expiresAt });
    sendSuccess(res, result);
  })
);

/**
 * GET /v2/follows/:targetId/status
 *
 * Reports the global state, this application's override, and the effective
 * state separately. A client that only receives a boolean cannot render
 * "following globally, disabled here", which is a state the user put the system
 * into and therefore has to be able to see.
 */
router.get(
  '/:targetId/status',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const capability = await requireCapability(req, res, READ);
    if (!capability) return;

    const target = await loadTarget(req.params.targetId);
    sendSuccess(res, await getFollowStatus({ capability, targetId: target.id }));
  })
);

/**
 * DELETE /v2/follows/:relationshipId
 *
 * Unfollow everywhere. Idempotent — removing something already gone reports
 * `removed: false` and succeeds, because the state the caller asked for is the
 * state that holds.
 */
router.delete(
  '/:relationshipId',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const capability = await requireCapability(req, res, WRITE);
    if (!capability) return;

    sendSuccess(
      res,
      await unfollowEverywhere({ capability, relationshipId: req.params.relationshipId })
    );
  })
);

/**
 * PUT /v2/follows/:relationshipId/context
 *
 * Turn a relationship off, or back on, in ONE application — by default the
 * caller's own. Naming a DIFFERENT application is a management operation and
 * needs `follows:manage`, because doing it on another app's behalf is exactly
 * the cross-application authority this design otherwise refuses.
 */
router.put(
  '/:relationshipId/context',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const body = (req.body ?? {}) as { mode?: unknown; applicationId?: unknown };
    if (body.mode !== 'enabled' && body.mode !== 'disabled') {
      throw new BadRequestError('mode must be "enabled" or "disabled"');
    }

    const targetApplicationId =
      typeof body.applicationId === 'string' ? body.applicationId : undefined;
    const capability = await requireCapability(
      req,
      res,
      targetApplicationId ? MANAGE : CONTEXT
    );
    if (!capability) return;

    const result = await setApplicationMode({
      capability,
      relationshipId: req.params.relationshipId,
      ...(targetApplicationId ? { applicationId: targetApplicationId } : {}),
      mode: body.mode,
    });

    if (!result.ok) throw new NotFoundError('Relationship not found');
    sendSuccess(res, result);
  })
);

/**
 * DELETE /v2/follows/:relationshipId/context
 *
 * Restore inheritance — the application follows the global relationship again.
 */
router.delete(
  '/:relationshipId/context',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const raw = (req.query.applicationId ?? undefined) as string | undefined;
    const capability = await requireCapability(req, res, raw ? MANAGE : CONTEXT);
    if (!capability) return;

    const result = await restoreInheritance({
      capability,
      relationshipId: req.params.relationshipId,
      ...(raw ? { applicationId: raw } : {}),
    });

    if (!result.ok) throw new NotFoundError('Relationship not found');
    sendSuccess(res, result);
  })
);

export default router;

/**
 * `GET /v2/me/follows` — everything the user follows.
 *
 * A separate router because it hangs off `/v2/me` rather than `/v2/follows`,
 * and because it is the only READ that returns other people's targets: it is
 * owner-only by construction, filtered on the capability's user id with no
 * parameter that could name somebody else.
 *
 * Cursor pagination on `created_at`, not offset: the list changes while it is
 * being read, and an offset silently skips or repeats rows when it does.
 */
export const meFollowsRouter = express.Router();

meFollowsRouter.use(authMiddleware);

meFollowsRouter.get(
  '/follows',
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const capability = await requireCapability(req, res, READ);
    if (!capability) return;

    const limit = Math.min(Number(req.query.limit) || 50, MAX_PAGE);
    const cursor = typeof req.query.cursor === 'string' ? new Date(req.query.cursor) : null;
    const kind = typeof req.query.kind === 'string' ? req.query.kind : null;

    const rows = await getDb()
      .select({
        relationshipId: followRelationships.id,
        state: followRelationships.state,
        expiresAt: followRelationships.expiresAt,
        createdAt: followRelationships.createdAt,
        originApplicationId: followRelationships.originApplicationId,
        targetId: followTargets.id,
        canonicalUri: followTargets.canonicalUri,
        kind: followTargets.kind,
        metadata: followTargets.metadataSnapshot,
        overrideMode: followApplicationOverrides.mode,
      })
      .from(followRelationships)
      .innerJoin(followTargets, eq(followTargets.id, followRelationships.followTargetId))
      // The caller's OWN override for each row, so a client can render "disabled
      // here" without a second round trip per item.
      .leftJoin(
        followApplicationOverrides,
        and(
          eq(followApplicationOverrides.relationshipId, followRelationships.id),
          eq(followApplicationOverrides.applicationId, capability.applicationId)
        )
      )
      .where(
        and(
          eq(followRelationships.followerUserId, capability.userId),
          ...(cursor && !Number.isNaN(cursor.getTime())
            ? [lt(followRelationships.createdAt, cursor)]
            : []),
          ...(kind ? [eq(followTargets.kind, kind)] : [])
        )
      )
      .orderBy(desc(followRelationships.createdAt))
      // One extra row answers "is there more" without a second count query.
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    sendSuccess(res, {
      follows: page.map((row) => {
        const applicationMode = row.overrideMode ?? 'inherit';
        return {
          relationshipId: row.relationshipId,
          target: {
            id: row.targetId,
            uri: row.canonicalUri,
            kind: row.kind,
            ...(row.metadata ? { metadata: row.metadata } : {}),
          },
          globalState: row.state,
          applicationMode,
          effectiveState: deriveFollowEffectiveState(row.state, applicationMode),
          originApplicationId: row.originApplicationId,
          ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
          createdAt: row.createdAt.toISOString(),
        };
      }),
      ...(hasMore ? { nextCursor: page[page.length - 1].createdAt.toISOString() } : {}),
    });
  })
);
