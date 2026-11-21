/**
 * Follows (`@oxy.so/bloom-data`), held in the store of the account that reads
 * them, so an account switch never shows one account another's follows.
 *
 * Following a person lands on the person: whether the viewer follows them is
 * `relationship.isFollowing` and their counts are `_count` on `User`
 * (`data/user.ts`), the record every profile, post and list row reads. A
 * `relationship.isFollowing` that is not a boolean means UNKNOWN (never asked),
 * which is not "not following": a button waits for the answer rather than
 * offer a follow the person did not intend.
 *
 * What a follow write is doing for one person (in flight, why it last failed)
 * is `FollowActivity`, memory only. A follow of anything else (a topic, a
 * store, a channel, `/v2/follows`) is `FollowTarget`, keyed by target id,
 * memory only like the store it replaces.
 */
import { action, currentStore, entity, type Store, source, withStore } from '@oxy.so/bloom-data';
import type { FollowApplicationMode, FollowRecord, FollowStatus } from '@oxy.so/contracts';
import type {
  BulkFollowEntry,
  BulkFollowResult,
  BulkUnfollowEntry,
  BulkUnfollowResult,
  OxyServices,
} from '@oxy.so/core';
import {
  type FollowActionErrorCode,
  type FollowErrorCode,
  toFollowErrorCode,
} from '../utils/followErrors';
import { createSessionChangedError } from '../utils/sessionChangedError';
import { sdkRead } from './readOptions';
import { User } from './user';
import { type CachedUser, toCachedUser } from './userRecord';

// ── People ────────────────────────────────────────────────────────────────

/** A follow write's state for one person: whether one is in flight, and why the last failed. */
export interface FollowActivityRecord {
  id: string;
  pending: boolean;
  error: FollowErrorCode | null;
}

export const FollowActivity = entity<FollowActivityRecord>('followActivity', {
  id: (activity) => activity.id,
});

/** Whether the viewer follows `user`: `undefined` while unknown. */
export function isFollowingOf(user: CachedUser | undefined): boolean | undefined {
  const value = user?.relationship?.isFollowing;
  return typeof value === 'boolean' ? value : undefined;
}

/** A person's follower count, or `null` while their counts are unknown. */
export function followerCountOf(user: CachedUser | undefined): number | null {
  return user?._count?.followers ?? null;
}

/** How many people a person follows, or `null` while their counts are unknown. */
export function followingCountOf(user: CachedUser | undefined): number | null {
  return user?._count?.following ?? null;
}

export function followPendingOf(activity: FollowActivityRecord | undefined): boolean {
  return activity?.pending ?? false;
}

export function followErrorOf(activity: FollowActivityRecord | undefined): FollowErrorCode | null {
  return activity?.error ?? null;
}

/** Holds a record for a person known only by id, so a follow can be written on it. */
function holdUser(userId: string): void {
  if (!User.has(userId)) User.put({ id: userId });
}

/**
 * Writes whether the viewer follows `userId`. Inside an action's `optimistic`
 * it is that action's layer; a person not held yet is held with nothing else
 * known, so dropping the layer leaves them UNKNOWN again.
 */
function writeFollowing(userId: string, isFollowing: boolean): void {
  holdUser(userId);
  User.merge(userId, { relationship: { isFollowing } });
}

/** Forgets whether the viewer follows `userId` (back to UNKNOWN). */
function forgetFollowing(userId: string): void {
  User.update(userId, (user) => {
    if (!user.relationship || !('isFollowing' in user.relationship)) return undefined;
    const { isFollowing: _forgotten, ...relationship } = user.relationship;
    return { ...user, relationship };
  });
}

function writeCounts(userId: string, counts: { followers?: number; following?: number }): void {
  holdUser(userId);
  User.merge(userId, { _count: counts });
}

function writeActivity(userId: string, change: Partial<Omit<FollowActivityRecord, 'id'>>): void {
  if (!FollowActivity.update(userId, (held) => ({ ...held, ...change }))) {
    FollowActivity.put({ id: userId, pending: false, error: null, ...change });
  }
}

/** What the store in scope knows about whether the viewer follows `userId`. */
function knownFollowing(userId: string): boolean | undefined {
  return isFollowingOf(User.get(userId));
}

/** Sets a definite follow status and clears the person's error. */
export function setFollowStatus(userId: string, isFollowing: boolean): void {
  writeFollowing(userId, isFollowing);
  writeActivity(userId, { error: null });
}

