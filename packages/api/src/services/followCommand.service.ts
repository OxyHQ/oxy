import { expandEquivalentUserIds, getEquivalentUserIds } from './externalIdentityRegistry.service';
/**
 * The ONE place a follow relationship changes.
 *
 * Every mutation — from an application, from an expiry sweep, from an inbound
 * federation activity, from a migration — goes through here, and each does
 * three things in a SINGLE transaction:
 *
 *   1. the authoritative row in `follow_relationships`
 *   2. the `user_follows` projection, when the target is an Oxy account
 *   3. an event in `follow_events`
 *
 * One transaction is the whole design. Two writes that can succeed
 * independently will eventually disagree, and the disagreement is invisible: a
 * relationship with no event never federates and never notifies; an event with
 * no relationship makes a remote server believe in a follow nobody has. Neither
 * shows up as an error anywhere.
 *
 * ## Why `user_follows` stays
 *
 * It is the optimized account graph every existing read sits on — recommendations,
 * mutuals, follows-of-follows, the paginated lists, `graphExclusion`. #809 is
 * explicit that it must not be removed before its replacement is benchmarked and
 * every reader has moved. So user-to-user follows write BOTH, in the same
 * transaction, which is what makes drift unrepresentable rather than merely
 * unlikely.
 *
 * ## Idempotency
 *
 * Following twice is one relationship, one event, one count movement. The
 * unique constraint on (follower, target) does the work, and the command reads
 * back what actually happened rather than assuming — `created` is the return of
 * the insert, not a guess made before it.
 */

