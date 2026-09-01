import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFollowStore } from '../stores/followStore';
import { useOxy } from '../context/OxyContext';
import type { OxyServices, BulkFollowResult, BulkUnfollowResult } from '@oxyhq/core';
import { useShallow } from 'zustand/react/shallow';
import { queryKeys } from './queries/queryKeys';
import { patchCachedUserRelationship } from './queries/userCacheRelationship';

/**
 * useFollow — Hook for follow state management.
 *
 * Performance fixes:
 * 1. Uses granular Zustand selectors instead of subscribing to the entire store.
 *    The old `useFollowStore()` caused every component using this hook to re-render
 *    on ANY store change (any user's follow status, loading state, error, or count).
 * 2. Callbacks depend on primitive values (userId, isFollowing) not object references,
 *    so they remain stable across renders.
 * 3. Store action methods are accessed via getState() in callbacks to avoid
 *    subscribing to the action functions themselves (they never change but including
 *    them in selectors would cause unnecessary selector recalculations).
 */
export const useFollow = (userId?: string | string[]) => {
  const queryClient = useQueryClient();
  const { oxyServices, canUsePrivateApi } = useOxy();
  const userIds = useMemo(() => (Array.isArray(userId) ? userId : userId ? [userId] : []), [userId]);
  const isSingleUser = typeof userId === 'string';
  // Narrowed single-user id for use in closures (callbacks/queryFn) where TS
  // can't carry the `isSingleUser` boolean back to a `string` narrowing.
  const singleUserId: string | undefined = typeof userId === 'string' ? userId : undefined;

  // Granular Zustand selectors — only re-render when THIS user's data changes
  const isFollowing = useFollowStore(
    useCallback((s) => (isSingleUser && userId ? s.followingUsers[userId] ?? false : false), [isSingleUser, userId])
  );
  const isLoading = useFollowStore(
    useCallback((s) => (isSingleUser && userId ? s.loadingUsers[userId] ?? false : false), [isSingleUser, userId])
  );
  const error = useFollowStore(
    useCallback((s) => (isSingleUser && userId ? s.errors[userId] ?? null : null), [isSingleUser, userId])
  );
  const followerCount = useFollowStore(
    useCallback((s) => (isSingleUser && userId ? s.followerCounts[userId] ?? null : null), [isSingleUser, userId])
  );
  const followingCount = useFollowStore(
    useCallback((s) => (isSingleUser && userId ? s.followingCounts[userId] ?? null : null), [isSingleUser, userId])
  );
  const isLoadingCounts = useFollowStore(
    useCallback((s) => (isSingleUser && userId ? s.loadingCounts[userId] ?? false : false), [isSingleUser, userId])
  );

  // For multi-user mode, subscribe to a FLAT snapshot of the per-user fields.
  // `useShallow` only compares one level deep, so the selector must NOT return a
  // nested object — a freshly allocated `{ isFollowing, isLoading, error }` per
  // user would never shallow-compare equal, making `useSyncExternalStore`
  // resubscribe every render and loop until React throws "Maximum update depth
  // exceeded". Keeping the snapshot flat lets the shallow compare cache it; the
  // nested `followData` shape is then assembled in a `useMemo` below.
  const followFlat = useFollowStore(
    useShallow((s) => {
      if (isSingleUser) return {} as Record<string, boolean | string | null>;
      const flat: Record<string, boolean | string | null> = {};
      for (const uid of userIds) {
        flat[`${uid}:isFollowing`] = s.followingUsers[uid] ?? false;
        flat[`${uid}:isLoading`] = s.loadingUsers[uid] ?? false;
        flat[`${uid}:error`] = s.errors[uid] ?? null;
      }
      return flat;
    })
  );

  const followData = useMemo(() => {
    const data: Record<string, { isFollowing: boolean; isLoading: boolean; error: string | null }> = {};
    if (isSingleUser) return data;
    for (const uid of userIds) {
      data[uid] = {
        isFollowing: Boolean(followFlat[`${uid}:isFollowing`]),
        isLoading: Boolean(followFlat[`${uid}:isLoading`]),
        error: (followFlat[`${uid}:error`] as string | null) ?? null,
      };
    }
    return data;
  }, [isSingleUser, userIds, followFlat]);

  // Multi-user aggregate selectors
  const multiUserLoadingState = useFollowStore(
    useShallow((s) => {
      if (isSingleUser) return { isAnyLoading: false, hasAnyError: false, allFollowing: true, allNotFollowing: true };
      return {
        isAnyLoading: userIds.some(uid => s.loadingUsers[uid]),
        hasAnyError: userIds.some(uid => !!s.errors[uid]),
        allFollowing: userIds.every(uid => s.followingUsers[uid]),
        allNotFollowing: userIds.every(uid => !s.followingUsers[uid]),
      };
    })
  );

  // Stable callbacks that depend on primitives, not object references.
  // Store actions are accessed via getState() to avoid subscribing to them.
  const toggleFollow = useCallback(async () => {
    if (!isSingleUser || !userId) throw new Error('toggleFollow is only available for single user mode');
    if (!canUsePrivateApi) throw new Error('Authentication is required to follow users');
    const currentlyFollowing = useFollowStore.getState().followingUsers[userId] ?? false;
    const accepted = await useFollowStore.getState().toggleFollowUser(userId, oxyServices, currentlyFollowing);
    if (accepted) patchCachedUserRelationship(queryClient, userId, !currentlyFollowing);
  }, [isSingleUser, userId, canUsePrivateApi, oxyServices, queryClient]);

  const setFollowStatus = useCallback((following: boolean) => {
    if (!isSingleUser || !userId) throw new Error('setFollowStatus is only available for single user mode');
    useFollowStore.getState().setFollowingStatus(userId, following);
  }, [isSingleUser, userId]);

  const fetchStatus = useCallback(async () => {
    if (!isSingleUser || !userId) throw new Error('fetchStatus is only available for single user mode');
    if (!canUsePrivateApi) return;
    useFollowStore.getState().resolveFollowStatuses([userId], oxyServices);
  }, [isSingleUser, userId, canUsePrivateApi, oxyServices]);

  const clearError = useCallback(() => {
    if (!isSingleUser || !userId) throw new Error('clearError is only available for single user mode');
    useFollowStore.getState().clearFollowError(userId);
  }, [isSingleUser, userId]);

  const fetchUserCounts = useCallback(async () => {
    if (!isSingleUser || !userId) throw new Error('fetchUserCounts is only available for single user mode');
    await useFollowStore.getState().fetchUserCounts(userId, oxyServices);
  }, [isSingleUser, userId, oxyServices]);

  const setFollowerCount = useCallback((count: number) => {
    if (!isSingleUser || !userId) throw new Error('setFollowerCount is only available for single user mode');
    useFollowStore.getState().setFollowerCount(userId, count);
  }, [isSingleUser, userId]);

  const setFollowingCount = useCallback((count: number) => {
    if (!isSingleUser || !userId) throw new Error('setFollowingCount is only available for single user mode');
    useFollowStore.getState().setFollowingCount(userId, count);
  }, [isSingleUser, userId]);

  // Auto-fetch counts for single-user mode via React Query instead of a manual
  // useEffect. The Zustand store remains the canonical home for count values
  // (it is also written by toggleFollowUser / updateCountsFromFollowAction), so
  // components keep reading `followerCount` / `followingCount` through the
  // granular selectors above — this query only owns the FETCH lifecycle
  // (dedup, caching, retry/backoff). It stays disabled until the counts are
  // actually missing, reproducing the old effect's `(followerCount === null ||
  // followingCount === null)` gate without a render-phase side effect. The
  // store action does the network call and writes the counts; the query simply
  // surfaces the resolved pair as its cached data.
  useQuery({
    queryKey: singleUserId ? queryKeys.follow.counts(singleUserId) : queryKeys.follow.all,
    queryFn: async () => {
      if (!singleUserId) return null;
      await useFollowStore.getState().fetchUserCounts(singleUserId, oxyServices);
      const state = useFollowStore.getState();
      return {
        followers: state.followerCounts[singleUserId] ?? null,
        following: state.followingCounts[singleUserId] ?? null,
      };
    },
    enabled: !!singleUserId && (followerCount === null || followingCount === null),
  });

  // Multi-user callbacks
  const toggleFollowForUser = useCallback(async (targetUserId: string) => {
    if (!canUsePrivateApi) throw new Error('Authentication is required to follow users');
    const currentState = useFollowStore.getState().followingUsers[targetUserId] ?? false;
    const accepted = await useFollowStore.getState().toggleFollowUser(targetUserId, oxyServices, currentState);
    if (accepted) patchCachedUserRelationship(queryClient, targetUserId, !currentState);
  }, [canUsePrivateApi, oxyServices, queryClient]);

  const setFollowStatusForUser = useCallback((targetUserId: string, following: boolean) => {
    useFollowStore.getState().setFollowingStatus(targetUserId, following);
  }, []);

  const fetchStatusForUser = useCallback(async (targetUserId: string) => {
    if (!canUsePrivateApi) return;
    useFollowStore.getState().resolveFollowStatuses([targetUserId], oxyServices);
  }, [canUsePrivateApi, oxyServices]);

  // Resolve EVERY member's status in ONE micro-batched bulk call (never N
  // single requests). Ids already known/seeded are skipped by the resolver.
  const fetchAllStatuses = useCallback(async () => {
    if (!canUsePrivateApi) return;
    useFollowStore.getState().resolveFollowStatuses(userIds, oxyServices);
  }, [canUsePrivateApi, userIds, oxyServices]);

  // Bulk follow — follows ALL users in ONE network call (never unfollows).
  const followAllUsers = useCallback(async (): Promise<BulkFollowResult> => {
    if (!canUsePrivateApi) throw new Error('Authentication is required to follow users');
    return useFollowStore.getState().followManyUsers(userIds, oxyServices);
  }, [canUsePrivateApi, userIds, oxyServices]);

  // Bulk unfollow — unfollows ALL users in ONE network call (idempotent; never follows).
  const unfollowAllUsers = useCallback(async (): Promise<BulkUnfollowResult> => {
    if (!canUsePrivateApi) throw new Error('Authentication is required to unfollow users');
    return useFollowStore.getState().unfollowManyUsers(userIds, oxyServices);
  }, [canUsePrivateApi, userIds, oxyServices]);

  const clearErrorForUser = useCallback((targetUserId: string) => {
    useFollowStore.getState().clearFollowError(targetUserId);
  }, []);

  const updateCountsFromFollowAction = useCallback((targetUserId: string, action: 'follow' | 'unfollow', counts: { followers: number; following: number }) => {
    const currentUserId = oxyServices.getCurrentUserId() || undefined;
    useFollowStore.getState().updateCountsFromFollowAction(targetUserId, action, counts, currentUserId);
  }, [oxyServices]);

  if (isSingleUser && userId) {
    return {
      isFollowing,
      isLoading,
      error,
      toggleFollow,
      setFollowStatus,
      fetchStatus,
      clearError,
      followerCount,
      followingCount,
      isLoadingCounts,
      fetchUserCounts,
      setFollowerCount,
      setFollowingCount,
    };
  }

  return {
    followData,
    toggleFollowForUser,
    setFollowStatusForUser,
    fetchStatusForUser,
    fetchAllStatuses,
    followAllUsers,
    unfollowAllUsers,
    clearErrorForUser,
    isAnyLoading: multiUserLoadingState.isAnyLoading,
    hasAnyError: multiUserLoadingState.hasAnyError,
    allFollowing: multiUserLoadingState.allFollowing,
    allNotFollowing: multiUserLoadingState.allNotFollowing,
  };
};