/**
 * Seeds follow statuses only where they are UNKNOWN: a definite value already
 * held (one written by a follow in flight, say) is never replaced. Safe to call
 * on every viewer-graph refresh.
 */
export function seedFollowStatuses(statuses: Readonly<Record<string, boolean>>): void {
  for (const [userId, isFollowing] of Object.entries(statuses)) {
    if (knownFollowing(userId) === undefined) writeFollowing(userId, isFollowing);
  }
}

export function clearFollowError(userId: string): void {
  FollowActivity.merge(userId, { error: null });
}

export function setFollowCounts(
  userId: string,
  counts: { followers?: number; following?: number },
): void {
  writeCounts(userId, counts);
}

/**
 * Writes the counts a follow write answered with: the target's followers, and
 * (when known) the viewer's following.
 */
export function applyFollowCounts(
  targetUserId: string,
  counts: { followers: number; following: number },
  viewerId: string | null | undefined,
): void {
  writeCounts(targetUserId, { followers: counts.followers });
  if (viewerId) writeCounts(viewerId, { following: counts.following });
}

// ── Status reads, micro-batched ───────────────────────────────────────────

/**
 * Per store: the UNKNOWN ids asked for in this tick, the client to ask with,
 * and the ids whose answer is on its way.
 */
interface StatusBatch {
  readonly queued: Set<string>;
  readonly inFlight: Set<string>;
  oxy: OxyServices | null;
  scheduled: boolean;
}

const batches = new WeakMap<Store, StatusBatch>();

function batchOf(store: Store): StatusBatch {
  let batch = batches.get(store);
  if (!batch) {
    batch = { queued: new Set(), inFlight: new Set(), oxy: null, scheduled: false };
    batches.set(store, batch);
  }
  return batch;
}

async function readQueuedStatuses(store: Store, batch: StatusBatch): Promise<void> {
  batch.scheduled = false;
  const ids = [...batch.queued];
  batch.queued.clear();
  const oxy = batch.oxy;
  batch.oxy = null;
  if (ids.length === 0 || !oxy) return;
  for (const id of ids) batch.inFlight.add(id);
  try {
    const statuses = await oxy.follows.statuses(ids);
    withStore(store, () =>
      store.batch(() => {
        // A follow that raced ahead of this read wrote a definite value: keep it.
        for (const id of ids) {
          if (knownFollowing(id) === undefined) writeFollowing(id, statuses[id] ?? false);
        }
      }),
    );
  } catch (error) {
    const code = toFollowErrorCode(error, 'read_failed');
    withStore(store, () =>
      store.batch(() => {
        for (const id of ids) writeActivity(id, { error: code });
      }),
    );
  } finally {
    for (const id of ids) batch.inFlight.delete(id);
  }
}

/**
 * Reads the follow status of every UNKNOWN id asked for in this tick in ONE
 * `follows.statuses` call (a page of buttons mounting in one commit). Ids
 * already known, queued or in flight are skipped. The answer goes to the store
 * that asked, so an answer for an account since left is dropped.
 */
export function resolveFollowStatuses(oxy: OxyServices, userIds: readonly string[]): void {
  const store = currentStore();
  const batch = batchOf(store);
  let queuedAny = false;
  for (const rawId of userIds) {
    if (typeof rawId !== 'string') continue;
    const id = rawId.trim();
    if (!id) continue;
    if (knownFollowing(id) !== undefined || batch.inFlight.has(id) || batch.queued.has(id)) {
      continue;
    }
    batch.queued.add(id);
    queuedAny = true;
  }
  if (!queuedAny) return;
  // The latest client wins the read: it is the same client per app.
  batch.oxy = oxy;
  if (batch.scheduled) return;
  batch.scheduled = true;
  queueMicrotask(() => {
    void readQueuedStatuses(store, batch);
  });
}

// ── Follow writes ─────────────────────────────────────────────────────────

/** Follows or unfollows one person: the button flips at once, and flips back if refused. */
const toggleFollowAction = action({
  optimistic: (_oxy: OxyServices, userId: string, isCurrentlyFollowing: boolean) =>
    writeFollowing(userId, !isCurrentlyFollowing),
  run: (oxy: OxyServices, userId: string, isCurrentlyFollowing: boolean) =>
    isCurrentlyFollowing ? oxy.follows.unfollow(userId) : oxy.follows.follow(userId),
  settle: (response, oxy, userId) => {
    if (response.counts) applyFollowCounts(userId, response.counts, oxy.session.userId);
  },
});

