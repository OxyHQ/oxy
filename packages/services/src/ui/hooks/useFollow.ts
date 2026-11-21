import { useCallback, useMemo, useState } from 'react';
import { skip, useEntity, useRecord, useStore, withStore } from '@oxy.so/bloom-data';
import {
  OxyAuthenticationError,
  type OxyServices,
  type BulkFollowResult,
  type BulkUnfollowResult,
} from '@oxy.so/core';
import { useOxy } from '../context/oxyRuntimeContext';
import {
  FollowActivity,
  clearFollowError,
  followCounts,
  followErrorOf,
  followerCountOf,
  followingCountOf,
  followMany,
  followPendingOf,
  isFollowingOf,
  resolveFollowStatuses,
  seedFollowStatuses,
  setFollowCounts,
  setFollowStatus,
  toggleFollow as toggleFollowWrite,
  unfollowMany,
} from '../data/follow';
import { User } from '../data/user';
import { useEntities } from '../data/useEntities';
import type { FollowErrorCode } from '../utils/followErrors';
import type { MultiFollowResult, SingleFollowResult } from './useFollow.types';

const NO_IDS: readonly string[] = [];

/**
 * A person's follower and following counts, read (`users.get`) only while
 * they are unknown. `fetchUserCounts` reads them again on demand.
 */
function useUserCounts(userId: string | undefined, oxyServices: OxyServices) {
  const store = useStore();
  const followerCount = useEntity(User, userId, followerCountOf);
  const followingCount = useEntity(User, userId, followingCountOf);
  const countsMissing = followerCount === null || followingCount === null;
  const view = useRecord(
    followCounts,
    ...(userId && countsMissing ? ([oxyServices, userId] as const) : ([skip] as const)),
  );
  const fetchUserCounts = useCallback(async () => {
    if (!userId) return;
    await withStore(store, () => followCounts.refresh(oxyServices, userId));
  }, [store, oxyServices, userId]);
  const setFollowerCount = useCallback(
    (count: number) => {
      if (userId) withStore(store, () => setFollowCounts(userId, { followers: count }));
    },
    [store, userId],
  );
  const setFollowingCount = useCallback(
    (count: number) => {
      if (userId) withStore(store, () => setFollowCounts(userId, { following: count }));
    },
    [store, userId],
  );
  return {
    followerCount,
    followingCount,
    isLoadingCounts: view.isFetching,
    fetchUserCounts,
    setFollowerCount,
    setFollowingCount,
  };
}

/**
 * useFollow — follow state for one person (`userId`) or for a set of people
 * (`userId` as an array).
 *
 * Whether the viewer follows a person and that person's counts are read from
 * `User`, so a profile read, a feed author and a follow all show the same
 * answer. Each read subscribes to the fields it uses, so a change to another
 * person (or another field) does not re-render.
 */