import { and, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../config/postgres';
import { followApplicationOverrides } from '../db/schema/followApplicationOverrides';
import { followEvents, type FollowEventCause, type FollowEventType } from '../db/schema/followEvents';
import { followRelationships, type FOLLOW_SOURCES } from '../db/schema/followRelationships';
import { followTargets } from '../db/schema/followTargets';
import { userFollows } from '../db/schema/userFollows';
import { blocks } from '../db/schema/blocks';
import { BadRequestError } from '../utils/error';
import graphCache from '../utils/graphCache';
import { logger } from '../utils/logger';
import userCache from '../utils/userCache';
import type { FollowCapability } from './followCapability.service';

/** A transaction handle, or the pool when a caller has no transaction of its own. */
type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface FollowStatus {
  relationshipId?: string;
  globalState: 'none' | 'requested' | 'active' | 'rejected';
  applicationMode: 'inherit' | 'enabled' | 'disabled';
  effectiveState: 'not_following' | 'requested' | 'following';
  expiresAt?: string;
}

/**
 * The platform acting without an application behind it — expiry, reconciliation,
 * an inbound federation activity. Deliberately a DIFFERENT type from
 * {@link FollowCapability}: those carry a user's grant, and this carries the
 * absence of one, which a caller should have to say out loud.
 */
export interface SystemCapability {
  userId: string;
  applicationId: string | null;
  grantId: string | null;
  scopes: readonly string[];
  sessionId: string;
}

export interface FollowResult {
  relationshipId: string;
  /** False when the relationship already existed — no event, no count movement. */
  created: boolean;
  status: FollowStatus;
}

/**
 * A stable event id.
 *
 * Deterministic from (type, relationship, moment) rather than random, so a
 * command retried after a crash between transaction and acknowledgement writes
 * the same id and the unique constraint absorbs it. Randomness here would make
 * a retry look like a second event, which is exactly what a consumer cannot
 * tell apart.
 */
function eventId(type: FollowEventType, relationshipId: string, at: Date): string {
  return `${type}:${relationshipId}:${at.getTime()}`;
}

/** Invalidate cached graph projections after `user_follows` changes. */
async function invalidateAccountFollowCaches(
  followerId: string,
  followedId: string
): Promise<void> {
  await Promise.all([graphCache.invalidate(followerId), graphCache.invalidate(followedId)]);
  userCache.invalidate(followerId, 'graph');
  userCache.invalidate(followedId, 'graph');
}

/**
 * Effective state = the global relationship, unless this application says
 * otherwise.
 *
 * Absence of an override means inherit. That is the default and the common
 * case, so it is expressed as "no row" rather than as a value nobody wrote.
 */
function effectiveState(
  globalState: FollowStatus['globalState'],
  mode: FollowStatus['applicationMode']
): FollowStatus['effectiveState'] {
  if (mode === 'disabled') return 'not_following';
  if (globalState === 'active') return 'following';
  if (globalState === 'requested') return 'requested';
  return 'not_following';
}

/** Exported for serializers that mirror {@link readStatus} without a round trip. */
export function deriveFollowEffectiveState(
  globalState: FollowStatus['globalState'],
  mode: FollowStatus['applicationMode']
): FollowStatus['effectiveState'] {
  return effectiveState(globalState, mode);
}

async function equivalentTargetIds(db: Tx | Db, targetId: string): Promise<string[]> {
  const [target] = await db.select({ localUserId: followTargets.localUserId }).from(followTargets).where(eq(followTargets.id, targetId));
  if (!target?.localUserId) return [targetId];
  return (await db.select({ id: followTargets.id }).from(followTargets)
    .where(inArray(followTargets.localUserId, await getEquivalentUserIds(target.localUserId, db)))).map(row => row.id);
}

async function readStatus(tx: Tx | Db, userId: string, applicationId: string, targetId: string): Promise<FollowStatus> {
  const relationships = await tx.select().from(followRelationships).where(and(
    inArray(followRelationships.followerUserId, await getEquivalentUserIds(userId, tx)),
    inArray(followRelationships.followTargetId, await equivalentTargetIds(tx, targetId)),
  ));
  const relationship = relationships.find(row => row.state === 'active') ?? relationships.find(row => row.state === 'requested') ?? relationships[0];
  if (!relationship) return { globalState: 'none', applicationMode: 'inherit', effectiveState: 'not_following' };
  const overrides = await tx.select().from(followApplicationOverrides).where(and(
    inArray(followApplicationOverrides.relationshipId, relationships.map(row => row.id)),
    eq(followApplicationOverrides.applicationId, applicationId),
  ));
  const mode = overrides.some(row => row.mode === 'disabled') ? 'disabled' : overrides.some(row => row.mode === 'enabled') ? 'enabled' : 'inherit';
  return { relationshipId: relationship.id, globalState: relationship.state, applicationMode: mode,
    effectiveState: effectiveState(relationship.state, mode),
    ...(relationship.expiresAt ? { expiresAt: relationship.expiresAt.toISOString() } : {}),
  };
}

/** Write the outbox row. Always inside the caller's transaction — never after it. */
async function emit(
  tx: Tx,
  input: {
    type: FollowEventType;
    cause: FollowEventCause;
    /**
     * `applicationId` and `grantId` are nullable here and nowhere else. A user
     * action always has both; expiry and reconciliation are the PLATFORM acting
     * on an instruction the user already gave, so there is no application asking
     * and no grant to cite. Writing `''` instead would be a foreign key that
     * names nothing — it fails the insert, and inside a sweep that failure is a
     * silently skipped expiry.
     */
    capability: {
      userId: string;
      applicationId?: string | null;
      grantId?: string | null;
    };
    relationshipId: string;
    targetUri: string;
    targetKind: string;
    contextApplicationId?: string;
    at: Date;
  }
): Promise<void> {
  await tx
    .insert(followEvents)
    .values({
      eventId: eventId(input.type, input.relationshipId, input.at),
      type: input.type,
      cause: input.cause,
      actorUserId: input.capability.userId,
      relationshipId: input.relationshipId,
      targetUri: input.targetUri,
      targetKind: input.targetKind,
      ...(input.capability.applicationId
        ? { originApplicationId: input.capability.applicationId }
        : {}),
      ...(input.capability.grantId ? { grantId: input.capability.grantId } : {}),
      ...(input.contextApplicationId ? { contextApplicationId: input.contextApplicationId } : {}),
    })
    // A retried command writes the same deterministic id. Absorbing it here is
    // what makes the retry a no-op instead of a duplicate delivery.
    .onConflictDoNothing({ target: followEvents.eventId });
}

/**
 * Follow a target the caller has already resolved.
 *
 * Takes a target ROW rather than a URI: resolving or registering a target is a
 * separate concern with its own authorization (`follow-targets:register`), and
 * folding it in here would let a follow silently create registry entries.
 */
export async function followTarget(input: {
  capability: FollowCapability;
  target: { id: string; canonicalUri: string; kind: string; localUserId: string | null };
  expiresAt?: Date | null;
  cause?: FollowEventCause;
}): Promise<FollowResult> {
  const { capability, target } = input;
  const at = new Date();

  if (target.localUserId && target.localUserId === capability.userId) {
    throw new BadRequestError('Cannot follow yourself');
  }

  const result = await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'follow:' + capability.userId}))`);
    const existingStatus = await readStatus(tx, capability.userId, capability.applicationId, target.id);
    if (existingStatus.relationshipId) return { relationshipId: existingStatus.relationshipId, created: false, status: existingStatus };
    const inserted = await tx
      .insert(followRelationships)
      .values({
        followerUserId: capability.userId,
        followTargetId: target.id,
        state: 'active',
        originApplicationId: capability.applicationId,
        createdByGrantId: capability.grantId,
        source: 'app',
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      })
      // Following twice is one relationship. The insert reports which case this
      // was, so `created` is observed rather than predicted.
      .onConflictDoNothing({
        target: [followRelationships.followerUserId, followRelationships.followTargetId],
      })
      .returning({ id: followRelationships.id });

    const created = inserted.length === 1;
    const relationshipId = created
      ? inserted[0].id
      : (
          await tx
            .select({ id: followRelationships.id })
            .from(followRelationships)
            .where(
              and(
                eq(followRelationships.followerUserId, capability.userId),
                eq(followRelationships.followTargetId, target.id)
              )
            )
            .limit(1)
        )[0].id;

    if (created) {
      // The account graph, in the SAME transaction. Two statements that could
      // succeed independently is how a follower count starts disagreeing with
      // the follow list, and nothing would report it.
      if (target.localUserId) {
        await tx
          .insert(userFollows)
          .values({ followerId: capability.userId, followedId: target.localUserId })
          .onConflictDoNothing();
      }

      await emit(tx, {
        type: 'follow.created',
        cause: input.cause ?? 'user_action',
        capability,
        relationshipId,
        targetUri: target.canonicalUri,
        targetKind: target.kind,
        at,
      });
    }

    const status = await readStatus(tx, capability.userId, capability.applicationId, target.id);
    return { relationshipId, created, status };
  });

  if (result.created && target.localUserId) {
    await invalidateAccountFollowCaches(capability.userId, target.localUserId);
  }

  return result;
}

/**
 * Remove a relationship everywhere.
 *
 * Deletes the per-application overrides with it: they describe a relationship
 * that no longer exists, and leaving them would make a later re-follow inherit
 * a "disabled here" the user set months ago and has no way to remember.
 */
export async function unfollowEverywhere(input: {
  capability: FollowCapability | SystemCapability;
  relationshipId: string;
  cause?: FollowEventCause;
}): Promise<{ removed: boolean }> {
  const { capability, relationshipId } = input;
  const at = new Date();

  const result = await getDb().transaction(async (tx) => {
    const [relationship] = await tx
      .select({
        id: followRelationships.id,
        followerUserId: followRelationships.followerUserId,
        targetId: followRelationships.followTargetId,
      })
      .from(followRelationships)
      .where(eq(followRelationships.id, relationshipId))
      .limit(1);

    // Unfollowing something already gone is a success, not an error — the state
    // the caller asked for is the state that holds.
    if (!relationship || relationship.followerUserId !== capability.userId) {
      return { removed: false, followedId: null as string | null };
    }

    const [target] = await tx
      .select({
        canonicalUri: followTargets.canonicalUri,
        kind: followTargets.kind,
        localUserId: followTargets.localUserId,
      })
      .from(followTargets)
      .where(eq(followTargets.id, relationship.targetId))
      .limit(1);

    const related = await tx.select({ id: followRelationships.id, canonicalUri: followTargets.canonicalUri, kind: followTargets.kind })
      .from(followRelationships).innerJoin(followTargets, eq(followTargets.id, followRelationships.followTargetId))
      .where(and(eq(followRelationships.followerUserId, capability.userId),
        input.cause && input.cause !== 'user_action' ? eq(followRelationships.id, relationshipId) : inArray(followRelationships.followTargetId, await equivalentTargetIds(tx, relationship.targetId))));
    for (const edge of related) {
      await emit(tx, { type: 'follow.removed', cause: input.cause ?? 'user_action', capability,
        relationshipId: edge.id, targetUri: edge.canonicalUri, targetKind: edge.kind, at });
      await tx.delete(followRelationships).where(eq(followRelationships.id, edge.id));
    }

    if (target?.localUserId) {
      await tx
        .delete(userFollows)
        .where(
          and(
            eq(userFollows.followerId, capability.userId),
            input.cause && input.cause !== 'user_action' ? eq(userFollows.followedId, target.localUserId) : inArray(userFollows.followedId, await getEquivalentUserIds(target.localUserId, tx))
          )
        );
    }

    return { removed: true, followedId: target?.localUserId ?? null };
  });

  if (result.removed && result.followedId) {
    await invalidateAccountFollowCaches(capability.userId, result.followedId);
  }

  return { removed: result.removed };
}

/**
 * Turn a relationship off, or back on, in ONE application.
 *
 * Never touches the global relationship, never moves counts, never notifies the
 * followed target. The person on the other end is not told which of someone's
 * applications they appear in — that is the user's business, and telling them
 * would turn a private preference into a social signal.
 */
export async function setApplicationMode(input: {
  capability: FollowCapability;
  relationshipId: string;
  /** The application being configured. Defaults to the caller's own. */
  applicationId?: string;
  mode: 'enabled' | 'disabled';
}): Promise<{ ok: boolean }> {
  const { capability, relationshipId, mode } = input;
  const applicationId = input.applicationId ?? capability.applicationId;
  const at = new Date();

  return getDb().transaction(async (tx) => {
    const [relationship] = await tx
      .select({
        followerUserId: followRelationships.followerUserId,
        targetId: followRelationships.followTargetId,
      })
      .from(followRelationships)
      .where(eq(followRelationships.id, relationshipId))
      .limit(1);

    if (!relationship || relationship.followerUserId !== capability.userId) {
      return { ok: false };
    }

    const [target] = await tx
      .select({ canonicalUri: followTargets.canonicalUri, kind: followTargets.kind })
      .from(followTargets)
      .where(eq(followTargets.id, relationship.targetId))
      .limit(1);

    const [existing] = await tx
      .select({ mode: followApplicationOverrides.mode })
      .from(followApplicationOverrides)
      .where(
        and(
          eq(followApplicationOverrides.relationshipId, relationshipId),
          eq(followApplicationOverrides.applicationId, applicationId)
        )
      )
      .limit(1);

    if (existing?.mode === mode) {
      return { ok: true };
    }

    await tx
      .insert(followApplicationOverrides)
      .values({ relationshipId, applicationId, mode })
      .onConflictDoUpdate({
        target: [followApplicationOverrides.relationshipId, followApplicationOverrides.applicationId],
        set: { mode, updatedAt: at },
      });

    await emit(tx, {
      type: mode === 'disabled' ? 'follow.context_disabled' : 'follow.context_enabled',
      cause: 'user_action',
      capability,
      relationshipId,
      targetUri: target?.canonicalUri ?? '',
      targetKind: target?.kind ?? '',
      contextApplicationId: applicationId,
      at,
    });

    return { ok: true };
  });
}

/**
 * Drop an override so the relationship inherits the global state again.
 *
 * A DELETE rather than writing `enabled`, because "I never said" and "I said
 * yes here" are different answers and only the first one keeps following a
 * future change of default.
 */
export async function restoreInheritance(input: {
  capability: FollowCapability;
  relationshipId: string;
  applicationId?: string;
}): Promise<{ ok: boolean }> {
  const { capability, relationshipId } = input;
  const applicationId = input.applicationId ?? capability.applicationId;

  const at = new Date();

  return getDb().transaction(async (tx) => {
    const [relationship] = await tx
      .select({
        followerUserId: followRelationships.followerUserId,
        targetId: followRelationships.followTargetId,
      })
      .from(followRelationships)
      .where(eq(followRelationships.id, relationshipId))
      .limit(1);

    if (!relationship || relationship.followerUserId !== capability.userId) {
      return { ok: false };
    }

    const [target] = await tx
      .select({ canonicalUri: followTargets.canonicalUri, kind: followTargets.kind })
      .from(followTargets)
      .where(eq(followTargets.id, relationship.targetId))
      .limit(1);

    const removed = await tx
      .delete(followApplicationOverrides)
      .where(
        and(
          eq(followApplicationOverrides.relationshipId, relationshipId),
          eq(followApplicationOverrides.applicationId, applicationId)
        )
      )
      .returning({ id: followApplicationOverrides.id });

    if (removed.length > 0) {
      await emit(tx, {
        type: 'follow.context_enabled',
        cause: 'user_action',
        capability,
        relationshipId,
        targetUri: target?.canonicalUri ?? '',
        targetKind: target?.kind ?? '',
        contextApplicationId: applicationId,
        at,
      });
    }

    return { ok: true };
  });
}

/** What the caller's application sees for this target. */
export async function getFollowStatus(input: {
  capability: FollowCapability;
  targetId: string;
}): Promise<FollowStatus> {
  return readStatus(
    getDb(),
    input.capability.userId,
    input.capability.applicationId,
    input.targetId
  );
}

/**
 * Expire the relationships whose time is up.
 *
 * Deliberately routed through `unfollowEverywhere` rather than deleting rows
 * directly: an expiry has to emit `follow.removed`, tear down federation and
 * move counts exactly like a manual unfollow. A shortcut here would leave the
 * remote side believing the relationship still exists, and nothing would ever
 * report it.
 *
 * `cause: 'expired'` is what lets a consumer tell it from a decision — the
 * notification policy cares, because nobody was told there was a clock.
 */
export async function expireDueFollows(now = new Date(), limit = 500): Promise<number> {
  const due = await getDb()
    .select({
      id: followRelationships.id,
      followerUserId: followRelationships.followerUserId,
      originApplicationId: followRelationships.originApplicationId,
      createdByGrantId: followRelationships.createdByGrantId,
    })
    .from(followRelationships)
    .where(and(isNotNull(followRelationships.expiresAt), lte(followRelationships.expiresAt, now)))
    .limit(limit);

  let removed = 0;
  for (const relationship of due) {
    try {
      const result = await unfollowEverywhere({
        capability: {
          userId: relationship.followerUserId,
          // The application that created it, as provenance — NULL when it is
          // gone. Expiry is the platform acting on an instruction the user
          // already gave, so there is no grant to check: they authorised this,
          // with an end date.
          applicationId: relationship.originApplicationId,
          grantId: relationship.createdByGrantId,
          scopes: [],
          sessionId: '',
        },
        relationshipId: relationship.id,
        cause: 'expired',
      });
      if (result.removed) removed += 1;
    } catch (error) {
      // One relationship failing must not stop the sweep; it stays due and the
      // next pass retries it, which is what makes expiry converge rather than
      // silently skip.
      logger.warn('[Follows] Expiry failed for one relationship', {
        relationshipId: relationship.id,
        err: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return removed;
}

/** Followers per statement in {@link moveAccountFollowers}. */
const MOVE_FOLLOWERS_CHUNK = 1000;

/** What {@link moveAccountFollowers} did, per follower. */
export interface AccountFollowersMove {
  /** Followers now following the target who were not before. */
  moved: string[];
  /** Followers who already followed the target (their old edge is still removed). */
  alreadyFollowing: string[];
  /** Followers not moved because the target and they block each other in either direction. */
  skippedBlocked: string[];
}

/**
 * Move every LOCAL follower of `fromUserId` to `toUserId` — the follow half of
 * an ActivityPub `Move` Oxy has already verified (`services/federationMove.service.ts`).
 *
 * Runs inside the CALLER's transaction, because a Move is one decision: the
 * redirect, the carried-over blocks and the follows commit together or not at
 * all. For each follower F of the old account (either graph — `user_follows`
 * or an active `follow_relationships` edge to the old account's target):
 *
 *   - a block between F and the target, in EITHER direction, skips F; blocks
 *     against the old account have already been carried to the target by the
 *     caller, so "you blocked the old account" counts;
 *   - otherwise F follows the target: one relationship (idempotent on the
 *     unique pair), the `user_follows` projection, and a `follow.created` event
 *     with cause `migration`;
 *   - F's edges to the OLD account are removed either way, with `follow.removed`
 *     events. They are not left behind because the old account now redirects to
 *     the target, and a stale edge would read as a follow of the target that the
 *     block above just refused.
 *
 * Follows BY the old account are not touched: they are the remote account's own
 * graph, which the new account rebuilds itself.
 *
 * Caches are the caller's to invalidate after commit — every id involved is in
 * the result.
 */
export async function moveAccountFollowers(
  tx: Tx,
  input: { fromUserId: string; toUserId: string; at?: Date },
): Promise<AccountFollowersMove> {
  const { fromUserId, toUserId } = input;
  const at = input.at ?? new Date();
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'follow-move:' + fromUserId}))`);

  // The target's account follow target, created the way `ensureTarget` would.
  const targetUri = `https://oxy.so/users/${toUserId}`;
  await tx
    .insert(followTargets)
    .values({ canonicalUri: targetUri, kind: 'oxy.user', localUserId: toUserId })
    .onConflictDoNothing();
  const [toTarget] = await tx
    .select({ id: followTargets.id, canonicalUri: followTargets.canonicalUri, kind: followTargets.kind })
    .from(followTargets)
    .where(eq(followTargets.localUserId, toUserId))
    .limit(1);
  if (!toTarget) throw new Error('Move target has no follow target');

  const fromTargets = await tx
    .select({ id: followTargets.id, canonicalUri: followTargets.canonicalUri, kind: followTargets.kind })
    .from(followTargets)
    .where(eq(followTargets.localUserId, fromUserId));
  const fromTargetIds = fromTargets.map((target) => target.id);

  const projected = await tx
    .select({ followerId: userFollows.followerId })
    .from(userFollows)
    .where(eq(userFollows.followedId, fromUserId));
  const related = fromTargetIds.length
    ? await tx
        .select({ id: followRelationships.id, followerUserId: followRelationships.followerUserId, followTargetId: followRelationships.followTargetId })
        .from(followRelationships)
        .where(inArray(followRelationships.followTargetId, fromTargetIds))
    : [];
  const followers = [...new Set([...projected.map((row) => row.followerId), ...related.map((row) => row.followerUserId)])]
    .filter((id) => id !== toUserId && id !== fromUserId)
    .sort();

  const result: AccountFollowersMove = { moved: [], alreadyFollowing: [], skippedBlocked: [] };
  const system = (userId: string) => ({ userId, applicationId: null, grantId: null });

  // Set-based per chunk, so a large audience is a handful of statements rather
  // than several round trips per follower, and each stays under Postgres's
  // bind-parameter ceiling.
  for (let offset = 0; offset < followers.length; offset += MOVE_FOLLOWERS_CHUNK) {
    const chunk = followers.slice(offset, offset + MOVE_FOLLOWERS_CHUNK);

    const blockRows = await tx
      .select({ userId: blocks.userId, blockedId: blocks.blockedId })
      .from(blocks)
      .where(
        or(
          and(eq(blocks.userId, toUserId), inArray(blocks.blockedId, chunk)),
          and(inArray(blocks.userId, chunk), eq(blocks.blockedId, toUserId)),
        ),
      );
    const blocked = new Set(blockRows.map((row) => (row.userId === toUserId ? row.blockedId : row.userId)));
    const eligible = chunk.filter((id) => !blocked.has(id));
    result.skippedBlocked.push(...chunk.filter((id) => blocked.has(id)));

    if (eligible.length) {
      // Following already, in EITHER graph, is "already following": the legacy
      // follow path writes only the `user_follows` projection, and it must not
      // be announced as a new follow just because its v2 row was missing.
      const projectedAlready = await tx.select({ id: userFollows.followerId }).from(userFollows)
        .where(and(eq(userFollows.followedId, toUserId), inArray(userFollows.followerId, eligible)));
      const relationshipAlready = await tx.select({ id: followRelationships.followerUserId }).from(followRelationships)
        .where(and(eq(followRelationships.followTargetId, toTarget.id), inArray(followRelationships.followerUserId, eligible)));
      const wasFollowing = new Set([...projectedAlready, ...relationshipAlready].map((row) => row.id));

      const inserted = await tx
        .insert(followRelationships)
        .values(eligible.map((followerUserId) => ({ followerUserId, followTargetId: toTarget.id, state: 'active' as const, source: 'migration' as const })))
        .onConflictDoNothing({ target: [followRelationships.followerUserId, followRelationships.followTargetId] })
        .returning({ id: followRelationships.id, followerUserId: followRelationships.followerUserId });
      await tx.insert(userFollows).values(eligible.map((followerId) => ({ followerId, followedId: toUserId }))).onConflictDoNothing();

      const insertedByFollower = new Map(inserted.map((row) => [row.followerUserId, row.id]));
      for (const followerId of eligible) {
        if (wasFollowing.has(followerId)) {
          result.alreadyFollowing.push(followerId);
          continue;
        }
        await emit(tx, {
          type: 'follow.created', cause: 'migration', capability: system(followerId),
          relationshipId: insertedByFollower.get(followerId)!, targetUri: toTarget.canonicalUri, targetKind: toTarget.kind, at,
        });
        result.moved.push(followerId);
      }
    }

    const members = new Set(chunk);
    const oldEdges = related.filter((row) => members.has(row.followerUserId));
    for (const edge of oldEdges) {
      const target = fromTargets.find((row) => row.id === edge.followTargetId);
      await emit(tx, {
        type: 'follow.removed', cause: 'migration', capability: system(edge.followerUserId),
        relationshipId: edge.id, targetUri: target?.canonicalUri ?? '', targetKind: target?.kind ?? 'oxy.user', at,
      });
    }
    if (oldEdges.length) {
      await tx.delete(followRelationships).where(inArray(followRelationships.id, oldEdges.map((edge) => edge.id)));
    }
    await tx.delete(userFollows).where(and(eq(userFollows.followedId, fromUserId), inArray(userFollows.followerId, chunk)));
  }

  return result;
}

