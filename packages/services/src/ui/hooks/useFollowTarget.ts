/**
 * `useFollowTarget` — the one hook every application uses to follow anything.
 *
 * Wraps the `/v2/follows` SDK methods with `FollowTarget` (`data/follow.ts`),
 * an optimistic layer, and its rollback. Nothing in here knows what kind of thing it is
 * following, which is the property that lets an application the SDK has never
 * heard of use it without a release of this package.
 *
 * ## Optimism, and its one limit
 *
 * A follow flips the button immediately and rolls back if the server refuses,
 * because the round trip is long enough to feel like a bug otherwise. But an
 * optimistic follow has no relationship id until the server answers, and every
 * other operation addresses the relationship — so those stay disabled for the
 * width of one request rather than being sent with a guessed id.
 */

import { useCallback, useEffect } from 'react';
import { useEntity, useStore, withStore } from '@oxy.so/bloom-data';
import type { FollowStatus } from '@oxy.so/contracts';
import { useOxy } from '../context/oxyRuntimeContext';
import {
  FollowTarget,
  type FollowTargetRecord,
  followTargetAction,
  followTargetStatusOf,
  isCompleteFollowStatus,
  isFollowedGlobally,
  readFollowTarget,
  seedFollowTargets,
  setFollowTargetModeAction,
  UNKNOWN_FOLLOW_STATUS,
  unfollowTargetAction,
  writeFollowTarget,
} from '../data/follow';
import type { FollowErrorCode } from '../utils/followErrors';

const statusOf = (target: FollowTargetRecord | undefined) => target?.status;
const pendingOf = (target: FollowTargetRecord | undefined) => target?.pending ?? false;
const errorOf = (target: FollowTargetRecord | undefined) => target?.error;

export interface UseFollowTargetResult {
  status: FollowStatus;
  /**
   * Whether the user follows this at all — NOT `effectiveState`, which reports
   * `not_following` for a follow merely switched off in this application.
   */
  isFollowing: boolean;
  /** True until the first read settles. Distinct from "not following". */
  isUnknown: boolean;
  isPending: boolean;
  /** Why the last read or write failed — a code; `useFollowErrorMessage()` words it. */
  error: FollowErrorCode | undefined;
  /**
   * Every mutation resolves to whether the server ACCEPTED it.
   *
   * They never reject — a refusal becomes an `error` code in the store, so the button
   * can render it — which means a caller that only awaits them cannot tell a
   * write that happened from one that did not. Returning the outcome is what
   * lets a caller mirror the change somewhere else without mirroring failures
   * too.
   */
  follow: (options?: { expiresIn?: number }) => Promise<boolean>;
  unfollow: () => Promise<boolean>;
  /** Stop acting on this follow HERE, without giving it up everywhere. */
  disableHere: () => Promise<boolean>;
  enableHere: () => Promise<boolean>;
  refresh: () => Promise<void>;
  /** Why the last read or write failed, read now: for a toast after a write resolves `false`. */
  lastError: () => FollowErrorCode | undefined;
}

export function useFollowTarget(
  targetId: string | undefined,
  options?: { initialStatus?: FollowStatus },
): UseFollowTargetResult {
  const store = useStore();
  const { oxyServices, canUsePrivateApi } = useOxy();

  const status = useEntity(FollowTarget, targetId, statusOf);
  const isPending = useEntity(FollowTarget, targetId, pendingOf);
  const error = useEntity(FollowTarget, targetId, errorOf);

  const initialStatus = options?.initialStatus;

  // A caller that already knows the status — a follow list, a feed payload —
  // seeds it rather than making this hook re-ask once per rendered row.
  useEffect(() => {
    if (!targetId || !initialStatus) return;
    withStore(store, () => {
      if (!followTargetStatusOf(targetId)) seedFollowTargets({ [targetId]: initialStatus });
    });
  }, [store, targetId, initialStatus]);

  const refresh = useCallback(async () => {
    // Gated on `canUsePrivateApi`, not on `isAuthenticated`: during the session
    // cold boot the second is true well before the first, and a read sent in
    // that window 401s and would leave the button stuck reporting an error the
    // user cannot act on.
    if (!targetId || !canUsePrivateApi) return;
    await withStore(store, () => readFollowTarget(oxyServices, targetId));
  }, [store, targetId, canUsePrivateApi, oxyServices]);

  useEffect(() => {
    if (!targetId || !canUsePrivateApi) return;
    const existing = withStore(store, () => followTargetStatusOf(targetId));
    if (existing && isCompleteFollowStatus(existing)) return;
    void refresh();
  }, [store, targetId, canUsePrivateApi, refresh]);

  const current = status ?? UNKNOWN_FOLLOW_STATUS;

  // Every write shows its result at once and is rolled back if the server
  // refuses (an action's optimistic layer), so no write can forget the rollback.
  const follow = useCallback(
    async (opts?: { expiresIn?: number }) => {
      if (!targetId) return false;
      return withStore(store, () =>
        writeFollowTarget(
          targetId,
          () => followTargetAction(oxyServices, targetId, current, opts),
          'update_failed',
        ),
      );
    },
    [store, targetId, current, oxyServices],
  );

  const unfollow = useCallback(async () => {
    const relationshipId = current.relationshipId;
    if (!targetId || !relationshipId) return false;
    return withStore(store, () =>
      writeFollowTarget(
        targetId,
        () => unfollowTargetAction(oxyServices, targetId, relationshipId),
        'update_failed',
      ),
    );
  }, [store, targetId, current.relationshipId, oxyServices]);

  const setMode = useCallback(
    async (mode: 'disabled' | 'inherit') => {
      const relationshipId = current.relationshipId;
      if (!targetId || !relationshipId) return false;
      return withStore(store, () =>
        writeFollowTarget(
          targetId,
          () => setFollowTargetModeAction(oxyServices, targetId, relationshipId, current, mode),
          'mode_failed',
        ),
      );
    },
    [store, targetId, current, oxyServices],
  );

  const disableHere = useCallback(() => setMode('disabled'), [setMode]);
  const enableHere = useCallback(() => setMode('inherit'), [setMode]);

  /** Why the last read or write failed, read now (after a write resolves `false`). */
  const lastError = useCallback(
    (): FollowErrorCode | undefined =>
      targetId ? withStore(store, () => FollowTarget.get(targetId)?.error) : undefined,
    [store, targetId],
  );

  return {
    status: current,
    isFollowing: isFollowedGlobally(current),
    isUnknown: status === undefined,
    isPending,
    error,
    follow,
    unfollow,
    disableHere,
    enableHere,
    refresh,
    lastError,
  };
}

/**
 * useSeedFollowTargets — a stable callback that seeds target statuses already
 * known (a follow list page through `followRecordsToStatusMap`) into the
 * signed-in account's store, replacing what is held.
 */
export function useSeedFollowTargets(): (entries: Record<string, FollowStatus>) => void {
  const store = useStore();
  return useCallback(
    (entries: Record<string, FollowStatus>) => {
      withStore(store, () => seedFollowTargets(entries));
    },
    [store],
  );
}