export function useFollow(userId: string): SingleFollowResult;
export function useFollow(userId?: string[]): MultiFollowResult;
export function useFollow(userId?: string | string[]): SingleFollowResult | MultiFollowResult;
export function useFollow(userId?: string | string[]): SingleFollowResult | MultiFollowResult {
  const store = useStore();
  const { oxyServices, canUsePrivateApi } = useOxy();
  const singleUserId = typeof userId === 'string' ? userId : undefined;
  const userIds = useMemo(
    () => (Array.isArray(userId) ? userId : NO_IDS),
    [userId],
  ) as readonly string[];

  const isFollowing = useEntity(User, singleUserId, isFollowingOf) ?? false;
  const isLoading = useEntity(FollowActivity, singleUserId, followPendingOf);
  const error = useEntity(FollowActivity, singleUserId, followErrorOf);
  const counts = useUserCounts(singleUserId, oxyServices);

  const users = useEntities(User, userIds);
  const activities = useEntities(FollowActivity, userIds);
  const followData = useMemo(() => {
    const data: Record<
      string,
      { isFollowing: boolean; isLoading: boolean; error: FollowErrorCode | null }
    > = {};
    userIds.forEach((uid, index) => {
      data[uid] = {
        isFollowing: isFollowingOf(users[index]) ?? false,
        isLoading: followPendingOf(activities[index]),
        error: followErrorOf(activities[index]),
      };
    });
    return data;
  }, [userIds, users, activities]);

  const toggleFollowFor = useCallback(
    async (targetUserId: string) => {
      if (!canUsePrivateApi)
        throw new OxyAuthenticationError('Authentication is required to follow users');
      await withStore(store, () =>
        toggleFollowWrite(
          oxyServices,
          targetUserId,
          isFollowingOf(User.get(targetUserId)) ?? false,
        ),
      );
    },
    [store, canUsePrivateApi, oxyServices],
  );

  const toggleFollow = useCallback(async () => {
    if (!singleUserId) throw new Error('toggleFollow is only available for single user mode');
    await toggleFollowFor(singleUserId);
  }, [singleUserId, toggleFollowFor]);

  const setFollowStatusForUser = useCallback(
    (targetUserId: string, following: boolean) => {
      withStore(store, () => setFollowStatus(targetUserId, following));
    },
    [store],
  );

  const setSingleFollowStatus = useCallback(
    (following: boolean) => {
      if (!singleUserId) throw new Error('setFollowStatus is only available for single user mode');
      setFollowStatusForUser(singleUserId, following);
    },
    [singleUserId, setFollowStatusForUser],
  );

  const fetchStatusForUser = useCallback(
    async (targetUserId: string) => {
      if (!canUsePrivateApi) return;
      withStore(store, () => resolveFollowStatuses(oxyServices, [targetUserId]));
    },
    [store, canUsePrivateApi, oxyServices],
  );

  const fetchStatus = useCallback(async () => {
    if (!singleUserId) throw new Error('fetchStatus is only available for single user mode');
    await fetchStatusForUser(singleUserId);
  }, [singleUserId, fetchStatusForUser]);

  const clearErrorForUser = useCallback(
    (targetUserId: string) => {
      withStore(store, () => clearFollowError(targetUserId));
    },
    [store],
  );

  const clearError = useCallback(() => {
    if (!singleUserId) throw new Error('clearError is only available for single user mode');
    clearErrorForUser(singleUserId);
  }, [singleUserId, clearErrorForUser]);

  // Resolve EVERY member's status in ONE micro-batched bulk call (never N
  // single requests). Ids already known are skipped by the resolver.
  const fetchAllStatuses = useCallback(async () => {
    if (!canUsePrivateApi) return;
    withStore(store, () => resolveFollowStatuses(oxyServices, userIds));
  }, [store, canUsePrivateApi, userIds, oxyServices]);

  // Bulk follow — follows ALL users in ONE network call (never unfollows).
  const followAllUsers = useCallback(async (): Promise<BulkFollowResult> => {
    if (!canUsePrivateApi)
      throw new OxyAuthenticationError('Authentication is required to follow users');
    return withStore(store, () => followMany(oxyServices, userIds));
  }, [store, canUsePrivateApi, userIds, oxyServices]);

  // Bulk unfollow — unfollows ALL users in ONE network call (idempotent; never follows).
  const unfollowAllUsers = useCallback(async (): Promise<BulkUnfollowResult> => {
    if (!canUsePrivateApi)
      throw new OxyAuthenticationError('Authentication is required to unfollow users');
    return withStore(store, () => unfollowMany(oxyServices, userIds));
  }, [store, canUsePrivateApi, userIds, oxyServices]);

  const aggregate = useMemo(
    () => ({
      isAnyLoading: activities.some((activity) => followPendingOf(activity)),
      hasAnyError: activities.some((activity) => followErrorOf(activity) !== null),
      allFollowing: users.every((user) => isFollowingOf(user) === true),
      allNotFollowing: users.every((user) => !isFollowingOf(user)),
    }),
    [users, activities],
  );

  if (singleUserId) {
    return {
      isFollowing,
      isLoading,
      error,
      toggleFollow,
      setFollowStatus: setSingleFollowStatus,
      fetchStatus,
      clearError,
      ...counts,
    };
  }

  return {
    followData,
    toggleFollowForUser: toggleFollowFor,
    setFollowStatusForUser,
    fetchStatusForUser,
    fetchAllStatuses,
    followAllUsers,
    unfollowAllUsers,
    clearErrorForUser,
    ...aggregate,
  };
}