/** Invalidate the graph caches a {@link moveAccountFollowers} result touched. Call after commit. */
export async function invalidateMovedFollowerCaches(
  input: { fromUserId: string; toUserId: string },
  moved: AccountFollowersMove,
): Promise<void> {
  const ids = new Set([input.fromUserId, input.toUserId, ...moved.moved, ...moved.alreadyFollowing, ...moved.skippedBlocked]);
  await Promise.all([...ids].map((id) => graphCache.invalidate(id)));
  for (const id of ids) userCache.invalidate(id, 'graph');
}

// =============================================================================
// ACCOUNT FOLLOWS — the user-to-user graph behind the account routes
// =============================================================================

type FollowSource = (typeof FOLLOW_SOURCES)[number];

/** The canonical follow target URI of an Oxy account. */
export function accountTargetUri(userId: string): string {
  return `https://oxy.so/users/${userId}`;
}

/**
 * The `oxy.user` follow target of each account, created the way `ensureTarget`
 * would when missing. Keyed by the account id.
 */
async function ensureAccountTargets(
  tx: Tx,
  userIds: readonly string[],
): Promise<Map<string, { id: string; canonicalUri: string; kind: string }>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  await tx
    .insert(followTargets)
    .values(ids.map((id) => ({ canonicalUri: accountTargetUri(id), kind: 'oxy.user', localUserId: id })))
    .onConflictDoNothing();
  const rows = await tx
    .select({ id: followTargets.id, canonicalUri: followTargets.canonicalUri, kind: followTargets.kind, localUserId: followTargets.localUserId })
    .from(followTargets)
    .where(inArray(followTargets.localUserId, ids));
  return new Map(rows.map((row) => [row.localUserId as string, row]));
}

