/**
 * User Types
 * 
 * Centralized type definitions for user-related operations.
 * The wire-facing shapes come from `@oxyhq/contracts`, so this module states
 * only what is local to the API's own user endpoints.
 */

import type { UserProfileUpdate, UserResponse } from '@oxyhq/contracts';

// The raw user document a public list query reads is `PublicUserDocument` in
// `utils/publicUserProjection.ts` — it lives next to the projection that
// produces it so the two cannot drift.

export type PublicUserProfile = UserResponse;

// Fields allowed for profile updates
export type ProfileUpdateInput = UserProfileUpdate;

// User statistics
export interface UserStatistics {
  followers: number;
  following: number;
}

// Pagination parameters
export interface PaginationParams {
  limit?: number;
  offset?: number;
}

/**
 * Ordering accepted by the follow-graph list endpoints
 * (`/users/:id/followers`, `/users/:id/following`, `/users/:id/mutuals`).
 *
 * `recent` (newest follow edge first) is the default and the historical
 * behaviour. Both orderings sort on the follow edge's own `createdAt`, so they
 * are served from the same index; an ordering that sorted on a JOINED user
 * field (alphabetical, follower count) would not be, which is why none is
 * offered here.
 */
export const FOLLOW_GRAPH_SORTS = ['recent', 'oldest'] as const;

export type FollowGraphSort = (typeof FOLLOW_GRAPH_SORTS)[number];

export const DEFAULT_FOLLOW_GRAPH_SORT: FollowGraphSort = 'recent';

/** Narrow an untrusted query value to a supported sort. */
export function isFollowGraphSort(value: unknown): value is FollowGraphSort {
  return typeof value === 'string' && (FOLLOW_GRAPH_SORTS as readonly string[]).includes(value);
}

/**
 * Pagination plus follow-graph ordering.
 *
 * Deliberately NOT folded into `PaginationParams`: that type is shared by many
 * endpoints which accept no `sort` at all.
 */
export interface FollowGraphParams extends PaginationParams {
  sort?: FollowGraphSort;
}

// Paginated response
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  hasMore: boolean;
  limit: number;
  offset: number;
}

// Follow action result
export interface FollowActionResult {
  action: 'follow' | 'unfollow';
  counts: {
    followers: number;
    following: number;
  };
}

/**
 * The authenticated viewer's OWN social graph, ids-only, in one payload.
 *
 * Consolidates the three per-viewer graph reads consuming apps (Mention, Allo,
 * Homiio) previously made as separate round trips — the accounts the viewer
 * follows, the subset who follow back (mutuals), and the accounts the viewer
 * has blocked. Each list is bounded (see the `MAX_*_IDS` caps in
 * `recommendationWeights`) so the `$in` queries and the response payload stay
 * small regardless of how large the viewer's graph is. Bare ids only — no
 * hydrated DTOs and no `_count` — because the consumer hydrates/ranks itself.
 */
export interface ViewerGraph {
  /** Accounts the viewer follows (most-recent first, bounded). */
  followingIds: string[];
  /** Accounts the viewer follows that ALSO follow the viewer back (bounded). */
  mutualIds: string[];
  /** Accounts the viewer has blocked (bounded). */
  blockedIds: string[];
  /** Accounts the viewer has restricted (bounded). */
  restrictedIds: string[];
}
