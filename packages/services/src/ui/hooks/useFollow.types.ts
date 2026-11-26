// The shapes `useFollow` returns, apart from the hook so the context type can
// name them without importing it (no runtime import cycle).

import type { BulkFollowResult, BulkUnfollowResult } from '@oxy.so/core';
import type { FollowErrorCode } from '../utils/followErrors';

export type SingleFollowResult = {
  isFollowing: boolean;
  isLoading: boolean;
  error: FollowErrorCode | null;
  toggleFollow: () => Promise<void>;
  setFollowStatus: (following: boolean) => void;
  fetchStatus: () => Promise<void>;
  clearError: () => void;
  followerCount: number | null;
  followingCount: number | null;
  isLoadingCounts: boolean;
  fetchUserCounts: () => Promise<void>;
  setFollowerCount: (count: number) => void;
  setFollowingCount: (count: number) => void;
};

export type MultiFollowResult = {
  followData: Record<
    string,
    { isFollowing: boolean; isLoading: boolean; error: FollowErrorCode | null }
  >;
  toggleFollowForUser: (userId: string) => Promise<void>;
  setFollowStatusForUser: (userId: string, following: boolean) => void;
  fetchStatusForUser: (userId: string) => Promise<void>;
  fetchAllStatuses: () => Promise<void>;
  followAllUsers: () => Promise<BulkFollowResult>;
  unfollowAllUsers: () => Promise<BulkUnfollowResult>;
  clearErrorForUser: (userId: string) => void;
  isAnyLoading: boolean;
  hasAnyError: boolean;
  allFollowing: boolean;
  allNotFollowing: boolean;
};

export type UseFollowHook = (userId?: string | string[]) => SingleFollowResult | MultiFollowResult;