/**
 * Follow Oxy accounts on the user's own behalf — the account routes
 * (`POST /users/:id/follow`, the bulk follow), an MCP connection, and the
 * federation bridge.
 *
 * The same one-transaction write as {@link followTarget}: the relationship on
 * each account's `oxy.user` target, the `user_follows` projection, and a
 * `follow.created` event per relationship this call created. No application
 * delegated the action, so the relationship carries no origin application and
 * no grant — the user acted directly.
 *
 * Callers decide WHICH accounts are followed (existence, self-follow, blocks,
 * "already following" across equivalent identities); this writes them.
 *
 * @returns The account ids whose `user_follows` edge this call created.
 */
export async function followAccounts(input: {
  followerId: string;
  followedIds: readonly string[];
  cause?: FollowEventCause;
  source?: FollowSource;
}): Promise<{ created: string[] }> {
  const { followerId } = input;
  const followedIds = [...new Set(input.followedIds)].filter((id) => id !== followerId);
  if (followedIds.length === 0) return { created: [] };
  const at = new Date();
  const actor = { userId: followerId, applicationId: null, grantId: null };

  const created = await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'follow:' + followerId}))`);
    const targets = await ensureAccountTargets(tx, followedIds);
    const targetById = new Map([...targets.values()].map((target) => [target.id, target]));

    const relationships = await tx
      .insert(followRelationships)
      .values([...targets.values()].map((target) => ({
        followerUserId: followerId,
        followTargetId: target.id,
        state: 'active' as const,
        source: input.source ?? 'app',
      })))
      .onConflictDoNothing({ target: [followRelationships.followerUserId, followRelationships.followTargetId] })
      .returning({ id: followRelationships.id, followTargetId: followRelationships.followTargetId });

    const edges = await tx
      .insert(userFollows)
      .values(followedIds.map((followedId) => ({ followerId, followedId })))
      .onConflictDoNothing()
      .returning({ followedId: userFollows.followedId });

    for (const relationship of relationships) {
      const target = targetById.get(relationship.followTargetId);
      if (!target) continue;
      await emit(tx, {
        type: 'follow.created',
        cause: input.cause ?? 'user_action',
        capability: actor,
        relationshipId: relationship.id,
        targetUri: target.canonicalUri,
        targetKind: target.kind,
        at,
      });
    }

    return edges.map((edge) => edge.followedId);
  });

  if (created.length > 0) {
    await Promise.all([graphCache.invalidate(followerId), ...created.map((id) => graphCache.invalidate(id))]);
    userCache.invalidate(followerId, 'graph');
    for (const id of created) userCache.invalidate(id, 'graph');
  }

  return { created };
}

/**
 * Unfollow Oxy accounts on the user's own behalf — the inverse of
 * {@link followAccounts}, across every equivalent identity of both sides (as
 * the account graph reads them).
 *
 * Removes the relationships with a `follow.removed` event each, and the
 * `user_follows` projection, in one transaction.
 *
 * @returns The account ids whose `user_follows` edge this call removed.
 */
export async function unfollowAccounts(input: {
  followerId: string;
  followedIds: readonly string[];
  cause?: FollowEventCause;
}): Promise<{ removed: string[] }> {
  const { followerId } = input;
  const followedIds = [...new Set(input.followedIds)].filter((id) => id !== followerId);
  if (followedIds.length === 0) return { removed: [] };
  const at = new Date();
  const actor = { userId: followerId, applicationId: null, grantId: null };

  const removed = await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'follow:' + followerId}))`);
    const followerIds = await getEquivalentUserIds(followerId, tx);
    const accountIds = await expandEquivalentUserIds(followedIds, tx);

    const relationships = await tx
      .select({ id: followRelationships.id, canonicalUri: followTargets.canonicalUri, kind: followTargets.kind })
      .from(followRelationships)
      .innerJoin(followTargets, eq(followTargets.id, followRelationships.followTargetId))
      .where(and(inArray(followRelationships.followerUserId, followerIds), inArray(followTargets.localUserId, accountIds)));
    for (const relationship of relationships) {
      await emit(tx, {
        type: 'follow.removed',
        cause: input.cause ?? 'user_action',
        capability: actor,
        relationshipId: relationship.id,
        targetUri: relationship.canonicalUri,
        targetKind: relationship.kind,
        at,
      });
    }
    if (relationships.length > 0) {
      await tx.delete(followRelationships).where(inArray(followRelationships.id, relationships.map((row) => row.id)));
    }

    const edges = await tx
      .delete(userFollows)
      .where(and(inArray(userFollows.followerId, followerIds), inArray(userFollows.followedId, accountIds)))
      .returning({ followedId: userFollows.followedId });
    return edges.map((edge) => edge.followedId);
  });

  if (removed.length > 0) {
    await Promise.all([graphCache.invalidate(followerId), ...removed.map((id) => graphCache.invalidate(id))]);
    userCache.invalidate(followerId, 'graph');
    for (const id of removed) userCache.invalidate(id, 'graph');
  }

  return { removed };
}

