import express, { type Request, type Response } from 'express';
import { and, eq } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { getDb } from '../config/postgres';
import { blocks } from '../db/schema/blocks';
import { restrictions } from '../db/schema/restrictions';
import { users } from '../db/schema/users';
import { authMiddleware } from '../middleware/auth';
import { asyncHandler } from '../utils/asyncHandler';
import { BadRequestError, NotFoundError, ConflictError, UnauthorizedError } from '../utils/error';
import { resolveUserIdToObjectId } from '../utils/validation';
import { accountService } from '../services/account.service';
import { userService } from '../services/user.service';
import blockCache, { restrictCache } from '../utils/blockCache';
import graphCache from '../utils/graphCache';
import { validate } from '../middleware/validate';
import { privacyUserIdParams, targetIdParams, privacySettingsSchema } from '../schemas/privacy.schemas';

interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
  };
}

const router = express.Router();
router.use(authMiddleware);

// Get privacy settings (own settings only)
const getPrivacySettings = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const authUser = (req as AuthenticatedRequest).user;

  if (!authUser?.id) {
    throw new UnauthorizedError('Authentication required');
  }

  const objectId = await resolveUserIdToObjectId(id);
  const authUserObjectId = await resolveUserIdToObjectId(authUser.id);

  if (authUserObjectId !== objectId) {
    throw new BadRequestError('Not authorized to view these settings');
  }

  const settings = await userService.readPrivacySettings(objectId);
  if (!settings) {
    throw new NotFoundError('User not found');
  }
  res.json(settings);
});

// Update privacy settings
const updatePrivacySettings = asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const settings = privacySettingsSchema.parse(req.body);
  const authUser = (req as AuthenticatedRequest).user;

  if (!authUser?.id) {
    throw new UnauthorizedError('Authentication required');
  }

  const objectId = await resolveUserIdToObjectId(id);
  const authUserObjectId = await resolveUserIdToObjectId(authUser.id);

  if (authUserObjectId !== objectId) {
    throw new BadRequestError('Not authorized to update these settings');
  }

  // Merges only the supplied keys; the service owns the wire-key -> column map
  // and the userCache invalidation that keeps the next session read fresh.
  const updated = await userService.updatePrivacySettings(objectId, settings);

  if (!updated) {
    throw new NotFoundError('User not found');
  }

  res.json(updated);
});

/**
 * One of the two symmetric "user A has flagged user B" relations.
 *
 * The Mongo version parameterised its three handlers by MODEL plus a field
 * NAME, which meant the field name was a string the type system never checked
 * against the model. Here the descriptor carries the real columns, so a
 * mismatched pair does not compile.
 */
interface UserRelation {
  table: typeof blocks | typeof restrictions;
  /** The column holding the acting user. */
  owner: PgColumn;
  /** The column holding the user acted upon. */
  counterparty: PgColumn;
  /** The wire key the counterparty is emitted under. */
  responseKey: 'blockedId' | 'restrictedId';
}

const BLOCK_RELATION: UserRelation = {
  table: blocks,
  owner: blocks.userId,
  counterparty: blocks.blockedId,
  responseKey: 'blockedId',
};

const RESTRICT_RELATION: UserRelation = {
  table: restrictions,
  owner: restrictions.userId,
  counterparty: restrictions.restrictedId,
  responseKey: 'restrictedId',
};

/**
 * List the caller's relation rows with the counterparty profile embedded.
 *
 * The `.populate(field, 'username avatar name')` this replaces was a SECOND
 * query Mongo issued behind the call; here it is one join, and the three
 * embedded fields are named explicitly rather than by a projection string.
 */
const createUserListHandler = (relation: UserRelation) =>
  asyncHandler(async (req: Request, res: Response) => {
    const authUser = (req as AuthenticatedRequest).user;
    if (!authUser?.id) {
      throw new UnauthorizedError('Authentication required');
    }

    const rows = await getDb()
      .select({
        id: relation.table.id,
        userId: relation.owner,
        counterpartyId: relation.counterparty,
        username: users.username,
        avatar: users.avatar,
        nameFirst: users.nameFirst,
        nameLast: users.nameLast,
        createdAt: relation.table.createdAt,
      })
      .from(relation.table)
      .innerJoin(users, eq(users.id, relation.counterparty))
      .where(eq(relation.owner, authUser.id));

    res.json(
      rows.map((row) => ({
        _id: row.id,
        userId: row.userId,
        [relation.responseKey]: {
          _id: row.counterpartyId,
          username: row.username ?? undefined,
          avatar: row.avatar ?? undefined,
          name: { first: row.nameFirst ?? undefined, last: row.nameLast ?? undefined },
        },
        createdAt: row.createdAt,
      }))
    );
  });