/**
 * Follows `userId` (or unfollows, when `isCurrentlyFollowing`). Resolves to
 * whether the server accepted it; a refusal is rolled back and its code kept
 * in `FollowActivity`, never thrown. A write whose account was left meanwhile
 * resolves to `false` and changes nothing.
 */
export async function toggleFollow(
  oxy: OxyServices,
  userId: string,
  isCurrentlyFollowing: boolean,
): Promise<boolean> {
  const store = currentStore();
  writeActivity(userId, { pending: true, error: null });
  try {
    await toggleFollowAction(oxy, userId, isCurrentlyFollowing);
    return !store.closed;
  } catch (error) {
    if (store.closed) return false;
    withStore(store, () =>
      writeActivity(userId, { error: toFollowErrorCode(error, 'update_failed') }),
    );
    return false;
  } finally {
    withStore(store, () => writeActivity(userId, { pending: false }));
  }
}

/** Each person's follow status before a bulk write: `undefined` was UNKNOWN. */
type PriorFollowing = Readonly<Record<string, boolean | undefined>>;

function restoreFollowing(prior: PriorFollowing, userId: string): void {
  const previous = prior[userId];
  if (previous === undefined) forgetFollowing(userId);
  else writeFollowing(userId, previous);
}

const followManyAction = action({
  optimistic: (_oxy: OxyServices, userIds: readonly string[], _prior: PriorFollowing) => {
    for (const userId of userIds) writeFollowing(userId, true);
  },
  run: (oxy: OxyServices, userIds: readonly string[], _prior: PriorFollowing) =>
    oxy.follows.followMany([...userIds]),
  // A target the server refused goes back to what it was.
  settle: (result, _oxy, _userIds, prior) => {
    for (const entry of result.results) {
      if (!followAccepted(entry)) restoreFollowing(prior, entry.userId);
    }
  },
});

const unfollowManyAction = action({
  optimistic: (_oxy: OxyServices, userIds: readonly string[], _prior: PriorFollowing) => {
    for (const userId of userIds) writeFollowing(userId, false);
  },
  run: (oxy: OxyServices, userIds: readonly string[], _prior: PriorFollowing) =>
    oxy.follows.unfollowMany([...userIds]),
  settle: (result, _oxy, _userIds, prior) => {
    for (const entry of result.results) {
      if (!entry.success) restoreFollowing(prior, entry.userId);
    }
  },
});

function followAccepted(entry: BulkFollowEntry): boolean {
  return entry.success || Boolean(entry.alreadyFollowing);
}

/**
 * Runs a bulk write: every target pending, then each target's outcome (a
 * refused one gets `update_failed`); a whole-batch failure rolls every target
 * back and rethrows. A write whose account was left meanwhile rejects with
 * the session-changed error and changes nothing.
 */
async function bulkFollow<R extends { results: Array<BulkFollowEntry | BulkUnfollowEntry> }>(
  userIds: readonly string[],
  write: (prior: PriorFollowing) => Promise<R | undefined>,
  accepted: (entry: R['results'][number]) => boolean,
): Promise<R> {
  const store = currentStore();
  const prior: Record<string, boolean | undefined> = {};
  for (const userId of userIds) prior[userId] = knownFollowing(userId);
  store.batch(() => {
    for (const userId of userIds) writeActivity(userId, { pending: true, error: null });
  });
  try {
    const result = await write(prior);
    if (!result || store.closed) throw createSessionChangedError();
    withStore(store, () =>
      store.batch(() => {
        for (const entry of result.results) {
          writeActivity(entry.userId, { error: accepted(entry) ? null : 'update_failed' });
        }
      }),
    );
    return result;
  } catch (error) {
    if (store.closed) throw createSessionChangedError();
    const code = toFollowErrorCode(error, 'update_failed');
    withStore(store, () =>
      store.batch(() => {
        for (const userId of userIds) writeActivity(userId, { error: code });
      }),
    );
    throw error;
  } finally {
    withStore(store, () =>
      store.batch(() => {
        for (const userId of userIds) writeActivity(userId, { pending: false });
      }),
    );
  }
}

/** Follows every one of `userIds` in one call; never unfollows. */
export function followMany(
  oxy: OxyServices,
  userIds: readonly string[],
): Promise<BulkFollowResult> {
  return bulkFollow(
    userIds,
    (prior) => followManyAction(oxy, userIds, prior),
    (entry) => followAccepted(entry as BulkFollowEntry),
  );
}

