/**
 * Profile Routes
 * 
 * RESTful API routes for profile operations.
 * Uses service layer for business logic and standardized error handling.
 */

import { Router, type Request, type Response } from 'express';
import { and, eq, inArray, notInArray, sql, type SQL } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { appAffinityEdges } from '../db/schema/appAffinityEdges';
import { applications } from '../db/schema/applications';
import { appUserSignals } from '../db/schema/appUserSignals';
import { userFollows } from '../db/schema/userFollows';
import { users } from '../db/schema/users';
import { authMiddleware } from '../middleware/auth';
import {
  optionalUserOrServiceAuth,
  resolveViewerId,
  type OptionalUserOrServiceRequest,
} from '../middleware/optionalAuth';
import { logger } from '../utils/logger';
import { asyncHandler, sendSuccess, sendPaginated } from '../utils/asyncHandler';
import {
  NotFoundError,
  BadRequestError,
  UnauthorizedError,
} from '../utils/error';
import { userService } from '../services/user.service';
import { federationService, isFediverseHandle } from '../services/federation.service';
import { validate } from '../middleware/validate';
import { usernameParams, profileSearchQuerySchema } from '../schemas/profiles.schemas';
import { userIdentityFields, deriveIsFederated } from '../utils/userTransform';
import {
  publicUserColumns,
  publicUserFollowCounts,
  toPublicUserView,
  type PublicUserView,
} from '../utils/publicUserProjection';
import {
  eligibleUserPredicate,
  FEDERATED_RECOMMENDATION_MAX_AGE_MS,
  isPublicGraphTarget,
  normalizePeopleSearchTerm,
  peopleSearchMatch,
  peopleSearchOrder,
  peopleSearchPredicate,
} from '../utils/profileQuery';
import { accountService } from '../services/account.service';
import { getRedisClient } from '../config/redis';
import {
  resolveWeightProfile,
  normalizeRepWeight,
  MUTUAL_COUNT_WINDOW,
  MAX_FOLLOWING_FOR_MUTUALS,
  MAX_APP_SIGNAL_CANDIDATES,
  REC_CACHE_TTL_SECONDS,
  REP_WEIGHT_NORM_MIN,
  REP_WEIGHT_NORM_MAX,
  ENDORSEMENT_SCORE_SATURATION,
  MUTUAL_COUNT_SATURATION,
  MAX_AFFINITY_CANDIDATES,
  decayAffinity,
  normalizeAffinity,
  type RecommendationSignal,
} from '../utils/recommendationWeights';
import { INFLUENCE_MIN } from '../utils/reputation.constants';
import {
  recommendationRequestSchema,
  type RecommendationRequest,
  type RecommendationBoost,
} from '@oxyhq/contracts';

interface AuthRequest extends Request {
  user?: {
    id: string;
  };
}

interface PaginationQuery {
  limit?: string;
  offset?: string;
}

const router = Router();
import { PAGINATION } from '../utils/constants';
import { resolveOperatorId } from '../middleware/operator';

// Constants
/**
 * The account types a caller may exclude from discovery. A closed set, and now a
 * TYPE: the column it filters is a closed value set too, so an unrecognised
 * string cannot reach the query at all rather than silently excluding nothing.
 */
const VALID_EXCLUDE_TYPES = ['federated', 'agent', 'automated'] as const;
type ExcludableUserType = (typeof VALID_EXCLUDE_TYPES)[number];

const isExcludableUserType = (value: unknown): value is ExcludableUserType =>
  typeof value === 'string' && (VALID_EXCLUDE_TYPES as readonly string[]).includes(value);
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 30;
// Extra follower-ranked candidates fetched before the private/excludeTypes
// filter on the public recommendations path, so post-lookup filtering can't
// shrink the page below the requested limit.
const PUBLIC_FILTER_HEADROOM = 20;
// Bound the unauthenticated popularity fallback so a public request cannot
// aggregate the entire social graph. The sorted prefix is supported by
// Follow's { followType, createdAt, _id } index and keeps work independent of the
// total follows collection size.
const PUBLIC_POPULAR_FOLLOW_WINDOW = 5000;
// Bound attacker-selected co-follower fan-out before materializing IDs or
// building the follow aggregation's $in clause. This keeps /similar stable for
// high-follower targets while still sampling enough overlap for useful results.
const SIMILAR_PROFILE_MAX_TARGET_FOLLOWERS = 5000;

/**
 * Shape of a single recommendation/profile row produced by
 * {@link profileProjectionStage} and {@link userProfileProjectionStage}.
 * Both projections emit the same fields, so every recommendation pipeline
 * (personalized, public, similar, random fill) yields this row shape and it
 * feeds {@link formatProfileResult}.
 */
interface RecommendationRow {
  _id: string;
  username?: string | null;
  publicKey?: string | null;
  /**
   * FLAT, matching the `users` row. `userIdentityFields` reads either shape and
   * is the single definition of `name.displayName`, the canonical contract every
   * ecosystem app renders — so this row does NOT reassemble a nested `name`.
   */
  nameFirst?: string | null;
  nameLast?: string | null;
  avatar?: string | null;
  description?: string | null;
  type?: string;
  federationDomain?: string | null;
  verified?: boolean;
  reputationTier?: string;
  mutualCount?: number;
  followersCount?: number;
  followingCount?: number;
  /** Final composite score (scored v2 path only). */
  score?: number;
  /** Names of the signals that contributed to the score (scored v2 path only). */
  matchedSignals?: string[];
}

/**
 * The `users` columns every recommendation surface reads.
 *
 * Replaces the two `$project` stages the Mongo pipelines carried — one for
 * pipelines rooted at `follows` and one for pipelines rooted at `users`. Rooting
 * is a JOIN here, not a different projection, so there is only one list and the
 * two can no longer drift.
 */
const recommendationColumns = {
  _id: users.id,
  username: users.username,
  publicKey: users.publicKey,
  nameFirst: users.nameFirst,
  nameLast: users.nameLast,
  avatar: users.avatar,
  description: users.description,
  type: users.type,
  federationDomain: users.federationDomain,
  verified: users.verified,
  reputationTier: users.reputationTier,
} as const;