/**
 * Take a relation out on `targetId`.
 *
 * ## Neither of these may be pointed at an account the caller operates
 *
 * The self-refusal below is the whole truth only for a personal login. A
 * channel, organization, project or bot is never the caller's own id, so the id
 * comparison answers "no" for all four and used to let an operator block or
 * restrict an account they themselves speak with — an act with no coherent
 * meaning (block is symmetric, so it half-severs the operator from their own
 * account's audience) and one no client offers. Making it *impossible* rather
 * than merely hidden is the point: `oxyServices.blockUser` reaches this route
 * directly, so a guard anywhere else is bypassed by the request the app already
 * makes.
 *
 * `accountService.operatesAccount` is the single authority for "operates" —
 * shared with `POST /accounts/:id/switch` and with the consuming apps that ask
 * the same question over the wire — and it answers `false` for everything it
 * cannot positively confirm, so an unresolvable membership lets the protective
 * action through rather than stranding somebody who needs it. See that method
 * for why this direction is the opposite of the one `verifyActingAs` takes.
 *
 * BOTH actions, not just block. Restrict is the same shape of decision aimed at
 * the same target — a self-directed moderation action against your own voice —
 * and it costs the operator the same nothing to be refused.
 */
const createUserActionHandler = (relation: UserRelation, actionName: string) =>
  asyncHandler(async (req: Request, res: Response) => {
    const { targetId } = req.params;
    const authUser = (req as AuthenticatedRequest).user;

    if (!authUser?.id || authUser.id === targetId) {
      throw new BadRequestError(`Invalid ${actionName} request`);
    }

    // 400 and not 403, matching the self-refusal above: this is a request that
    // does not mean anything, not a right the caller lacks. 403 would signal the
    // opposite of the truth — they hold MORE authority over this account than a
    // stranger does, not less. Naming the reason leaks nothing, since being told
    // you operate an account you operate tells you what you already knew.
    if (await accountService.operatesAccount(authUser.id, targetId)) {
      throw new BadRequestError(`You cannot ${actionName} an account you operate`);
    }

    // The compound unique is the arbiter of "already flagged": a concurrent
    // duplicate returns no row rather than racing a read-then-write.
    const inserted = await getDb()
      .insert(relation.table)
      .values({ userId: authUser.id, [relation.responseKey]: targetId })
      .onConflictDoNothing()
      .returning({ id: relation.table.id });

    if (inserted.length === 0) {
      throw new ConflictError(`User already ${actionName === 'block' ? 'blocked' : 'restricted'}`);
    }

    // The media-access block check (mediaPrivacyService.isUserBlocked) caches
    // the block relationship in `blockCache` (60s TTL) keyed by (ownerId,
    // viewerId). A block is symmetric and can be cached under EITHER direction
    // depending on which side owns the media being viewed, so bust both keys —
    // otherwise a just-blocked user keeps seeing the blocker's media until the
    // TTL lapses.
    if (relation.responseKey === 'blockedId') {
      blockCache.invalidate(authUser.id, targetId);
      blockCache.invalidate(targetId, authUser.id);

      // The block changed the blocker's cached `blockedIds`; invalidate both
      // sides' viewer graph (symmetric, like the blockCache busts above) so the
      // next `GET /users/me/graph` recomputes fresh truth.
      await Promise.all([
        graphCache.invalidate(authUser.id),
        graphCache.invalidate(targetId),
      ]);
    } else {
      // Restrict is asymmetric: only the restricter's media is hidden from the
      // restricted user, so bust the single (owner, viewer) cache key.
      restrictCache.invalidate(authUser.id, targetId);

      // The restriction changed the restricter's cached `restrictedIds`. Only
      // their own graph carries it (asymmetric), so bust just that one.
      await graphCache.invalidate(authUser.id);
    }

    res.json({ message: `User ${actionName === 'block' ? 'blocked' : 'restricted'} successfully` });
  });

const createUserRemoveHandler = (relation: UserRelation, actionName: string) =>
  asyncHandler(async (req: Request, res: Response) => {
    const { targetId } = req.params;
    const authUser = (req as AuthenticatedRequest).user;

    if (!authUser?.id) {
      throw new UnauthorizedError("Authentication required");
    }

    const deleted = await getDb()
      .delete(relation.table)
      .where(and(eq(relation.owner, authUser.id), eq(relation.counterparty, targetId)))
      .returning({ id: relation.table.id });

    if (deleted.length === 0) {
      throw new NotFoundError(`${actionName === 'unblock' ? 'Block' : 'Restriction'} not found`);
    }

    // Symmetric to blockUser: drop both cached directions so the unblocked user
    // regains access to the formerly-blocking user's media immediately instead
    // of waiting out the blockCache TTL.
    if (relation.responseKey === 'blockedId') {
      blockCache.invalidate(authUser.id, targetId);
      blockCache.invalidate(targetId, authUser.id);

      // Symmetric to blockUser: the unblock changed the blocker's cached
      // `blockedIds`, so invalidate both sides' viewer graph.
      await Promise.all([
        graphCache.invalidate(authUser.id),
        graphCache.invalidate(targetId),
      ]);
    } else {
      restrictCache.invalidate(authUser.id, targetId);
      await graphCache.invalidate(authUser.id);
    }

    res.json({ message: `User ${actionName === 'unblock' ? 'unblocked' : 'unrestricted'} successfully` });
  });