/**
 * useFollowForButton — Lightweight follow hook for FollowButton in list contexts.
 *
 * Unlike useFollow, this hook:
 * - Accepts oxyServices directly (no useOxy() context subscription)
 * - Only subscribes to the specific user's follow and loading state
 * - Returns only what FollowButton needs (no counts, no multi-user)
 */
export const useFollowForButton = (userId: string, oxyServices: OxyServices, initiallyFollowing?: boolean) => {
  // Seed the store synchronously on the FIRST render (before paint) when the
  // caller provided a definite `initiallyFollowing` and the store has no entry
  // yet. This makes the first paint show the correct label (no post-mount
  // "Follow → Following" correction) and marks the id KNOWN so the batched
  // resolver skips it. An OMITTED `initiallyFollowing` leaves the id UNKNOWN,
  // so the batched resolver fetches its real status. The useState lazy
  // initializer runs exactly once per mount; `setFollowStatuses` is
  // seed-only-if-absent, so it never clobbers a live value.
  useState(() => {
    if (initiallyFollowing === undefined) return null;
    const store = useFollowStore.getState();
    if (!Object.prototype.hasOwnProperty.call(store.followingUsers, userId)) {
      store.setFollowStatuses({ [userId]: initiallyFollowing });
    }
    return null;
  });

  const isFollowing = useFollowStore(
    useCallback((s) => s.followingUsers[userId] ?? false, [userId])
  );
  // Tri-state: a present key (seeded or fetched) is a DEFINITE status; a missing
  // key is UNKNOWN. The button renders a neutral/disabled state while unknown.
  const isKnown = useFollowStore(
    useCallback((s) => Object.prototype.hasOwnProperty.call(s.followingUsers, userId), [userId])
  );
  const isLoading = useFollowStore(
    useCallback((s) => s.loadingUsers[userId] ?? false, [userId])
  );
  const error = useFollowStore(
    useCallback((s) => s.errors[userId] ?? null, [userId])
  );

  const toggleFollow = useCallback(async (): Promise<boolean> => {
    const currentlyFollowing = useFollowStore.getState().followingUsers[userId] ?? false;
    return useFollowStore.getState().toggleFollowUser(userId, oxyServices, currentlyFollowing);
  }, [userId, oxyServices]);

  // Enqueue this id into the micro-batched resolver — every button that enqueues
  // in the same tick coalesces into ONE bulk `getFollowStatuses` call. Known /
  // seeded / in-flight ids are skipped by the resolver, so this is a no-op for
  // them.
  const resolveStatus = useCallback(() => {
    useFollowStore.getState().resolveFollowStatuses([userId], oxyServices);
  }, [userId, oxyServices]);

  const setFollowStatus = useCallback((following: boolean) => {
    useFollowStore.getState().setFollowingStatus(userId, following);
  }, [userId]);

  const clearError = useCallback(() => {
    useFollowStore.getState().clearFollowError(userId);
  }, [userId]);

  return {
    isFollowing,
    isKnown,
    isLoading,
    error,
    toggleFollow,
    resolveStatus,
    setFollowStatus,
    clearError,
  };
};