/**
 * useFollowForButton — the follow state one FollowButton needs, and nothing
 * else (no counts, no multi-user).
 */
export const useFollowForButton = (
  userId: string,
  oxyServices: OxyServices,
  initiallyFollowing?: boolean,
) => {
  const store = useStore();
  // Seed on the FIRST render (before paint) when the caller knows the status
  // and the store does not: the first paint shows the right label, and the id
  // is KNOWN so the batched resolver skips it. An omitted `initiallyFollowing`
  // leaves the id UNKNOWN, so the resolver reads it. Seeding never replaces a
  // definite value.
  useState(() => {
    if (initiallyFollowing !== undefined) {
      withStore(store, () => seedFollowStatuses({ [userId]: initiallyFollowing }));
    }
    return null;
  });

  const following = useEntity(User, userId, isFollowingOf);
  const isLoading = useEntity(FollowActivity, userId, followPendingOf);
  const error = useEntity(FollowActivity, userId, followErrorOf);

  const toggleFollow = useCallback(
    (): Promise<boolean> =>
      withStore(store, () =>
        toggleFollowWrite(oxyServices, userId, isFollowingOf(User.get(userId)) ?? false),
      ),
    [store, userId, oxyServices],
  );

  // Every button that asks in the same tick shares ONE bulk status read;
  // known, queued and in-flight ids are skipped.
  const resolveStatus = useCallback(() => {
    withStore(store, () => resolveFollowStatuses(oxyServices, [userId]));
  }, [store, userId, oxyServices]);

  const setStatus = useCallback(
    (isFollowing: boolean) => {
      withStore(store, () => setFollowStatus(userId, isFollowing));
    },
    [store, userId],
  );

  const clearError = useCallback(() => {
    withStore(store, () => clearFollowError(userId));
  }, [store, userId]);

  /** Why the last follow of this person failed, read now (after `toggleFollow` resolves `false`). */
  const lastError = useCallback(
    (): FollowErrorCode | null => withStore(store, () => followErrorOf(FollowActivity.get(userId))),
    [store, userId],
  );

  return {
    isFollowing: following ?? false,
    // Tri-state: a definite status (seeded or read) is KNOWN; none is UNKNOWN,
    // and the button shows a neutral state until it is read.
    isKnown: following !== undefined,
    isLoading,
    error,
    toggleFollow,
    resolveStatus,
    setFollowStatus: setStatus,
    clearError,
    lastError,
  };
};

/**
 * useSeedFollowStatuses — a stable callback that seeds follow statuses into
 * the signed-in account's store, only where they are unknown.
 *
 * Wire it at the app root to seed from `oxyServices.follows.viewerGraph()
 * .followingIds` (each followed id → `true`), so a page of `FollowButton`s
 * paints the right label on first render with no status reads.
 */
export const useSeedFollowStatuses = () => {
  const store = useStore();
  return useCallback(
    (statuses: Record<string, boolean>) => {
      withStore(store, () => seedFollowStatuses(statuses));
    },
    [store],
  );
};

/** A person's follower and following counts, read while unknown. */
export const useFollowerCounts = (userId: string) => {
  const { oxyServices } = useOxy();
  return useUserCounts(userId, oxyServices);
};