export function formatProfileResult(u: RecommendationRow) {
  // Load-bearing identity fields (`id`, `name`, `username`, `avatar`) come from
  // the SHARED `userIdentityFields` definer so this recommendation serializer can
  // never diverge from the public/self serializers on them — `id` is the stable
  // `_id` string, never the publicKey.
  const identity = userIdentityFields(u);
  return {
    id: identity.id,
    username: identity.username,
    name: identity.name,
    avatar: identity.avatar,
    description: u.description,
    verified: u.verified === true,
    trustTier: u.reputationTier,
    mutualCount: u.mutualCount || 0,
    ...(typeof u.score === 'number' ? { score: u.score } : {}),
    ...(u.matchedSignals ? { matchedSignals: u.matchedSignals } : {}),
    isFederated: deriveIsFederated(u.type),
    isAgent: u.type === 'agent',
    isAutomated: u.type === 'automated',
    instance: u.federationDomain ?? undefined,
    _count: {
      followers: u.followersCount || 0,
      following: u.followingCount || 0,
    },
  };
}

/**
 * Load ONE public profile by a predicate, with its follower/following totals.
 *
 * The totals are correlated aggregates on the same row rather than the two
 * grouped `Follow` aggregations the Mongo version ran afterwards — which is also
 * where `routes/profiles.ts:540` was broken: it passed `.toString()` ids into an
 * aggregation `$match`, Mongoose does not cast aggregation pipelines, and the
 * match therefore selected nothing, so every follower count on `/profiles/search`
 * read zero. A join on a real foreign key cannot express that mistake.
 */
async function loadProfileByPredicate(
  predicate: SQL
): Promise<{ view: PublicUserView; stats: { followers: number; following: number } } | null> {
  const [row] = await getDb()
    .select({ ...publicUserColumns, ...publicUserFollowCounts })
    .from(users)
    .where(predicate)
    .limit(1);
  if (!row) return null;
  return {
    view: toPublicUserView(row),
    stats: { followers: row.followersCount, following: row.followingCount },
  };
}

/**
 * The account id of a row `federationService.resolveAndUpsert` handed back.
 *
 * Read through `_id ?? id` because that service is ported by a different batch:
 * whichever of the two shapes it currently returns, the value is the same
 * account id, and this route re-reads the row from Postgres by it rather than
 * trusting the returned document's shape for anything else.
 */
function resolvedActorId(actor: { _id?: unknown; id?: unknown } | null | undefined): string | undefined {
  if (!actor) return undefined;
  const raw = actor._id ?? actor.id;
  if (raw == null) return undefined;
  const id = typeof raw === 'string' ? raw : String(raw);
  return id.length > 0 ? id : undefined;
}

/**
 * Validates pagination query parameters
 */
const validatePagination = (req: Request, res: Response, next: () => void): void => {
  const query = req.query as PaginationQuery;
  const limit = query.limit ? Number.parseInt(query.limit, 10) : undefined;
  const offset = query.offset ? Number.parseInt(query.offset, 10) : undefined;

  if (limit !== undefined && (isNaN(limit) || limit < 0 || limit > PAGINATION.MAX_LIMIT)) {
    res.status(400).json({
      error: 'BAD_REQUEST',
      message: `Invalid limit parameter. Must be between 1 and ${PAGINATION.MAX_LIMIT}`,
    });
    return;
  }

  if (offset !== undefined && (isNaN(offset) || offset < 0)) {
    res.status(400).json({
      error: 'BAD_REQUEST',
      message: 'Invalid offset parameter. Must be >= 0',
    });
    return;
  }

  next();
};

const parseExcludeTypesQuery = (excludeTypesRaw: unknown): ExcludableUserType[] => {
  if (excludeTypesRaw === undefined) {
    return [];
  }

  if (typeof excludeTypesRaw !== 'string') {
    throw new BadRequestError('Invalid excludeTypes parameter. Must be a comma-separated string');
  }

  return excludeTypesRaw
    .split(',')
    .map((type) => type.trim())
    .filter(isExcludableUserType);
};

/**
 * @openapi
 * /profiles/username/{username}:
 *   get:
 *     tags:
 *       - Profiles
 *     security: []
 *     summary: Public profile lookup by username
 *     description: >
 *       Resolve a username to a public profile, with follower/following
 *       counts. Federated handles (`user@domain`) are resolved on the fly via
 *       WebFinger + ActivityPub; if the actor has never been seen the
 *       endpoint will upsert it as a federated user before returning.
 *
 *       This endpoint is unauthenticated and may be cached by edge.
 *     parameters:
 *       - name: username
 *         in: path
 *         required: true
 *         schema:
 *           type: string
 *           description: Local username (alphanumeric, 3-30 chars) or fediverse handle.
 *           examples:
 *             local: alice
 *             federated: alice@mastodon.social
 *     responses:
 *       200:
 *         description: Profile found.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *             examples:
 *               local:
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
 *       400:
 *         description: Malformed username.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Profile not found (and federation lookup failed).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get(
  '/username/:username',
  optionalUserOrServiceAuth,
  validate({ params: usernameParams }),
  asyncHandler(async (req: OptionalUserOrServiceRequest, res: Response) => {
    const raw = req.params.username;

    // Federated handles (user@domain) are looked up as-is;
    // local usernames are sanitised to alphanumeric + underscores/hyphens/dots.
    const isFedHandle = isFediverseHandle(raw);
    const username = isFedHandle
      ? raw.replace(/^@/, '').toLowerCase()
      : raw.replace(/[^a-zA-Z0-9._-]/g, '');

    if (!username || username.length < MIN_USERNAME_LENGTH) {
      throw new BadRequestError(
        `Username must be at least ${MIN_USERNAME_LENGTH} characters`
      );
    }

    if (!isFedHandle && username.length > MAX_USERNAME_LENGTH) {
      throw new BadRequestError(`Username must be no more than ${MAX_USERNAME_LENGTH} characters`);
    }

    // Case-insensitive on BOTH branches now, and written against the EXPRESSION
    // the unique index is built on (`lower(btrim(username))`). Mongo indexed
    // `username` case-SENSITIVELY while this lookup ran an anchored `/i` regex,
    // so every profile fetch was a collection scan; the index serves it here.
    let profile = await loadProfileByPredicate(
      sql`lower(btrim(${users.username})) = lower(btrim(${username}))`
    );

    // If not found and it's a fediverse handle, resolve via WebFinger
    if (!profile && isFedHandle) {
      const resolved = await federationService.resolveAndUpsert(username).catch(() => null);
      const resolvedId = resolvedActorId(resolved);
      if (resolvedId) {
        profile = await loadProfileByPredicate(eq(users.id, resolvedId));
      }
    }

    if (
      !profile ||
      profile.view.accountStatus === 'archived' ||
      profile.view.reputationTier === 'restricted'
    ) {
      throw new NotFoundError('Profile not found');
    }

    const user = profile.view;

    // Format response with stats
    const response = userService.formatUserResponse(user, profile.stats);

    // Viewer-relative relationship: computed in the SAME handler (no second
    // round-trip) from the Follow model when the request is authenticated.
    // OMITTED for anonymous requests and for a self-view (no follow edge to a
    // profile you are viewing as yourself), so consumers can distinguish
    // "unknown" from "known, not following".
    const viewerId = resolveViewerId(req);
    const targetId = user._id;
    if (viewerId && viewerId !== targetId) {
      response.relationship = await userService.getViewerRelationship(viewerId, targetId);
    }

    logger.debug('GET /profiles/username/:username', { username });
    sendSuccess(res, response);
  })
);

/**
 * GET /profiles/search
 * 
 * Search for user profiles by username or name
 * 
 * @query {string} query - Search query (required)
 * @query {number} limit - Number of results (max 100, default 10)
 * @query {number} offset - Pagination offset (default 0)
 * @returns {PaginatedResponse<UserProfile>} Paginated list of matching profiles
 */