/** Unfollows every one of `userIds` in one call; idempotent, never follows. */
export function unfollowMany(
  oxy: OxyServices,
  userIds: readonly string[],
): Promise<BulkUnfollowResult> {
  return bulkFollow(
    userIds,
    (prior) => unfollowManyAction(oxy, userIds, prior),
    (entry) => entry.success,
  );
}

// ── Counts ────────────────────────────────────────────────────────────────

/**
 * A person read for their counts (`users.get`). Every field it answers joins
 * `User` by the user merge rules. Read only while the counts are unknown.
 */
export const followCounts = source(User, {
  key: (_oxy: OxyServices, userId: string) => userId,
  load: async (_request, oxy, userId) => toCachedUser(await oxy.users.get(userId), userId),
  stale: 5 * 60_000,
  gcTime: 30 * 60_000,
  ...sdkRead,
});

// ── Targets (`/v2/follows`) ───────────────────────────────────────────────

/** One followable target: its status (`undefined` until read), and its write state. */
export interface FollowTargetRecord {
  id: string;
  status?: FollowStatus;
  pending: boolean;
  error?: FollowErrorCode;
}

export const FollowTarget = entity<FollowTargetRecord>('followTarget', {
  id: (target) => target.id,
});

/**
 * The state one target is in before the server has been asked. Distinct from
 * "not following": a button that renders a follow action while the answer is
 * unknown invites a follow the user did not intend, so callers check
 * `isUnknown` rather than reading this as an answer.
 */
export const UNKNOWN_FOLLOW_STATUS: FollowStatus = {
  globalState: 'none',
  applicationMode: 'inherit',
  effectiveState: 'not_following',
};

/** Replaces fields of a target's record (outside an action's layer). */
function writeTarget(targetId: string, change: Partial<Omit<FollowTargetRecord, 'id'>>): void {
  if (!FollowTarget.update(targetId, (held) => ({ ...held, ...change }))) {
    FollowTarget.put({ id: targetId, pending: false, ...change });
  }
}

/** A target's status as an action's optimistic layer. */
function layerTargetStatus(targetId: string, status: FollowStatus): void {
  if (!FollowTarget.has(targetId)) FollowTarget.put({ id: targetId, pending: false });
  FollowTarget.merge(targetId, { status });
}

/** The status of `targetId` in the store in scope. */
export function followTargetStatusOf(targetId: string): FollowStatus | undefined {
  return FollowTarget.get(targetId)?.status;
}

/**
 * Seeds statuses already known (a follow list, a feed payload), replacing what
 * is held: one request saved per rendered row.
 */
export function seedFollowTargets(entries: Readonly<Record<string, FollowStatus>>): void {
  for (const [targetId, status] of Object.entries(entries)) writeTarget(targetId, { status });
}

/**
 * Reads a target's status. A failed read keeps the button interactive (a
 * failed read is not "never asked"), with its error code kept.
 */
export async function readFollowTarget(oxy: OxyServices, targetId: string): Promise<void> {
  const store = currentStore();
  try {
    const status = await oxy.follows.targetStatus(targetId);
    withStore(store, () => writeTarget(targetId, { status, error: undefined }));
  } catch (error) {
    withStore(store, () =>
      writeTarget(targetId, {
        status: followTargetStatusOf(targetId) ?? UNKNOWN_FOLLOW_STATUS,
        error: toFollowErrorCode(error, 'read_failed'),
      }),
    );
  }
}

/** The status a follow shows before the server answers. */
function followedStatus(current: FollowStatus, expiresIn: number | undefined): FollowStatus {
  return {
    ...withApplicationMode({ ...current, globalState: 'active' }, current.applicationMode),
    ...(expiresIn ? { expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() } : {}),
  };
}

export const followTargetAction = action({
  optimistic: (
    _oxy: OxyServices,
    targetId: string,
    current: FollowStatus,
    options?: { expiresIn?: number },
  ) => layerTargetStatus(targetId, followedStatus(current, options?.expiresIn)),
  run: async (
    oxy: OxyServices,
    targetId: string,
    _current: FollowStatus,
    options?: { expiresIn?: number },
  ) => (await oxy.follows.followTarget(targetId, options)).status,
  // The server answers with the whole resulting status: `effectiveState`'s
  // derivation lives there, not in a second copy here.
  settle: (status, _oxy, targetId) => writeTarget(targetId, { status }),
});

