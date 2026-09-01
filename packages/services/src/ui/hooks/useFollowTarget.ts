/**
 * `useFollowTarget` — the one hook every application uses to follow anything.
 *
 * Wraps the `/v2/follows` SDK methods with the store above, an optimistic
 * update, and a rollback. Nothing in here knows what kind of thing it is
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
import type { FollowStatus } from '@oxyhq/contracts';
import { useOxy } from '../context/OxyContext';
import {
  isCompleteFollowStatus,
  isFollowedGlobally,
  UNKNOWN_FOLLOW_STATUS,
  useFollowTargetStore,
  withApplicationMode,
} from '../stores/followTargetStore';

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
  error: string | undefined;
  /**
   * Every mutation resolves to whether the server ACCEPTED it.
   *
   * They never reject — a refusal becomes `error` in the store, so the button
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
}

export function useFollowTarget(
  targetId: string | undefined,
  options?: { initialStatus?: FollowStatus }
): UseFollowTargetResult {
  const { oxyServices, canUsePrivateApi } = useOxy();

  const status = useFollowTargetStore(
    useCallback((s) => (targetId ? s.statuses[targetId] : undefined), [targetId])
  );
  const isPending = useFollowTargetStore(
    useCallback((s) => (targetId ? (s.pending[targetId] ?? false) : false), [targetId])
  );
  const error = useFollowTargetStore(
    useCallback((s) => (targetId ? s.errors[targetId] : undefined), [targetId])
  );

  const initialStatus = options?.initialStatus;

  // A caller that already knows the status — a follow list, a feed payload —
  // seeds it rather than making this hook re-ask once per rendered row.
  useEffect(() => {
    if (!targetId || !initialStatus) return;
    const store = useFollowTargetStore.getState();
    if (!store.statuses[targetId]) store.setStatus(targetId, initialStatus);
  }, [targetId, initialStatus]);

  const refresh = useCallback(async () => {
    // Gated on `canUsePrivateApi`, not on `isAuthenticated`: during the session
    // cold boot the second is true well before the first, and a read sent in
    // that window 401s and would leave the button stuck reporting an error the
    // user cannot act on.
    if (!targetId || !canUsePrivateApi) return;
    try {
      const next = await oxyServices.getFollowTargetStatus(targetId);
      useFollowTargetStore.getState().setStatus(targetId, next);
      useFollowTargetStore.getState().setError(targetId, undefined);
    } catch (e) {
      const store = useFollowTargetStore.getState();
      const message = e instanceof Error ? e.message : 'Could not read follow status';
      // Leave `isUnknown` false so the button stays interactive and can retry.
      // A failed read is not the same as "never asked" — disabling forever would
      // strand the user with no affordance when the network blips.
      if (!store.statuses[targetId]) {
        store.setStatus(targetId, UNKNOWN_FOLLOW_STATUS);
      }
      store.setError(targetId, message);
    }
  }, [targetId, canUsePrivateApi, oxyServices]);

  useEffect(() => {
    if (!targetId || !canUsePrivateApi) return;
    const existing = useFollowTargetStore.getState().statuses[targetId];
    if (existing && isCompleteFollowStatus(existing)) return;
    void refresh();
  }, [targetId, canUsePrivateApi, refresh]);

  /**
   * Run a mutation optimistically: show `optimistic` at once, keep the previous
   * value, and put it back if the server refuses. Every mutation below goes
   * through this so the rollback cannot be forgotten in one of them.
   */
  const mutate = useCallback(
    async (
      optimistic: FollowStatus,
      run: () => Promise<FollowStatus | undefined>,
      failureMessage: string
    ): Promise<boolean> => {
      if (!targetId) return false;
      const store = useFollowTargetStore.getState();
      const previous = store.statuses[targetId];
      store.setStatus(targetId, optimistic);
      store.setPending(targetId, true);
      store.setError(targetId, undefined);
      try {
        const settled = await run();
        if (settled) useFollowTargetStore.getState().setStatus(targetId, settled);
        return true;
      } catch (e) {
        const s = useFollowTargetStore.getState();
        // Back to what was true, not to a guess. Clearing the entry instead
        // would make the next render ask again and flash the wrong state.
        if (previous) s.setStatus(targetId, previous);
        s.setError(targetId, e instanceof Error ? e.message : failureMessage);
        return false;
      } finally {
        useFollowTargetStore.getState().setPending(targetId, false);
      }
    },
    [targetId]
  );

  const current = status ?? UNKNOWN_FOLLOW_STATUS;

  const follow = useCallback(
    async (opts?: { expiresIn?: number }) => {
      if (!targetId) return false;
      return mutate(
        {
          ...withApplicationMode({ ...current, globalState: 'active' }, current.applicationMode),
          ...(opts?.expiresIn
            ? { expiresAt: new Date(Date.now() + opts.expiresIn * 1000).toISOString() }
            : {}),
        },
        // The server returns the whole resulting status, so store it rather
        // than reconstructing one: `effectiveState`'s derivation lives there,
        // and a client recomputing it is a second implementation of one rule.
        async () => (await oxyServices.followTarget(targetId, opts)).status,
        'Could not follow'
      );
    },
    [targetId, current, mutate, oxyServices]
  );

  const unfollow = useCallback(async () => {
    const relationshipId = current.relationshipId;
    if (!targetId || !relationshipId) return false;
    return mutate(
      { ...UNKNOWN_FOLLOW_STATUS },
      async () => {
        await oxyServices.unfollowTarget(relationshipId);
        return { ...UNKNOWN_FOLLOW_STATUS };
      },
      'Could not unfollow'
    );
  }, [targetId, current.relationshipId, mutate, oxyServices]);

  const disableHere = useCallback(async () => {
    const relationshipId = current.relationshipId;
    if (!targetId || !relationshipId) return false;
    const optimistic = withApplicationMode(current, 'disabled');
    return mutate(
      optimistic,
      async () => {
        await oxyServices.setFollowApplicationMode(relationshipId, 'disabled');
        return optimistic;
      },
      'Could not change this app’s setting for this follow'
    );
  }, [targetId, current, mutate, oxyServices]);

  const enableHere = useCallback(async () => {
    const relationshipId = current.relationshipId;
    if (!targetId || !relationshipId) return false;
    const optimistic = withApplicationMode(current, 'inherit');
    return mutate(
      optimistic,
      async () => {
        await oxyServices.restoreFollowInheritance(relationshipId);
        return optimistic;
      },
      'Could not change this app’s setting for this follow'
    );
  }, [targetId, current, mutate, oxyServices]);

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
  };
}
