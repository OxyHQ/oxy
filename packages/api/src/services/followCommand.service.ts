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

import { and, eq, isNotNull, lte } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { followApplicationOverrides } from '../db/schema/followApplicationOverrides';
import { followEvents, type FollowEventCause, type FollowEventType } from '../db/schema/followEvents';
import { followRelationships } from '../db/schema/followRelationships';
import { followTargets } from '../db/schema/followTargets';
import { userFollows } from '../db/schema/userFollows';
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

async function readStatus(
  tx: Tx | Db,
  userId: string,
  applicationId: string,
  targetId: string
): Promise<FollowStatus> {
  const [relationship] = await tx
    .select({
      id: followRelationships.id,
      state: followRelationships.state,
      expiresAt: followRelationships.expiresAt,
    })
    .from(followRelationships)
    .where(
      and(
        eq(followRelationships.followerUserId, userId),
        eq(followRelationships.followTargetId, targetId)
      )
    )
    .limit(1);

  if (!relationship) {
    return { globalState: 'none', applicationMode: 'inherit', effectiveState: 'not_following' };
  }

  const [override] = await tx
    .select({ mode: followApplicationOverrides.mode })
    .from(followApplicationOverrides)
    .where(
      and(
        eq(followApplicationOverrides.relationshipId, relationship.id),
        eq(followApplicationOverrides.applicationId, applicationId)
      )
    )
    .limit(1);

  const mode = override?.mode ?? 'inherit';
  return {
    relationshipId: relationship.id,
    globalState: relationship.state,
    applicationMode: mode,
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

    // The event is written BEFORE the delete, in the same transaction, because
    // it reads the row it is about. `follow_events.relationship_id` carries no
    // foreign key precisely so the event outlives this delete.
    await emit(tx, {
      type: 'follow.removed',
      cause: input.cause ?? 'user_action',
      capability,
      relationshipId,
      targetUri: target?.canonicalUri ?? '',
      targetKind: target?.kind ?? '',
      at,
    });

    await tx.delete(followRelationships).where(eq(followRelationships.id, relationshipId));

    if (target?.localUserId) {
      await tx
        .delete(userFollows)
        .where(
          and(
            eq(userFollows.followerId, capability.userId),
            eq(userFollows.followedId, target.localUserId)
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