router.get(
  '/search',
  validate({ query: profileSearchQuerySchema }),
  validatePagination,
  asyncHandler(async (req: Request, res: Response) => {
    const query = req.query.query as string;
    const { limit, offset } = req.query as PaginationQuery;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      throw new BadRequestError('Search query is required');
    }

    const parsedLimit = limit
      ? Math.min(Number.parseInt(limit, 10), PAGINATION.MAX_LIMIT)
      : PAGINATION.DEFAULT_LIMIT;
    const parsedOffset = offset ? Number.parseInt(offset, 10) : 0;

    // A single leading `@` is stripped first so a handle-style query matches the
    // STORED username: an atproto handle `@adamrbjack.bsky.social` finds the
    // stored `adamrbjack.bsky.social@bsky.social`, and a Mastodon `@user@host`
    // matches the stored `user@host`. Only ONE leading `@` is removed — a
    // mid-string `@` (the `user@host` separator) is preserved. The term is
    // passed RAW: `peopleSearchMatch` escapes it for LIKE and binds it.
    const sanitizedQuery = normalizePeopleSearchTerm(query);

    // Run local DB search and (if query is a fediverse handle) remote resolution in parallel
    const isFediverse = isFediverseHandle(sanitizedQuery);
    const [pageRows, federatedUser] = await Promise.all([
      // Order the WHOLE match set BEFORE paging so offset pagination is
      // deterministic (the client's infinite scroll must never see a row
      // duplicated or skipped across pages):
      //   1. NATIVE (Oxy local/agent/etc.) before FEDERATED.
      //   2. Most-reputable first — `reputation_rank_weight` is the
      //      denormalized reputation rank.
      //   3. `id` ascending as the FINAL tiebreaker — `id` is unique, so this
      //      makes the total order STRICT and pagination stable.
      // The order precedes OFFSET/LIMIT, so it orders the full match set, not
      // just the page. `count(*) over ()` is evaluated before LIMIT, which is
      // what makes the total and the page ONE round trip — the job `$facet` did.
      // The selection is INCLUSION-ONLY (`publicUserColumns`): this row is
      // world-readable, and an exclusion denylist is one forgotten field away
      // from leaking.
      getDb()
        .select({
          ...publicUserColumns,
          ...publicUserFollowCounts,
          total: sql<number>`count(*) over ()::int`,
        })
        .from(users)
        .where(and(peopleSearchPredicate(), peopleSearchMatch(sanitizedQuery)))
        .orderBy(...peopleSearchOrder())
        .offset(parsedOffset)
        .limit(parsedLimit),
      isFediverse
        ? federationService.resolveAndUpsert(sanitizedQuery).catch(() => null)
        : Promise.resolve(null),
    ]);

    const profiles = pageRows.map((row) => ({
      view: toPublicUserView(row),
      stats: { followers: row.followersCount, following: row.followingCount },
    }));
    let total = pageRows[0]?.total ?? 0;

    // If federation resolved a user not already in DB results, prepend it.
    // `resolveAndUpsert` returns the cached row for a known federated actor,
    // which can be an ARCHIVED (dead / 410-Gone) account, a `restricted`
    // (negative-reputation) actor, or a private account — never let that prepend
    // re-introduce an actor the `peopleSearchMongoMatch` $match above excluded.
    //
    // This is a DELIBERATE exception to the native-first ordering applied above:
    // the caller typed an EXACT fediverse handle (`user@host`), so the resolved
    // remote actor is the single most-relevant hit and belongs at the front even
    // though it is federated. The rest of the page keeps native-first order.
    const fedId = resolvedActorId(federatedUser);
    if (fedId && !profiles.some((profile) => profile.view._id === fedId)) {
      // Re-read the resolved actor from Postgres rather than trusting the
      // upsert's return shape, and apply the SAME gate the page query applied —
      // `resolveAndUpsert` hands back the cached row for a known actor, which
      // can be archived, `restricted`, or private.
      const resolvedProfile = await loadProfileByPredicate(
        and(eq(users.id, fedId), peopleSearchPredicate()) ?? sql`false`
      );
      if (resolvedProfile) {
        profiles.unshift(resolvedProfile);
        total += 1;
      }
    }

    // Prepend can push the page over `limit`; trim so clients never see limit+1.
    if (profiles.length > parsedLimit) {
      profiles.length = parsedLimit;
    }

    const enrichedProfiles = profiles.map((profile) =>
      userService.formatUserResponse(profile.view, profile.stats)
    );

    logger.debug('GET /profiles/search', {
      query: sanitizedQuery,
      limit: parsedLimit,
      offset: parsedOffset,
      total,
    });

    sendPaginated(res, enrichedProfiles, total, parsedLimit, parsedOffset);
  })
);

/**
 * GET /profiles/resolve
 *
 * Resolve a handle (e.g. @user@mastodon.social) to an Oxy user profile.
 *
 * LOCAL-FIRST: a handle that already maps to a known Oxy user is resolved
 * directly from the DB — no network round-trip. This is essential for atproto
 * (Bluesky) actors whose `user@bsky.social` username oxy-api's WebFinger can
 * never resolve: the user already exists, so remote discovery must NOT run (it
 * would fail and yield a false "Profile not found"). The local lookup runs
 * regardless of `isFediverseHandle` because a stored `user@domain` username is a
 * valid lookup key even when the strict handle-format check would reject it.
 *
 * Only when NO local user exists do we fall through to WebFinger/ActivityPub
 * discovery (`resolveAndUpsert`) — genuine discovery of an unknown handle, which
 * is where the `isFediverseHandle` format validation still applies.
 *
 * @query {string} handle - Handle (e.g. "@user@domain" or "user@domain")
 * @returns {User | null} Resolved user profile or null
 */
