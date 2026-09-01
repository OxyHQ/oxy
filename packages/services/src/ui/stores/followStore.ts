import { create } from 'zustand';
import type { OxyServices, BulkFollowResult, BulkUnfollowResult, FollowMutationResult } from '@oxyhq/core';

interface FollowState {
  // Tri-state follow map: a MISSING key means UNKNOWN (status not yet resolved),
  // a present `true`/`false` is a DEFINITE value. Read sites must NOT collapse a
  // missing key to `false` when they need to distinguish "unknown" from "not
  // following" (see `useFollowForButton`'s `isKnown`).
  followingUsers: Record<string, boolean>;
  loadingUsers: Record<string, boolean>;
  fetchingUsers: Record<string, boolean>;
  errors: Record<string, string | null>;
  // Follower counts for each user
  followerCounts: Record<string, number>;
  followingCounts: Record<string, number>;
  // Loading states for counts
  loadingCounts: Record<string, boolean>;
  setFollowingStatus: (userId: string, isFollowing: boolean) => void;
  // Bulk-seed follow statuses (seed-only-if-absent — never clobbers a definite
  // value the store already holds). Consumers call this to seed from
  // `getViewerGraph().followingIds` so a page of FollowButtons paints correctly
  // with ZERO network calls.
  setFollowStatuses: (map: Record<string, boolean>) => void;
  clearFollowError: (userId: string) => void;
  resetFollowState: () => void;
  // Micro-batched status resolver: enqueue UNKNOWN ids, coalesce every id
  // requested within the same tick into ONE `getFollowStatuses` call. Ids that
  // are already known/seeded or already in flight are skipped.
  resolveFollowStatuses: (userIds: string[], oxyServices: OxyServices) => void;
  toggleFollowUser: (userId: string, oxyServices: OxyServices, isCurrentlyFollowing: boolean) => Promise<boolean>;
  // Bulk follow — follows MANY users in one network call; never unfollows.
  followManyUsers: (userIds: string[], oxyServices: OxyServices) => Promise<BulkFollowResult>;
  // Bulk unfollow — unfollows MANY users in one network call; idempotent, never follows.
  unfollowManyUsers: (userIds: string[], oxyServices: OxyServices) => Promise<BulkUnfollowResult>;
  // New methods for follower counts
  setFollowerCount: (userId: string, count: number) => void;
  setFollowingCount: (userId: string, count: number) => void;
  updateCountsFromFollowAction: (targetUserId: string, action: 'follow' | 'unfollow', counts: { followers: number; following: number }, currentUserId?: string) => void;
  fetchUserCounts: (userId: string, oxyServices: OxyServices) => Promise<void>;
}

const hasKey = (map: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(map, key);

const scheduleMicrotask = (cb: () => void): void => {
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(cb);
  } else {
    setTimeout(cb, 0);
  }
};

// ---------------------------------------------------------------------------
// Module-level micro-batch coordination for `resolveFollowStatuses`.
//
// Every UNKNOWN id requested within a single synchronous tick (e.g. a whole
// page of FollowButtons mounting in one commit) is collected in `pendingIds`
// and flushed by a SINGLE coalesced `getFollowStatuses` call on the next
// microtask. `inFlightIds` prevents an id already being fetched from being
// re-enqueued before its result lands. These are imperative coordination
// primitives read/written ONLY inside store actions — never in a render/memo
// position — so they are safe under the React Compiler.
// ---------------------------------------------------------------------------
let pendingIds = new Set<string>();
let pendingServices: OxyServices | null = null;
let flushScheduled = false;
const inFlightIds = new Set<string>();
let batchGeneration = 0;

/** Clears module-level micro-batch coordination state (test + sign-out hooks). */
export const resetFollowBatchState = (): void => {
  pendingIds = new Set<string>();
  pendingServices = null;
  flushScheduled = false;
  inFlightIds.clear();
  batchGeneration += 1;
};

