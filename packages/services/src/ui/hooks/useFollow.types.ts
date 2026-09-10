// Type-only definition for the useFollow hook to allow context exposure without runtime import cycles.
// Expand this as needed to better reflect the real return type.

import type { BulkFollowResult } from '@oxy.so/core';

export type SingleFollowResult = {
  isFollowing: boolean;
  isLoading: boolean;
  error: string | null;
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
  followData: Record<string, { isFollowing: boolean; isLoading: boolean; error: string | null }>;
  toggleFollowForUser: (userId: string) => Promise<void>;
  setFollowStatusForUser: (userId: string, following: boolean) => void;
  fetchStatusForUser: (userId: string) => Promise<void>;
  fetchAllStatuses: () => Promise<void>;
  followAllUsers: () => Promise<BulkFollowResult>;
  clearErrorForUser: (userId: string) => void;
  isAnyLoading: boolean;
  hasAnyError: boolean;
  allFollowing: boolean;
  allNotFollowing: boolean;
};

export type UseFollowHook = (userId?: string | string[]) => SingleFollowResult | MultiFollowResult;