// Blocked users handlers
const getBlockedUsers = createUserListHandler(BLOCK_RELATION);
const blockUser = createUserActionHandler(BLOCK_RELATION, 'block');
const unblockUser = createUserRemoveHandler(BLOCK_RELATION, 'unblock');

// Restricted users handlers
const getRestrictedUsers = createUserListHandler(RESTRICT_RELATION);
const restrictUser = createUserActionHandler(RESTRICT_RELATION, 'restrict');
const unrestrictUser = createUserRemoveHandler(RESTRICT_RELATION, 'unrestrict');

/**
 * @openapi
 * /privacy/{id}/privacy:
 *   get:
 *     tags:
 *       - Privacy
 *     summary: Get a user's privacy settings
 *     description: >
 *       Return the full privacy settings record for the user. Some fields
 *       are only visible to the owner; non-owner callers see a redacted
 *       projection.
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Privacy settings.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: true
 *             examples:
 *               default:
 *                 value:
 *                   profileVisibility: public
 *                   showActivity: true
 *                   allowDirectMessages: contacts-only
 *                   discoverableByEmail: false
 *                   discoverableByPhone: false
 *       401:
 *         description: Missing or invalid bearer token.
 *       404:
 *         description: User not found.
 */
router.get("/:id/privacy", validate({ params: privacyUserIdParams }), getPrivacySettings);

/**
 * @openapi
 * /privacy/{id}/privacy:
 *   patch:
 *     tags:
 *       - Privacy
 *     summary: Update a user's privacy settings (owner only)
 *     description: >
 *       Partial update of the user's privacy settings. Only the owner of
 *       the account may patch their settings — other callers get 403.
 *       Invalidates the in-memory user cache so subsequent reads return
 *       fresh values.
 *     parameters:
 *       - name: id
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties: true
 *           examples:
 *             tighten:
 *               summary: Make profile private and disable email discovery
 *               value:
 *                 profileVisibility: private
 *                 discoverableByEmail: false
 *     responses:
 *       200:
 *         description: Updated privacy settings.
 *       400:
 *         description: Validation failed.
 *       401:
 *         description: Missing or invalid bearer token.
 *       403:
 *         description: Caller is not the owner.
 */
router.patch("/:id/privacy", validate({ params: privacyUserIdParams }), updatePrivacySettings);

/**
 * @openapi
 * /privacy/blocked:
 *   get:
 *     tags:
 *       - Privacy
 *     summary: List blocked users
 *     description: Return the users the authenticated caller has blocked.
 *     responses:
 *       200:
 *         description: List of blocked users.
 */
router.get("/blocked", getBlockedUsers);

/**
 * @openapi
 * /privacy/blocked/{targetId}:
 *   post:
 *     tags:
 *       - Privacy
 *     summary: Block a user
 *     description: >
 *       Block `targetId` for the authenticated caller. Blocking is
 *       symmetric — neither account can see the other's posts, profile, or
 *       reach the other in DMs.
 *     parameters:
 *       - name: targetId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User blocked.
 *       400:
 *         description: >
 *           The target is the caller, or an account the caller operates — an
 *           active member of a channel, or a member of an organization /
 *           project / bot holding `account:act_as`.
 *       409:
 *         description: Already blocked.
 */
router.post("/blocked/:targetId", validate({ params: targetIdParams }), blockUser);

/**
 * @openapi
 * /privacy/blocked/{targetId}:
 *   delete:
 *     tags:
 *       - Privacy
 *     summary: Unblock a user
 *     parameters:
 *       - name: targetId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User unblocked.
 */
router.delete("/blocked/:targetId", validate({ params: targetIdParams }), unblockUser);

/**
 * @openapi
 * /privacy/restricted:
 *   get:
 *     tags:
 *       - Privacy
 *     summary: List restricted users
 *     description: Return the users the authenticated caller has restricted.
 *     responses:
 *       200:
 *         description: List of restricted users.
 */
router.get("/restricted", getRestrictedUsers);

/**
 * @openapi
 * /privacy/restricted/{targetId}:
 *   post:
 *     tags:
 *       - Privacy
 *     summary: Restrict a user
 *     description: >
 *       Restrict `targetId` — they can still see public content but their
 *       replies and DMs are silently filtered out of the caller's view.
 *     parameters:
 *       - name: targetId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User restricted.
 *       400:
 *         description: >
 *           The target is the caller, or an account the caller operates — same
 *           rule as `POST /privacy/blocked/{targetId}`.
 *       409:
 *         description: Already restricted.
 */
router.post("/restricted/:targetId", validate({ params: targetIdParams }), restrictUser);

/**
 * @openapi
 * /privacy/restricted/{targetId}:
 *   delete:
 *     tags:
 *       - Privacy
 *     summary: Unrestrict a user
 *     parameters:
 *       - name: targetId
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: User unrestricted.
 */
router.delete("/restricted/:targetId", validate({ params: targetIdParams }), unrestrictUser);

export default router;