router.get(
  '/resolve',
  optionalUserOrServiceAuth,
  asyncHandler(async (req: OptionalUserOrServiceRequest, res: Response) => {
    // Normalize handle input: trim, strip optional `acct:` prefix, and remove a
    // single leading `@` so `@user@host` matches the stored `user@host` username.
    const rawHandle = (req.query.handle as string || '')
      .trim()
      .replace(/^acct:/i, '')
      .replace(/^@/, '');

    if (!rawHandle) {
      throw new BadRequestError('Invalid fediverse handle. Expected format: @user@domain or user@domain');
    }

    // Federated handles are stored lowercased; normalize before the local lookup
    // so mixed-case queries hit the local-first fast path (same as /username/:username).
    const handle = isFediverseHandle(rawHandle) ? rawHandle.toLowerCase() : rawHandle;

    // Local-first: resolve an already-known user by exact username.
    const localProfile = await loadProfileByPredicate(
      sql`lower(btrim(${users.username})) = lower(btrim(${handle}))`
    );

    if (localProfile) {
      const localUser = localProfile.view;
      // A known user is never handed to remote discovery. Archived (dead /
      // 410-Gone) and `restricted`-tier accounts resolve to null — the same gate
      // people search applies, and consistent with the archived→null behavior of
      // the discovery path below.
      if (localUser.accountStatus === 'archived' || localUser.reputationTier === 'restricted') {
        return sendSuccess(res, null);
      }
      const response = userService.formatUserResponse(localUser, localProfile.stats);

      // Viewer-relative relationship: same in-handler computation as the two
      // sibling single-profile routes (/profiles/username/:username and
      // /users/:userId). A federated actor that bridged into the Oxy graph via an
      // inbound follow IS a known Oxy row here, so `getViewerRelationship`
      // returns real follow edges — this is what lets "Follows you" render on a
      // federated profile fetched through resolve. OMITTED for anonymous requests
      // and for a self-view, so consumers can distinguish "unknown" from "known,
      // not following".
      const viewerId = resolveViewerId(req);
      const targetId = localUser._id;
      if (viewerId && viewerId !== targetId) {
        response.relationship = await userService.getViewerRelationship(viewerId, targetId);
      }

      logger.debug('GET /profiles/resolve (local)', { handle });
      return sendSuccess(res, response);
    }

    // No local user → genuine discovery of an unknown handle. Enforce the strict
    // fediverse-handle format only now, then WebFinger/ActivityPub resolve+upsert.
    if (!isFediverseHandle(handle)) {
      throw new BadRequestError('Invalid fediverse handle. Expected format: @user@domain or user@domain');
    }

    const resolvedId = resolvedActorId(await federationService.resolveAndUpsert(handle));
    const resolvedProfile = resolvedId
      ? await loadProfileByPredicate(eq(users.id, resolvedId))
      : null;
    if (
      !resolvedProfile ||
      resolvedProfile.view.accountStatus === 'archived' ||
      resolvedProfile.view.reputationTier === 'restricted'
    ) {
      return sendSuccess(res, null);
    }

    const user = resolvedProfile.view;
    const response = userService.formatUserResponse(user, resolvedProfile.stats);

    // Same viewer-relative relationship as the local branch above. A
    // freshly-discovered actor is now a known Oxy row (`resolveAndUpsert`
    // persisted it), so its id is canonical; a brand-new actor simply has no
    // follow edges yet (`isFollowing`/`followsYou` both false). OMITTED for
    // anonymous requests and for a self-view.
    const viewerId = resolveViewerId(req);
    const targetId = user._id;
    if (viewerId && viewerId !== targetId) {
      response.relationship = await userService.getViewerRelationship(viewerId, targetId);
    }

    logger.debug('GET /profiles/resolve', { handle });
    sendSuccess(res, response);
  })
);

/**
 * GET /profiles/:userId/similar
 *
 * Get profiles similar to a given user, based on co-follower overlap.
 * Finds users followed by the same people who follow :userId, ranked by overlap count.
 *
 * @param {string} userId - Target user ID
 * @query {number} limit - Number of results (max 100, default 10)
 * @query {number} offset - Pagination offset (default 0)
 * @returns {UserProfile[]} List of similar profiles
 */
router.get(
  '/:userId/similar',
  authMiddleware,
  validatePagination,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { limit, offset } = req.query as PaginationQuery;
    const currentUserId = req.user?.id;
    const targetUserId = req.params.userId;

    if (!currentUserId) {
      throw new UnauthorizedError('Authentication required');
    }

    // Same target gate as GET /users/:userId/{followers,following,mutuals}:
    // archived/restricted/private accounts must not seed a discovery surface.
    const targetUser = await userService.getPublicUserById(targetUserId);
    if (!isPublicGraphTarget(targetUser)) {
      throw new NotFoundError('User not found');
    }

    const parsedLimit = limit
      ? Math.min(Number.parseInt(limit, 10), PAGINATION.MAX_LIMIT)
      : PAGINATION.DEFAULT_LIMIT;
    const parsedOffset = offset ? Number.parseInt(offset, 10) : 0;
    const minFederatedResolvedAt = new Date(Date.now() - FEDERATED_RECOMMENDATION_MAX_AGE_MS);

    const db = getDb();
    const [targetFollowers, currentFollowing] = await Promise.all([
      db
        .select({ followerId: userFollows.followerId })
        .from(userFollows)
        .where(eq(userFollows.followedId, targetUserId))
        .orderBy(userFollows.id)
        .limit(SIMILAR_PROFILE_MAX_TARGET_FOLLOWERS),
      db
        .select({ followedId: userFollows.followedId })
        .from(userFollows)
        .where(eq(userFollows.followerId, currentUserId)),
    ]);

    const targetFollowerIds = targetFollowers.map((edge) => edge.followerId);
    const excludeIds = [
      currentUserId,
      targetUserId,
      ...currentFollowing.map((edge) => edge.followedId),
    ];

    let similar: RecommendationRow[] = [];

    if (targetFollowerIds.length > 0) {
      // The overlap page, then the profiles. Paged BEFORE the eligibility join,
      // exactly as the Mongo pipeline was: `$skip`/`$limit` preceded its
      // `$lookup`, so a page can come back shorter than `limit` when a candidate
      // fails the bar. `id` is added as the sort tiebreaker Mongo lacked —
      // `mutualCount` alone is not unique, and without a strict total order an
      // offset page can repeat a row while skipping another.
      const overlap = await db
        .select({
          id: userFollows.followedId,
          mutualCount: sql<number>`count(*)::int`,
        })
        .from(userFollows)
        .where(
          and(
            inArray(userFollows.followerId, targetFollowerIds),
            notInArray(userFollows.followedId, excludeIds)
          )
        )
        .groupBy(userFollows.followedId)
        .orderBy(sql`count(*) desc`, sql`${userFollows.followedId} asc`)
        .offset(parsedOffset)
        .limit(parsedLimit);

      if (overlap.length > 0) {
        const overlapIds = overlap.map((row) => row.id);
        const mutualById = new Map(overlap.map((row) => [row.id, row.mutualCount]));

        // Hold co-follower candidates to the same discovery eligibility bar as
        // the recommendations surface: drop incomplete shell/QA profiles,
        // private accounts, and stale/unavailable federated actors before they
        // reach the response.
        const rows = await db
          .select({ ...recommendationColumns, ...publicUserFollowCounts })
          .from(users)
          .where(
            and(
              inArray(users.id, overlapIds),
              eq(users.privacyIsPrivateAccount, false),
              eligibleUserPredicate(minFederatedResolvedAt)
            )
          );

        const eligibleById = new Map(rows.map((row) => [row._id, row]));
        similar = overlapIds
          .map((id) => eligibleById.get(id))
          .filter((row): row is (typeof rows)[number] => row !== undefined)
          .map((row) => ({ ...row, mutualCount: mutualById.get(row._id) ?? 0 }));
      }
    }

    const formattedSimilar = similar.map(formatProfileResult);

    logger.debug('GET /profiles/:userId/similar', {
      currentUserId,
      targetUserId,
      similarCount: formattedSimilar.length,
      sampledTargetFollowers: targetFollowerIds.length,
    });

    sendSuccess(res, formattedSimilar);
  })
);