/**
 * Remove every follow relationship touching an account — the ones it holds and
 * the ones on its `oxy.user` target — with a `follow.removed` event each
 * (`reconciliation`: the platform tearing the account's graph down, not a
 * decision by either side). Runs in the caller's transaction; the caller owns
 * the `user_follows` projection and cache invalidation.
 */
export async function removeAccountRelationships(db: DatabaseOrTransaction, userId: string): Promise<void> {
  const at = new Date();
  const rows = await db
    .select({
      id: followRelationships.id,
      followerUserId: followRelationships.followerUserId,
      canonicalUri: followTargets.canonicalUri,
      kind: followTargets.kind,
    })
    .from(followRelationships)
    .innerJoin(followTargets, eq(followTargets.id, followRelationships.followTargetId))
    .where(or(eq(followRelationships.followerUserId, userId), eq(followTargets.localUserId, userId)));
  if (rows.length === 0) return;
  for (const row of rows) {
    await emit(db as Tx, {
      type: 'follow.removed',
      cause: 'reconciliation',
      capability: { userId: row.followerUserId, applicationId: null, grantId: null },
      relationshipId: row.id,
      targetUri: row.canonicalUri,
      targetKind: row.kind,
      at,
    });
  }
  await db.delete(followRelationships).where(inArray(followRelationships.id, rows.map((row) => row.id)));
}