export const useFollowStore = create<FollowState>((set, get) => ({
  followingUsers: {},
  loadingUsers: {},
  fetchingUsers: {},
  errors: {},
  followerCounts: {},
  followingCounts: {},
  loadingCounts: {},
  setFollowingStatus: (userId: string, isFollowing: boolean) => set((state) => ({
    followingUsers: { ...state.followingUsers, [userId]: isFollowing },
    errors: { ...state.errors, [userId]: null },
  })),
  setFollowStatuses: (map: Record<string, boolean>) => set((state) => {
    const followingUsers = { ...state.followingUsers };
    let changed = false;
    for (const [userId, isFollowing] of Object.entries(map)) {
      // Seed only if absent — never overwrite a definite value the store already
      // holds (e.g. one written optimistically). Idempotent and safe to call on
      // every graph refresh.
      if (!hasKey(followingUsers, userId)) {
        followingUsers[userId] = isFollowing;
        changed = true;
      }
    }
    return changed ? { followingUsers } : {};
  }),
  clearFollowError: (userId: string) => set((state) => ({
    errors: { ...state.errors, [userId]: null },
  })),
  resetFollowState: () => {
    resetFollowBatchState();
    set({
      followingUsers: {},
      loadingUsers: {},
      fetchingUsers: {},
      errors: {},
      followerCounts: {},
      followingCounts: {},
      loadingCounts: {},
    });
  },
  resolveFollowStatuses: (userIds: string[], oxyServices: OxyServices) => {
    const { followingUsers } = get();
    let enqueuedAny = false;
    for (const rawId of userIds) {
      if (typeof rawId !== 'string') continue;
      const id = rawId.trim();
      if (!id) continue;
      // Skip ids with a known (seeded or fetched) status, already-in-flight ids,
      // and ids already queued for this flush.
      if (hasKey(followingUsers, id) || inFlightIds.has(id) || pendingIds.has(id)) continue;
      pendingIds.add(id);
      enqueuedAny = true;
    }

    if (!enqueuedAny) return;

    // The most recent instance wins the flush — they are the same client per app.
    pendingServices = oxyServices;

    if (flushScheduled) return;
    flushScheduled = true;

    scheduleMicrotask(() => {
      flushScheduled = false;
      const ids = Array.from(pendingIds);
      pendingIds = new Set<string>();
      const services = pendingServices;
      pendingServices = null;
      if (ids.length === 0 || !services) return;

      const generation = batchGeneration;
      for (const id of ids) inFlightIds.add(id);
      set((state) => {
        const fetchingUsers = { ...state.fetchingUsers };
        for (const id of ids) fetchingUsers[id] = true;
        return { fetchingUsers };
      });

      void services
        .getFollowStatuses(ids)
        .then((statuses) => {
          if (generation !== batchGeneration) return;
          set((state) => {
            const followingUsersNext = { ...state.followingUsers };
            const fetchingUsers = { ...state.fetchingUsers };
            for (const id of ids) {
              // Do not clobber a definite value written by a mutation that raced
              // ahead of this batch — seed only if still unknown.
              if (!hasKey(followingUsersNext, id)) {
                followingUsersNext[id] = statuses[id] ?? false;
              }
              fetchingUsers[id] = false;
            }
            return { followingUsers: followingUsersNext, fetchingUsers };
          });
        })
        .catch((error: unknown) => {
          if (generation !== batchGeneration) return;
          const message = (error instanceof Error ? error.message : null) || 'Failed to fetch follow status';
          set((state) => {
            const fetchingUsers = { ...state.fetchingUsers };
            const errors = { ...state.errors };
            for (const id of ids) {
              fetchingUsers[id] = false;
              errors[id] = message;
            }
            return { fetchingUsers, errors };
          });
        })
        .finally(() => {
          for (const id of ids) inFlightIds.delete(id);
        });
    });
  },
  toggleFollowUser: async (userId: string, oxyServices: OxyServices, isCurrentlyFollowing: boolean) => {
    // Snapshot the prior value for rollback. `undefined` = was UNKNOWN.
    const priorState = get().followingUsers;
    const hadPrevious = hasKey(priorState, userId);
    const previousValue = priorState[userId];
    const optimisticValue = !isCurrentlyFollowing;

    // Write the new value IMMEDIATELY (before the await) so the button flips
    // instantly; mark loading; clear any prior error.
    set((state) => ({
      followingUsers: { ...state.followingUsers, [userId]: optimisticValue },
      loadingUsers: { ...state.loadingUsers, [userId]: true },
      errors: { ...state.errors, [userId]: null },
    }));

    try {
      const response: FollowMutationResult = isCurrentlyFollowing
        ? await oxyServices.unfollowUser(userId)
        : await oxyServices.followUser(userId);

      // Reconcile: confirm the optimistic value is authoritative, clear loading.
      set((state) => ({
        followingUsers: { ...state.followingUsers, [userId]: optimisticValue },
        loadingUsers: { ...state.loadingUsers, [userId]: false },
        errors: { ...state.errors, [userId]: null },
      }));

      // Update counts if the response includes them.
      // The API returns counts for both users:
      // - followers: target user's follower count (the user being followed)
      // - following: current user's following count (the user doing the following)
      if (response.counts) {
        const { counts } = response;
        const currentUserId = oxyServices.getCurrentUserId();

        set((state) => {
          const followerCounts = { ...state.followerCounts, [userId]: counts.followers };
          if (currentUserId) {
            return {
              followerCounts,
              followingCounts: { ...state.followingCounts, [currentUserId]: counts.following },
            };
          }
          return { followerCounts };
        });
      }
      return true;
    } catch (error: unknown) {
      // Roll back to the prior value (or back to UNKNOWN if there was none).
      set((state) => {
        const followingUsers = { ...state.followingUsers };
        if (hadPrevious) {
          followingUsers[userId] = previousValue;
        } else {
          delete followingUsers[userId];
        }
        return {
          followingUsers,
          loadingUsers: { ...state.loadingUsers, [userId]: false },
          errors: { ...state.errors, [userId]: (error instanceof Error ? error.message : null) || 'Failed to update follow status' },
        };
      });
      return false;
    }
  },
  followManyUsers: async (userIds: string[], oxyServices: OxyServices): Promise<BulkFollowResult> => {
    // Snapshot prior values for rollback (tri-state: undefined = unknown).
    const prior = get().followingUsers;
    const previous = new Map<string, boolean | undefined>();
    for (const uid of userIds) {
      previous.set(uid, hasKey(prior, uid) ? prior[uid] : undefined);
    }

    // Optimistically mark every target followed BEFORE the await.
    set((state) => {
      const followingUsers = { ...state.followingUsers };
      const loadingUsers = { ...state.loadingUsers };
      const errors = { ...state.errors };
      for (const uid of userIds) {
        followingUsers[uid] = true;
        loadingUsers[uid] = true;
        errors[uid] = null;
      }
      return { followingUsers, loadingUsers, errors };
    });

    try {
      const result = await oxyServices.followUsers(userIds);
      set((state) => {
        const followingUsers = { ...state.followingUsers };
        const loadingUsers = { ...state.loadingUsers };
        const errors = { ...state.errors };
        for (const uid of userIds) {
          loadingUsers[uid] = false;
        }
        for (const entry of result.results) {
          if (entry.success || entry.alreadyFollowing) {
            followingUsers[entry.userId] = true;
            errors[entry.userId] = null;
          } else {
            // This target failed — roll IT back to its prior value.
            const prev = previous.get(entry.userId);
            if (prev === undefined) {
              delete followingUsers[entry.userId];
            } else {
              followingUsers[entry.userId] = prev;
            }
            errors[entry.userId] = 'Failed to update follow status';
          }
        }
        return { followingUsers, loadingUsers, errors };
      });
      return result;
    } catch (error: unknown) {
      const message = (error instanceof Error ? error.message : null) || 'Failed to update follow status';
      // Whole batch failed — roll ALL targets back to their prior values.
      set((state) => {
        const followingUsers = { ...state.followingUsers };
        const loadingUsers = { ...state.loadingUsers };
        const errors = { ...state.errors };
        for (const uid of userIds) {
          const prev = previous.get(uid);
          if (prev === undefined) {
            delete followingUsers[uid];
          } else {
            followingUsers[uid] = prev;
          }
          loadingUsers[uid] = false;
          errors[uid] = message;
        }
        return { followingUsers, loadingUsers, errors };
      });
      throw error;
    }
  },
  unfollowManyUsers: async (userIds: string[], oxyServices: OxyServices): Promise<BulkUnfollowResult> => {
    // Snapshot prior values for rollback (tri-state: undefined = unknown).
    const prior = get().followingUsers;
    const previous = new Map<string, boolean | undefined>();
    for (const uid of userIds) {
      previous.set(uid, hasKey(prior, uid) ? prior[uid] : undefined);
    }

    // Optimistically mark every target NOT followed BEFORE the await.
    set((state) => {
      const followingUsers = { ...state.followingUsers };
      const loadingUsers = { ...state.loadingUsers };
      const errors = { ...state.errors };
      for (const uid of userIds) {
        followingUsers[uid] = false;
        loadingUsers[uid] = true;
        errors[uid] = null;
      }
      return { followingUsers, loadingUsers, errors };
    });

    try {
      const result = await oxyServices.unfollowUsers(userIds);
      set((state) => {
        const followingUsers = { ...state.followingUsers };
        const loadingUsers = { ...state.loadingUsers };
        const errors = { ...state.errors };
        for (const uid of userIds) {
          loadingUsers[uid] = false;
        }
        for (const entry of result.results) {
          if (entry.success) {
            followingUsers[entry.userId] = false;
            errors[entry.userId] = null;
          } else {
            // This target failed — roll IT back to its prior value.
            const prev = previous.get(entry.userId);
            if (prev === undefined) {
              delete followingUsers[entry.userId];
            } else {
              followingUsers[entry.userId] = prev;
            }
            errors[entry.userId] = 'Failed to update follow status';
          }
        }
        return { followingUsers, loadingUsers, errors };
      });
      return result;
    } catch (error: unknown) {
      const message = (error instanceof Error ? error.message : null) || 'Failed to update follow status';
      // Whole batch failed — roll ALL targets back to their prior values.
      set((state) => {
        const followingUsers = { ...state.followingUsers };
        const loadingUsers = { ...state.loadingUsers };
        const errors = { ...state.errors };
        for (const uid of userIds) {
          const prev = previous.get(uid);
          if (prev === undefined) {
            delete followingUsers[uid];
          } else {
            followingUsers[uid] = prev;
          }
          loadingUsers[uid] = false;
          errors[uid] = message;
        }
        return { followingUsers, loadingUsers, errors };
      });
      throw error;
    }
  },
  setFollowerCount: (userId: string, count: number) => set((state) => ({
    followerCounts: { ...state.followerCounts, [userId]: count },
  })),
  setFollowingCount: (userId: string, count: number) => set((state) => ({
    followingCounts: { ...state.followingCounts, [userId]: count },
  })),
  updateCountsFromFollowAction: (targetUserId: string, action: 'follow' | 'unfollow', counts: { followers: number; following: number }, currentUserId?: string) => {
    set((state) => {
      const followerCounts = { ...state.followerCounts, [targetUserId]: counts.followers };
      if (currentUserId) {
        return {
          followerCounts,
          followingCounts: { ...state.followingCounts, [currentUserId]: counts.following },
        };
      }
      return { followerCounts };
    });
  },
  fetchUserCounts: async (userId: string, oxyServices: OxyServices) => {
    set((state) => ({
      loadingCounts: { ...state.loadingCounts, [userId]: true },
    }));
    try {
      const user = await oxyServices.getUserById(userId);
      if (user?._count) {
        set((state) => ({
          followerCounts: {
            ...state.followerCounts,
            [userId]: user._count?.followers || 0,
          },
          followingCounts: {
            ...state.followingCounts,
            [userId]: user._count?.following || 0,
          },
          loadingCounts: { ...state.loadingCounts, [userId]: false },
        }));
      } else {
        set((state) => ({
          loadingCounts: { ...state.loadingCounts, [userId]: false },
        }));
      }
    } catch (error: unknown) {
      set((state) => ({
        loadingCounts: { ...state.loadingCounts, [userId]: false },
      }));
    }
  },
}));