export const unfollowTargetAction = action({
  optimistic: (_oxy: OxyServices, targetId: string, _relationshipId: string) =>
    layerTargetStatus(targetId, UNKNOWN_FOLLOW_STATUS),
  run: (oxy: OxyServices, _targetId: string, relationshipId: string) =>
    oxy.follows.unfollowTarget(relationshipId),
  settle: (_result, _oxy, targetId) => writeTarget(targetId, { status: UNKNOWN_FOLLOW_STATUS }),
});

/** Switches a follow off in this application (`disabled`) or back on (`inherit`). */
export const setFollowTargetModeAction = action({
  optimistic: (
    _oxy: OxyServices,
    targetId: string,
    _relationshipId: string,
    current: FollowStatus,
    mode: 'disabled' | 'inherit',
  ) => layerTargetStatus(targetId, withApplicationMode(current, mode)),
  run: (
    oxy: OxyServices,
    _targetId: string,
    relationshipId: string,
    _current: FollowStatus,
    mode: 'disabled' | 'inherit',
  ): Promise<unknown> =>
    mode === 'disabled'
      ? oxy.follows.setApplicationMode(relationshipId, 'disabled')
      : oxy.follows.restoreInheritance(relationshipId),
  settle: (_result, _oxy, targetId, _relationshipId, current, mode) =>
    writeTarget(targetId, { status: withApplicationMode(current, mode) }),
});

/**
 * Runs one target write: pending while it runs, its error code kept when it
 * is refused (rolled back to what was true; to the unknown status when
 * nothing was). Resolves to whether the server accepted it; never rejects. A
 * write whose account was left meanwhile resolves to `false`.
 */
export async function writeFollowTarget(
  targetId: string,
  write: () => Promise<unknown>,
  failure: FollowActionErrorCode,
): Promise<boolean> {
  const store = currentStore();
  writeTarget(targetId, { pending: true, error: undefined });
  try {
    await write();
    return !store.closed;
  } catch (error) {
    if (store.closed) return false;
    withStore(store, () =>
      writeTarget(targetId, {
        status: followTargetStatusOf(targetId) ?? UNKNOWN_FOLLOW_STATUS,
        error: toFollowErrorCode(error, failure),
      }),
    );
    return false;
  } finally {
    withStore(store, () => writeTarget(targetId, { pending: false }));
  }
}

/**
 * Whether the user follows this at all, anywhere.
 *
 * Deliberately NOT `effectiveState !== 'not_following'`: a follow switched off
 * in this application reports `not_following` — correctly, since the question
 * that field answers is "does this act here" — and a button that read it as
 * "not followed" would offer to follow something already followed.
 */
export function isFollowedGlobally(status: FollowStatus): boolean {
  return status.globalState === 'active' || status.globalState === 'requested';
}

/**
 * Whether a held status is safe to act on without a round trip.
 *
 * List payloads often carry `globalState` without `relationshipId`. Treating
 * that as authoritative would leave disable/unfollow as no-ops forever.
 */
export function isCompleteFollowStatus(status: FollowStatus): boolean {
  if (isFollowedGlobally(status)) return Boolean(status.relationshipId);
  return true;
}

/** Convert one list row into a target's status. */
export function followRecordToStatus(record: FollowRecord): FollowStatus {
  return {
    relationshipId: record.relationshipId,
    globalState: record.globalState,
    applicationMode: record.applicationMode,
    effectiveState: record.effectiveState,
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
  };
}

/**
 * Bulk-convert a follow list page into a status map keyed by target id — the
 * input of `useSeedFollowTargets()`.
 */
export function followRecordsToStatusMap(records: FollowRecord[]): Record<string, FollowStatus> {
  const entries: Record<string, FollowStatus> = {};
  for (const record of records) {
    entries[record.target.id] = followRecordToStatus(record);
  }
  return entries;
}

/**
 * Apply a mode change to a status without a round trip.
 *
 * Exported because the optimistic path and the settled path must agree on what
 * `effectiveState` becomes; deriving it in two places is how they drift. Mirrors
 * the server's own derivation, which is the authority.
 */
export function withApplicationMode(
  status: FollowStatus,
  mode: FollowApplicationMode,
): FollowStatus {
  return {
    ...status,
    applicationMode: mode,
    effectiveState:
      mode === 'disabled'
        ? 'not_following'
        : status.globalState === 'active'
          ? 'following'
          : status.globalState === 'requested'
            ? 'requested'
            : 'not_following',
  };
}