/**
 * Normalized options for {@link buildRecommendations}, shared by the GET
 * (query-string) and POST (JSON body) entry points so both surfaces produce the
 * identical result for the identical inputs.
 */
interface RecommendationOptions {
  limit: number;
  offset: number;
  excludeTypes: ExcludableUserType[];
  excludeIds: string[];
  clientId?: string;
  boosts?: RecommendationBoost[];
  signalWeights?: Partial<Record<RecommendationSignal, number>>;
}

/**
 * Authorize the caller-supplied recommendation `clientId` (an Application id used
 * to read that app's private per-user signals and weight profile) against the
 * authenticated principal, returning the normalized id ONLY when the caller is
 * entitled to it — otherwise `undefined` (the request proceeds with no app
 * context).
 *
 * A `clientId` selects an app's AppUserSignal data (endorsement/interest) and
 * per-app weight profile, so honoring an arbitrary caller-supplied id would let
 * any caller pull recommendations shaped by another tenant's private signals
 * (cross-tenant data exposure). Authorization rules:
 *  - SERVICE token: allowed only for its OWN application
 *    (`clientId === serviceApp.appId`).
 *  - USER session: allowed only when the user has effective access to the
 *    application's owning account (an `AccountMember` role over
 *    `app.ownerAccountId`, with tree inheritance).
 *  - Anonymous: no owning application context → never authorized (and no DB
 *    lookup is performed).
 */
async function resolveAuthorizedRecommendationClientId(
  req: OptionalUserOrServiceRequest,
  suppliedClientId: string | undefined,
): Promise<string | undefined> {
  if (!suppliedClientId) {
    return undefined;
  }

  // No id-format guard: it existed to stop a Mongoose `CastError`, and it also
  // normalized both sides through `new ObjectId(...).toHexString()` so two
  // spellings of one ObjectId compared equal. A `text` id has ONE spelling and
  // an unknown one simply matches no row, so the comparison is plain equality.
  const requestedAppId = suppliedClientId;

  // SERVICE token: authorized only for its own application.
  const serviceAppId = req.serviceApp?.appId;
  if (serviceAppId) {
    if (serviceAppId === requestedAppId) {
      return requestedAppId;
    }
    logger.warn('recommendations: dropping unauthorized clientId', {
      suppliedClientId,
      serviceAppId,
      hasUserSession: false,
    });
    return undefined;
  }

  // USER session: authorized only when the OPERATOR has effective access to the
  // application's owning account (a member of the account, with inheritance).
  // The operator, not the session's subject: while acting as an organization the
  // subject is that organization, which is not a member of itself, so asking it
  // refuses the very people who own the application.
  if (!req.user?._id) {
    return undefined;
  }
  const userId = await resolveOperatorId(req);

  const [application] = await getDb()
    .select({ ownerAccountId: applications.ownerAccountId })
    .from(applications)
    .where(eq(applications.id, requestedAppId))
    .limit(1);
  if (application?.ownerAccountId) {
    const access = await accountService.resolveEffectiveAccess(
      userId,
      application.ownerAccountId
    );
    if (access) {
      return requestedAppId;
    }
  }

  logger.warn('recommendations: dropping unauthorized clientId', {
    suppliedClientId,
    serviceAppId: null,
    hasUserSession: true,
  });
  return undefined;
}

/**
 * Popularity-ranked fallback used by the scored builder whenever the personalized
 * candidate union is empty — anonymous callers (no viewer → no graph/app/boost
 * candidates) and cold-start viewers (a viewer who follows accounts with no
 * mutual overlap and triggers no app signals/boosts).
 *
 * Returns eligible public profiles ranked by follower count (most-followed
 * first), topping up with a random eligible sample only when popularity yields
 * fewer than `limit`. Mirrors the proven popular path while honoring the same
 * eligibility, privacy, exclusion (self/following/caller excludeIds) and
 * profile-quality gates as the scored path, and emits the uniform scored row
 * shape (`score: 0`, `mutualCount: 0`) so the response contract is identical.
 */