/**
 * useSeedFollowStatuses — returns a stable callback that bulk-seeds follow
 * statuses into the store (seed-only-if-absent; never clobbers a live value).
 *
 * Wire this at the app root to seed from `oxyServices.getViewerGraph()
 * .followingIds` (map each followed id → `true`) so a page of `FollowButton`s
 * paints the correct label on first render with ZERO follow-status network
 * calls — the batched resolver then skips every seeded id.
 */
export const useSeedFollowStatuses = () =>
  useCallback((statuses: Record<string, boolean>) => {
    useFollowStore.getState().setFollowStatuses(statuses);
  }, []);

// Convenience hook for just follower counts
export const useFollowerCounts = (userId: string) => {
  const { oxyServices } = useOxy();

  const followerCount = useFollowStore(
    useCallback((s) => s.followerCounts[userId] ?? null, [userId])
  );
  const followingCount = useFollowStore(
    useCallback((s) => s.followingCounts[userId] ?? null, [userId])
  );
  const isLoadingCounts = useFollowStore(
    useCallback((s) => s.loadingCounts[userId] ?? false, [userId])
  );

  const fetchUserCounts = useCallback(async () => {
    await useFollowStore.getState().fetchUserCounts(userId, oxyServices);
  }, [userId, oxyServices]);

  const setFollowerCount = useCallback((count: number) => {
    useFollowStore.getState().setFollowerCount(userId, count);
  }, [userId]);

  const setFollowingCount = useCallback((count: number) => {
    useFollowStore.getState().setFollowingCount(userId, count);
  }, [userId]);

  return {
    followerCount,
    followingCount,
    isLoadingCounts,
    fetchUserCounts,
    setFollowerCount,
    setFollowingCount,
  };
};