async function buildPopularFallback(
  excludeIds: readonly string[],
  excludeTypes: readonly ExcludableUserType[],
  parsedLimit: number,
  parsedOffset: number,
  minFederatedResolvedAt: Date,
): Promise<RecommendationRow[]> {
  const db = getDb();

  const eligibility = (): SQL => {
    const clauses: SQL[] = [
      sql`${users.privacyIsPrivateAccount} = false`,
      eligibleUserPredicate(minFederatedResolvedAt),
    ];
    if (excludeTypes.length > 0) {
      clauses.push(notInArray(users.type, [...excludeTypes]));
    }
    return and(...clauses) ?? sql`true`;
  };

  // The bounded recent-edge window, grouped by followed account. `id` is the
  // sort tiebreaker in BOTH sorts, so the window and the ranking are each a
  // strict total order and the paged result is stable.
  const recentWindow = db
    .select({ followedId: userFollows.followedId })
    .from(userFollows)
    .where(excludeIds.length > 0 ? notInArray(userFollows.followedId, [...excludeIds]) : undefined)
    .orderBy(sql`${userFollows.createdAt} desc`, sql`${userFollows.id} asc`)
    .limit(PUBLIC_POPULAR_FOLLOW_WINDOW)
    .as('recent_window');

  const ranked = await db
    .select({
      id: recentWindow.followedId,
      followersCount: sql<number>`count(*)::int`,
    })
    .from(recentWindow)
    .groupBy(recentWindow.followedId)
    .orderBy(sql`count(*) desc`, sql`${recentWindow.followedId} asc`)
    .offset(parsedOffset)
    .limit(parsedLimit + PUBLIC_FILTER_HEADROOM);

  let profiles: RecommendationRow[] = [];
  if (ranked.length > 0) {
    const rankedIds = ranked.map((row) => row.id);
    const rows = await db
      .select({ ...recommendationColumns, ...publicUserFollowCounts })
      .from(users)
      .where(and(inArray(users.id, rankedIds), eligibility()))
      .limit(parsedLimit);

    // Ranking order is the id order above; the eligibility read does not carry
    // it, so it is re-applied here rather than left to the planner.
    const byId = new Map(rows.map((row) => [row._id, row]));
    profiles = rankedIds
      .map((id) => byId.get(id))
      .filter((row): row is (typeof rows)[number] => row !== undefined);
  }

  // Top up with a random eligible sample only on the first page, when popularity
  // alone could not fill the requested limit (e.g. a sparse graph). Offset pages
  // never random-fill so pagination stays deterministic.
  if (profiles.length < parsedLimit && parsedOffset === 0) {
    const alreadyIncluded = profiles.map((u) => u._id);
    const fillLimit = parsedLimit - profiles.length;

    // `order by random()` and not `TABLESAMPLE`: the sample must respect the
    // eligibility predicate, and TABLESAMPLE picks PAGES before any WHERE runs,
    // so it would return nothing on a sparse eligible set — which is precisely
    // the case this top-up exists for.
    const randomUsers = await db
      .select({ ...recommendationColumns, ...publicUserFollowCounts })
      .from(users)
      .where(and(notInArray(users.id, [...excludeIds, ...alreadyIncluded]), eligibility()))
      .orderBy(sql`random()`)
      .limit(fillLimit);

    profiles = profiles.concat(randomUsers);
  }

  // Stamp the uniform scored-row fields so the popular fallback and the scored
  // path return the identical shape.
  return profiles.map((row) => ({ ...row, mutualCount: 0, score: 0, matchedSignals: [] }));
}

/**
 * SCORED recommendation builder. A single aggregation over the candidate
 * union (mutual-overlap window ∪ app-signal candidates ∪ boost members) minus
 * the viewer/following/excludeIds, ranked by a weighted composite of:
 *   graph (mutual overlap), completeness, verified, curation (endorsement
 *   roll-up), interest, appBoost (caller boost map), and repCandidate
 *   (denormalized reputation rank weight). `restricted` users are floored out.
 */
async function buildRecommendationsScored(
  viewerId: string | undefined,
  opts: RecommendationOptions
): Promise<ReturnType<typeof formatProfileResult>[]> {
  const { limit: parsedLimit, offset: parsedOffset, excludeTypes } = opts;
  const minFederatedResolvedAt = new Date(Date.now() - FEDERATED_RECOMMENDATION_MAX_AGE_MS);
  const weights = resolveWeightProfile(opts.clientId, opts.signalWeights);

  const db = getDb();

  // ---- Pre-queries -------------------------------------------------------
  // 1. The viewer's following set (for graph signal + exclusion).
  let followingIds: string[] = [];
  if (viewerId) {
    const following = await db
      .select({ followedId: userFollows.followedId })
      .from(userFollows)
      .where(eq(userFollows.followerId, viewerId))
      .limit(MAX_FOLLOWING_FOR_MUTUALS);
    followingIds = following.map((edge) => edge.followedId);
  }

  // 2. Mutual-overlap map (people followed by the people the viewer follows),
  //    bounded to the top window so the in-memory map stays small.
  const mutualMap = new Map<string, number>();
  if (followingIds.length > 0) {
    const mutualRows = await db
      .select({
        id: userFollows.followedId,
        mutualCount: sql<number>`count(*)::int`,
      })
      .from(userFollows)
      .where(inArray(userFollows.followerId, followingIds))
      .groupBy(userFollows.followedId)
      .orderBy(sql`count(*) desc`, sql`${userFollows.followedId} asc`)
      .limit(MUTUAL_COUNT_WINDOW);
    for (const row of mutualRows) {
      mutualMap.set(row.id, row.mutualCount);
    }
  }

  // 3. App-signal candidates for the selected app (top endorsement/interest).
  const appSignalMap = new Map<string, { endorsementScore: number; interestScore: number }>();
  if (opts.clientId) {
    const signalRows = await db
      .select({
        userId: appUserSignals.userId,
        endorsementScore: appUserSignals.endorsementScore,
        interestScore: appUserSignals.interestScore,
      })
      .from(appUserSignals)
      .where(eq(appUserSignals.applicationId, opts.clientId))
      .orderBy(sql`${appUserSignals.endorsementScore} desc`)
      .limit(MAX_APP_SIGNAL_CANDIDATES);
    for (const row of signalRows) {
      appSignalMap.set(row.userId, {
        endorsementScore: row.endorsementScore,
        interestScore: row.interestScore,
      });
    }
  }

  // 3b. Interaction-affinity map (candidate id → decayed-on-read affinity).
  //     The viewer's strongest directed affinity edges within the selected app,
  //     decayed once more on read so a dormant relationship fades toward 0.
  //     Empty when the viewer has no edges (no app context, or no events folded
  //     yet) → 0 contribution and no injected candidates (strict no-op).
  const affinityMap = new Map<string, number>();
  if (viewerId && opts.clientId) {
    const nowMs = Date.now();
    const affinityRows = await db
      .select({
        toUserId: appAffinityEdges.toUserId,
        affinity: appAffinityEdges.affinity,
        lastEventAt: appAffinityEdges.lastEventAt,
      })
      .from(appAffinityEdges)
      .where(
        and(
          eq(appAffinityEdges.applicationId, opts.clientId),
          eq(appAffinityEdges.fromUserId, viewerId)
        )
      )
      .orderBy(sql`${appAffinityEdges.affinity} desc`)
      .limit(MAX_AFFINITY_CANDIDATES);
    for (const row of affinityRows) {
      const decayed = decayAffinity(row.affinity, row.lastEventAt, nowMs);
      if (decayed > 0) {
        affinityMap.set(row.toUserId, decayed);
      }
    }
  }

  // 4. Boost map (member id → summed boost weight). Boost members join the
  //    candidate union but still pass the eligibility/privacy gate.
  const boostMap = new Map<string, number>();
  for (const boost of opts.boosts ?? []) {
    for (const userId of boost.userIds) {
      if (typeof userId !== 'string' || userId.length === 0) continue;
      boostMap.set(userId, (boostMap.get(userId) ?? 0) + boost.weight);
    }
  }

  // ---- Candidate union minus excludeIds ∪ following ∪ self ----------------
  // No id normalization: a `text` id has ONE spelling, so the set membership
  // that `new ObjectId(...).toHexString()` used to guarantee is now structural.
  const excluded = new Set<string>(opts.excludeIds.filter((id) => typeof id === 'string' && id.length > 0));
  if (viewerId) {
    excluded.add(viewerId);
  }
  for (const id of followingIds) {
    excluded.add(id);
  }

  const candidateKeys = new Set<string>();
  for (const key of mutualMap.keys()) candidateKeys.add(key);
  for (const key of appSignalMap.keys()) candidateKeys.add(key);
  for (const key of affinityMap.keys()) candidateKeys.add(key);
  for (const key of boostMap.keys()) candidateKeys.add(key);
  for (const key of excluded) candidateKeys.delete(key);

  const candidateIds = Array.from(candidateKeys);

  // When the personalized candidate union is empty (anonymous caller, or a
  // cold-start viewer with no mutual overlap / app signals / boosts), fall back
  // to popularity-ranked eligible profiles so the surface is never blank and the
  // anonymous case returns the most-followed accounts (not a random sample). The
  // fallback honors the same self/following/excludeIds exclusion set and emits
  // the uniform scored-row shape.
  if (candidateIds.length === 0) {
    const fallbackRows = await buildPopularFallback(
      Array.from(excluded),
      excludeTypes,
      parsedLimit,
      parsedOffset,
      minFederatedResolvedAt,
    );
    return fallbackRows.map(formatProfileResult);
  }

  // ---- Single scoring pass over the candidate users -----------------------
  //
  // The three score components Mongo computed in `$addFields` are ordinary SQL
  // expressions. Follower/following counts are deliberately NOT computed here —
  // they are looked up for the final page only (see below), so the scoring pass
  // never pays a per-candidate count for a candidate that will not be returned.
  const repNormDenominator = REP_WEIGHT_NORM_MAX - REP_WEIGHT_NORM_MIN;

  /** A text column holds a real value: present AND not the empty string. */
  const filled = (column: SQL) => sql`(${column} is not null and ${column} <> '')`;

  const eligibilityClauses: SQL[] = [
    sql`${users.privacyIsPrivateAccount} = false`,
    eligibleUserPredicate(minFederatedResolvedAt),
  ];
  if (excludeTypes.length > 0) {
    eligibilityClauses.push(notInArray(users.type, [...excludeTypes]));
  }

  const rows = await db
    .select({
      ...recommendationColumns,
      reputationRankWeight: users.reputationRankWeight,
      // completeness = (has avatar + has structured name + has bio/description) / 3
      completenessScore: sql<number>`(
        (case when ${filled(sql`${users.avatar}`)} then 1 else 0 end)
        + (case when ${filled(sql`${users.nameFirst}`)} or ${filled(sql`${users.nameLast}`)} then 1 else 0 end)
        + (case when ${filled(sql`${users.bio}`)} or ${filled(sql`${users.description}`)} then 1 else 0 end)
      )::double precision / 3`,
      verifiedScore: sql<number>`(case when ${users.verified} then 1 else 0 end)::double precision`,
      // repCandScore = normalize(reputation_rank_weight) into [0, 1].
      repCandScore: sql<number>`greatest(0::double precision, least(1::double precision,
        (coalesce(${users.reputationRankWeight}, ${INFLUENCE_MIN}) - ${REP_WEIGHT_NORM_MIN})
        / ${repNormDenominator}))`,
    })
    .from(users)
    .where(and(inArray(users.id, candidateIds), ...eligibilityClauses));

  // ---- Compose composite score in app code (per-candidate signals live in
  //      the in-memory maps; aggregation-only signals come from the projection).
  const scored = rows.map((row) => {
    const key = row._id;
    const mutual = mutualMap.get(key) ?? 0;
    const appSignal = appSignalMap.get(key);
    const endorsement = appSignal?.endorsementScore ?? 0;
    const interest = appSignal?.interestScore ?? 0;
    const boost = boostMap.get(key) ?? 0;
    // Decayed affinity for this candidate, normalized to [0, 1]. Absent → 0.
    const affinityScore = normalizeAffinity(affinityMap.get(key) ?? 0);

    const graphScore = Math.min(mutual / MUTUAL_COUNT_SATURATION, 1);
    const curationScore = Math.max(
      0,
      Math.min(endorsement / ENDORSEMENT_SCORE_SATURATION, 1)
    );
    const completeness = row.completenessScore;
    const verifiedScore = row.verifiedScore;
    const repCand = row.repCandScore;

    const terms: Array<[RecommendationSignal, number]> = [
      ['graph', graphScore],
      ['completeness', completeness],
      ['verified', verifiedScore],
      ['curation', curationScore],
      ['interest', interest],
      ['appBoost', boost],
      ['repCandidate', repCand],
      ['affinity', affinityScore],
    ];

    let score = 0;
    const matchedSignals: string[] = [];
    for (const [signal, value] of terms) {
      const contribution = weights[signal] * value;
      score += contribution;
      if (contribution > 0) matchedSignals.push(signal);
    }

    return { row: { ...row, mutualCount: mutual, score, matchedSignals } };
  });

  // Sort by score desc, stable by _id; page with skip/limit.
  //
  // NO native-first tier is injected here — unlike people search (`GET
  // /profiles/search`), this scored "who to follow" path already MODELS
  // federation and is already deterministic: federated candidates are surfaced
  // only through real graph/app signals (mutual overlap, endorsements, affinity,
  // boosts — never a blanket regex), stale federated actors are aged out by
  // `minFederatedResolvedAt`, and `excludeTypes` can drop them entirely. Forcing
  // native-above-federated regardless of score would contradict the explicit
  // product intent of this surface (a weighted composite recommendation), so we
  // keep the composite score and let `_id` provide the stable pagination
  // tiebreaker instead.
  scored.sort((a, b) => {
    if (b.row.score !== a.row.score) return b.row.score - a.row.score;
    return a.row._id.localeCompare(b.row._id);
  });

  const pageRows = scored
    .slice(parsedOffset, parsedOffset + parsedLimit)
    .map((s) => s.row);

  // Follower/following counts are looked up for the PAGE ONLY — a single
  // aggregation over the (≤ limit) returned ids — so the scoring pass never pays
  // the per-candidate count lookup for candidates that fall off the page.
  const pageIds = pageRows.map((row) => row._id);
  const countMap = new Map<string, { followers: number; following: number }>();
  if (pageIds.length > 0) {
    const counted = await db
      .select({ id: users.id, ...publicUserFollowCounts })
      .from(users)
      .where(inArray(users.id, pageIds));
    for (const row of counted) {
      countMap.set(row.id, {
        followers: row.followersCount,
        following: row.followingCount,
      });
    }
  }

  return pageRows.map((row) => {
    const counts = countMap.get(row._id);
    return formatProfileResult({
      ...row,
      followersCount: counts?.followers ?? 0,
      followingCount: counts?.following ?? 0,
    });
  });
}

/**
 * Single shared entry point for both the GET and POST recommendation surfaces.
 * Runs the reputation-weighted scored builder (the only recommendation path) and
 * wraps the result in a per-viewer Redis cache (TTL bounded by
 * `REC_CACHE_TTL_SECONDS`) keyed including the viewer id so an anonymous and an
 * authenticated response are never shared. Cache is a best-effort optimization —
 * a null Redis client (REDIS_URL unset) transparently falls back to no cache.
 */
async function buildRecommendations(
  viewerId: string | undefined,
  opts: RecommendationOptions
): Promise<ReturnType<typeof formatProfileResult>[]> {
  const redis = getRedisClient();
  const cacheKey = redis
    ? `rec:v2:${viewerId ?? 'anon'}:${JSON.stringify({
        limit: opts.limit,
        offset: opts.offset,
        excludeTypes: opts.excludeTypes,
        excludeIds: opts.excludeIds,
        clientId: opts.clientId ?? null,
        boosts: opts.boosts ?? null,
        signalWeights: opts.signalWeights ?? null,
      })}`
    : null;

  if (redis && cacheKey) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as ReturnType<typeof formatProfileResult>[];
      }
    } catch (error) {
      logger.warn('recommendations: cache read failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const result = await buildRecommendationsScored(viewerId, opts);

  if (redis && cacheKey) {
    try {
      await redis.set(cacheKey, JSON.stringify(result), 'EX', REC_CACHE_TTL_SECONDS);
    } catch (error) {
      logger.warn('recommendations: cache write failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

/**
 * GET /profiles/recommendations
 *
 * Get recommended user profiles. Maps the query string to the shared
 * {@link buildRecommendations}, which runs the reputation-weighted scorer.
 *
 * Optional auth: when a valid session token is present the response is
 * personalized; when absent it returns popular public profiles. Private accounts
 * are always excluded; `excludeTypes` filters federated/agent/automated users.
 *
 * @query {number} limit - Number of results (max 100, default 10)
 * @query {number} offset - Pagination offset (default 0)
 * @query {string} excludeTypes - Comma-separated user types to exclude
 *   (federated, agent, automated)
 * @returns {UserProfile[]} List of recommended profiles
 */
router.get(
  '/recommendations',
  optionalUserOrServiceAuth,
  validatePagination,
  asyncHandler(async (req: OptionalUserOrServiceRequest, res: Response) => {
    const { limit, offset, excludeTypes: excludeTypesRaw } = req.query as PaginationQuery & { excludeTypes?: string };
    const currentUserId = resolveViewerId(req);

    const excludeTypes = parseExcludeTypesQuery(excludeTypesRaw);

    const parsedLimit = limit
      ? Math.min(Number.parseInt(limit, 10), PAGINATION.MAX_LIMIT)
      : PAGINATION.DEFAULT_LIMIT;
    const parsedOffset = offset ? Number.parseInt(offset, 10) : 0;

    logger.debug('GET /profiles/recommendations', {
      currentUserId: currentUserId ?? null,
      authenticated: !!currentUserId,
      limit: parsedLimit,
      offset: parsedOffset,
    });

    const recommendations = await buildRecommendations(currentUserId, {
      limit: parsedLimit,
      offset: parsedOffset,
      excludeTypes,
      excludeIds: [],
    });

    sendSuccess(res, recommendations);
  })
);

/**
 * POST /profiles/recommendations
 *
 * Rich recommendation surface accepting a JSON body: per-app weight profile
 * (`clientId`), explicit `excludeIds`, editorial `boosts`, and per-request
 * `signalWeights`. Optional auth (same personalization rules as GET). Validates
 * the body against `recommendationRequestSchema`. Shares the exact builder/cache
 * with GET, so identical inputs yield identical output.
 */
router.post(
  '/recommendations',
  optionalUserOrServiceAuth,
  validate({ body: recommendationRequestSchema }),
  asyncHandler(async (req: OptionalUserOrServiceRequest, res: Response) => {
    const currentUserId = resolveViewerId(req);
    const body = req.body as RecommendationRequest;

    const parsedLimit = body.limit ?? PAGINATION.DEFAULT_LIMIT;
    const parsedOffset = body.offset ?? 0;

    // Only honor a clientId the caller is actually entitled to (its own service
    // application, or an application the user actively belongs to). An
    // unauthorized clientId is dropped → no app context.
    const authorizedClientId = await resolveAuthorizedRecommendationClientId(req, body.clientId);

    logger.debug('POST /profiles/recommendations', {
      currentUserId: currentUserId ?? null,
      authenticated: !!currentUserId,
      limit: parsedLimit,
      offset: parsedOffset,
      clientId: authorizedClientId ?? null,
    });

    const recommendations = await buildRecommendations(currentUserId, {
      limit: parsedLimit,
      offset: parsedOffset,
      excludeTypes: (body.excludeTypes ?? []).filter(isExcludableUserType),
      excludeIds: body.excludeIds ?? [],
      clientId: authorizedClientId,
      boosts: body.boosts,
      signalWeights: body.signalWeights,
    });

    sendSuccess(res, recommendations);
  })
);

export default router;
