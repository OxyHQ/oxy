/**
 * `oxy.follows` — the follow graph.
 *
 * Two halves over one graph:
 * - **People** (`follow`, `unfollow`, `status`, `followers`, …) — the user
 *   follow routes (`/users/:id/follow…`). The SDK caches these reads and busts
 *   them on every write.
 * - **Targets** (`followTarget`, `targetStatus`, `list`, …) — the user-owned
 *   graph (`/v2/follows`): one relationship per user and target (a topic, a
 *   store, an artist, a channel), shared by every application, with
 *   per-application context on top. Never cached here: a follow status served
 *   stale across a write is the "follow reverts after navigating back" bug, so
 *   the app's own store is the single cache authority.
 */
import type {
  FollowListPage,
  FollowMutation,
  FollowOptions,
  FollowStatus,
  UnfollowMutation,
} from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';
import type { User } from '../models/interfaces';
import {
  buildPaginationParams,
  buildQueryParams,
  buildUrl,
  type FollowGraphParams,
} from '../utils/apiUtils';

const GRAPH_TTL = 2 * 60 * 1000;
const STATUS_TTL = 60 * 1000;

/**
 * Maximum number of ids sent per `POST /users/follow-status/bulk` request.
 * Matches the server-side `MAX_BULK_FOLLOW` cap.
 */
const FOLLOW_STATUS_CHUNK_SIZE = 200;

/** Response of `POST|DELETE /users/:id/follow`. */
export interface FollowMutationResult {
  /** Human-readable status message. */
  message: string;
  /** Which side of the toggle was applied, when reported. */
  action?: 'follow' | 'unfollow';
  /** Post-write counts, when reported. */
  counts?: {
    /** The target user's follower count after the write. */
    followers: number;
    /** The viewer's following count after the write. */
    following: number;
  };
}

/** Per-user outcome returned by `POST /users/follow/bulk`. */
export interface BulkFollowEntry {
  userId: string;
  /** Whether the follow was applied (or already in place) without error. */
  success: boolean;
  /** Whether the caller already followed this user. */
  alreadyFollowing: boolean;
}

/** Response of `POST /users/follow/bulk`. */
export interface BulkFollowResult {
  /** Per-user outcomes, in request order. */
  results: BulkFollowEntry[];
  /** Number of users newly followed. */
  followedCount: number;
}

/** Per-user outcome returned by `POST /users/unfollow/bulk`. */
export interface BulkUnfollowEntry {
  userId: string;
  /** Whether the unfollow was applied (or already absent) without error. */
  success: boolean;
  /** Whether the caller followed this user before. */
  wasFollowing: boolean;
}

/** Response of `POST /users/unfollow/bulk`. */
export interface BulkUnfollowResult {
  /** Per-user outcomes, in request order. */
  results: BulkUnfollowEntry[];
  /** Number of users newly unfollowed. */
  unfollowedCount: number;
}

/**
 * The signed-in viewer's OWN social graph, ids only (`GET /users/me/graph`):
 * who they follow, the mutuals among them, and who they blocked or restricted —
 * one round trip instead of four. Each list is server-bounded.
 */
export interface ViewerGraph {
  followingIds: string[];
  mutualIds: string[];
  blockedIds: string[];
  restrictedIds: string[];
}

/** A registered follow target (`POST /v2/follow-targets`). */
export interface EnsureFollowTargetInput {
  uri: string;
  kind: string;
  metadata?: Record<string, unknown>;
  providerReference?: string;
  localUserId?: string;
}

/** What following a kind of thing means (`POST /v2/follow-targets/kinds`). */
export interface RegisterFollowKindInput {
  kind: string;
  label?: string;
  capabilities?: {
    /** Matches `FollowVerb` in `@oxy.so/services`, which renders it. */
    verb?: 'follow' | 'subscribe' | 'join' | 'watch';
    reverse?: 'public' | 'private' | 'aggregate' | 'unavailable';
    federated?: boolean;
  };
}

type UserPage<K extends string> = { [P in K]: User[] } & { total: number; hasMore: boolean };

export class FollowsApi {
  constructor(private readonly ctx: OxyContext) {}

  // ── People ───────────────────────────────────────────────────────────────

  /** Follow a user. */
  async follow(userId: string): Promise<FollowMutationResult> {
    const result = await this.ctx.request<FollowMutationResult>('POST', `/users/${userId}/follow`, undefined, { cache: false });
    this.invalidate([userId]);
    return result;
  }

  /** Follow many users in one request (the server caps it at 200). */
  async followMany(userIds: string[]): Promise<BulkFollowResult> {
    if (userIds.length === 0) return { results: [], followedCount: 0 };
    const result = await this.ctx.request<BulkFollowResult>('POST', '/users/follow/bulk', { userIds }, { cache: false });
    this.invalidate(userIds);
    return result;
  }

  /** Unfollow a user. */
  async unfollow(userId: string): Promise<FollowMutationResult> {
    const result = await this.ctx.request<FollowMutationResult>('DELETE', `/users/${userId}/follow`, undefined, { cache: false });
    this.invalidate([userId]);
    return result;
  }

  /** Unfollow many users in one request (the server caps it at 200). */
  async unfollowMany(userIds: string[]): Promise<BulkUnfollowResult> {
    if (userIds.length === 0) return { results: [], unfollowedCount: 0 };
    const result = await this.ctx.request<BulkUnfollowResult>('POST', '/users/unfollow/bulk', { userIds }, { cache: false });
    this.invalidate(userIds);
    return result;
  }

  /** Whether the signed-in user follows `userId`. Cached 1 minute, busted by every write. */
  async status(userId: string): Promise<{ isFollowing: boolean }> {
    return this.ctx.request('GET', `/users/${userId}/follow-status`, undefined, { cache: true, cacheTTL: STATUS_TTL });
  }

  /**
   * Follow status for MANY users, one round-trip per chunk of 200 — for list
   * UIs that would otherwise fire one `status` per button. Every requested id
   * is in the result (`false` when not followed). Not cached: the UI store
   * owns follow-status freshness.
   */
  async statuses(userIds: string[]): Promise<Record<string, boolean>> {
    const uniqueIds = Array.from(
      new Set(userIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)),
    );
    if (uniqueIds.length === 0) return {};

    const chunks: string[][] = [];
    for (let i = 0; i < uniqueIds.length; i += FOLLOW_STATUS_CHUNK_SIZE) {
      chunks.push(uniqueIds.slice(i, i + FOLLOW_STATUS_CHUNK_SIZE));
    }

    const responses = await Promise.all(
      chunks.map((chunk) =>
        this.ctx.request<{ statuses: Record<string, boolean> }>(
          'POST',
          '/users/follow-status/bulk',
          { userIds: chunk },
          { cache: false },
        ),
      ),
    );
    const merged: Record<string, boolean> = {};
    for (const response of responses) Object.assign(merged, response?.statuses ?? {});
    return merged;
  }

  /**
   * A user's followers. `sort` is `recent` (default) or `oldest`; each
   * `limit`/`offset`/`sort` combination is its own cache entry (2 minutes).
   */
  async followers(userId: string, params?: FollowGraphParams): Promise<UserPage<'followers'>> {
    const { data, total, hasMore } = await this.userPage(`/users/${userId}/followers`, params);
    return { followers: data, total, hasMore };
  }

  /** Who a user follows. `sort` as in `followers`. */
  async following(userId: string, params?: FollowGraphParams): Promise<UserPage<'following'>> {
    const { data, total, hasMore } = await this.userPage(`/users/${userId}/following`, params);
    return { following: data, total, hasMore };
  }

  /**
   * "Followers you know": users the signed-in viewer follows who also follow
   * `userId`.
   */
  async mutuals(userId: string, params?: FollowGraphParams): Promise<UserPage<'mutuals'>> {
    const { data, total, hasMore } = await this.userPage(`/users/${userId}/mutuals`, params);
    return { mutuals: data, total, hasMore };
  }

  /**
   * The signed-in viewer's OWN mutuals, as ids — to seed a "Mutuals" feed.
   * Signed out: `[]`. Cached 2 minutes.
   */
  async mutualIds(params?: { limit?: number }): Promise<string[]> {
    const response = await this.ctx.request<{ data: string[] }>('GET', '/users/mutual-ids', buildPaginationParams(params ?? {}), {
      cache: true,
      cacheTTL: GRAPH_TTL,
    });
    return response.data || [];
  }

  /**
   * The signed-in viewer's follows-of-follows (two hops, minus their own
   * follows and themselves), as ids ordered by frequency then recency — to seed
   * a friends-of-friends feed. Signed out: `[]`. Cached 2 minutes.
   */
  async followsOfFollowsIds(params?: { limit?: number }): Promise<string[]> {
    const response = await this.ctx.request<{ data: string[] }>(
      'GET',
      '/users/follows-of-follows-ids',
      buildPaginationParams(params ?? {}),
      { cache: true, cacheTTL: GRAPH_TTL },
    );
    return response.data || [];
  }

  /**
   * The signed-in viewer's graph in one request (see {@link ViewerGraph}).
   * Cached 2 minutes; follow, block and restrict writes bust it.
   */
  async viewerGraph(): Promise<ViewerGraph> {
    const response = await this.ctx.request<{ data: ViewerGraph }>('GET', '/users/me/graph', undefined, {
      cache: true,
      cacheTTL: GRAPH_TTL,
    });
    const graph = response.data;
    return {
      followingIds: graph?.followingIds || [],
      mutualIds: graph?.mutualIds || [],
      blockedIds: graph?.blockedIds || [],
      restrictedIds: graph?.restrictedIds || [],
    };
  }

  // ── Targets (`/v2/follows`) ──────────────────────────────────────────────

  /**
   * Follow a registered target (by id, not URI — see `ensureTarget`).
   * Idempotent: an existing follow returns `created: false`. The follower and
   * the acting application are both derived server-side; `expiresIn` (seconds)
   * lets a follow lapse on its own.
   */
  async followTarget(targetId: string, options?: FollowOptions): Promise<FollowMutation> {
    return this.ctx.request<FollowMutation>(
      'PUT',
      `/v2/follows/${encodeURIComponent(targetId)}`,
      options?.expiresIn !== undefined ? { expiresIn: options.expiresIn } : {},
      { cache: false },
    );
  }

  /**
   * Unfollow everywhere. ("Unfollow here" is `setApplicationMode(…,
   * 'disabled')`.) Idempotent: `removed: false` when already gone.
   */
  async unfollowTarget(relationshipId: string): Promise<UnfollowMutation> {
    return this.ctx.request<UnfollowMutation>('DELETE', `/v2/follows/${encodeURIComponent(relationshipId)}`, undefined, {
      cache: false,
    });
  }

  /**
   * The three-part status — globally, in this application, in effect. Render
   * `effectiveState`; keep the other two for the explanation.
   */
  async targetStatus(targetId: string): Promise<FollowStatus> {
    return this.ctx.request<FollowStatus>('GET', `/v2/follows/${encodeURIComponent(targetId)}/status`, undefined, {
      cache: false,
    });
  }

  /**
   * Turn a relationship off, or back on, in ONE application — the calling one
   * unless `applicationId` names another (which needs `follows:manage`).
   */
  async setApplicationMode(
    relationshipId: string,
    mode: 'enabled' | 'disabled',
    applicationId?: string,
  ): Promise<{ ok: true }> {
    return this.ctx.request(
      'PUT',
      `/v2/follows/${encodeURIComponent(relationshipId)}/context`,
      { mode, ...(applicationId ? { applicationId } : {}) },
      { cache: false },
    );
  }

  /**
   * Drop the override so the application follows the global relationship
   * again (a later global change then takes effect here; an explicit
   * `enabled` would not).
   */
  async restoreInheritance(relationshipId: string, applicationId?: string): Promise<{ ok: true }> {
    const path = buildUrl(
      `/v2/follows/${encodeURIComponent(relationshipId)}/context`,
      applicationId ? { applicationId } : {},
    );
    return this.ctx.request('DELETE', path, undefined, { cache: false });
  }

  /**
   * Resolve a target by canonical URI, registering it the first time. Idempotent
   * on the URI, so two applications describing the same thing reach ONE row.
   * `metadata` is a display snapshot refreshed only by the providing app.
   */
  async ensureTarget(input: EnsureFollowTargetInput): Promise<{ id: string; uri: string; kind: string; created: boolean }> {
    return this.ctx.request('POST', '/v2/follow-targets', input, { cache: false });
  }

  /** Claim a namespace for the calling application (first come; idempotent for the holder). */
  async claimNamespace(namespace: string): Promise<{ namespace: string; created: boolean }> {
    return this.ctx.request('POST', '/v2/follow-targets/namespaces', { namespace }, { cache: false });
  }

  /**
   * Release a namespace the calling application holds, while nothing is
   * registered in it. Idempotent (`released: false` when already unowned).
   */
  async releaseNamespace(namespace: string): Promise<{ namespace: string; released: boolean }> {
    return this.ctx.request('DELETE', `/v2/follow-targets/namespaces/${encodeURIComponent(namespace)}`, undefined, {
      cache: false,
    });
  }

  /**
   * Declare what following a kind of thing MEANS — the verb, whether reverse
   * lookups are public, whether it federates. Once, by the owning application.
   */
  async registerKind(input: RegisterFollowKindInput): Promise<{ kind: string; created: boolean }> {
    return this.ctx.request('POST', '/v2/follow-targets/kinds', input, { cache: false });
  }

  /**
   * Everything the signed-in user follows, newest first. Paginate with
   * `nextCursor`, never an offset: the list changes while it is read.
   */
  async list(params?: { kind?: string; cursor?: string; limit?: number }): Promise<FollowListPage> {
    const path = buildUrl('/v2/me/follows', {
      ...(params?.kind ? { kind: params.kind } : {}),
      ...(params?.cursor ? { cursor: params.cursor } : {}),
      ...(params?.limit ? { limit: params.limit } : {}),
    });
    return this.ctx.request<FollowListPage>('GET', path, undefined, { cache: false });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async userPage(
    path: string,
    params?: FollowGraphParams,
  ): Promise<{ data: User[]; total: number; hasMore: boolean }> {
    const response = await this.ctx.request<{ data: User[]; pagination: { total: number; hasMore: boolean } }>(
      'GET',
      path,
      buildQueryParams(params ?? {}),
      { cache: true, cacheTTL: GRAPH_TTL },
    );
    return { data: response.data || [], total: response.pagination.total, hasMore: response.pagination.hasMore };
  }

  /**
   * Every cached read a follow write makes stale, in ONE pass over the cache.
   *
   * Lists go by PREFIX: they are paginated and sorted, so one logical list is
   * spread over many content-addressed keys, and an exact-key clear would bust
   * only the page read last.
   */
  private invalidate(targetUserIds: readonly string[]): void {
    const keys: string[] = ['GET:/users/me/graph'];
    const prefixes: string[] = ['GET:/profiles/username/', 'GET:/profiles/resolve'];
    for (const id of targetUserIds) {
      keys.push(`GET:/users/${id}/follow-status`);
      // Profiles embed the viewer-relative `relationship`.
      keys.push(`GET:/users/${id}`);
      // The target gained or lost a follower, and "followers you know" with it.
      prefixes.push(`GET:/users/${id}/followers`, `GET:/users/${id}/mutuals`);
    }
    // The viewer's own following list changed.
    const viewerId = this.ctx.oxy.session.userId;
    if (viewerId) prefixes.push(`GET:/users/${viewerId}/following`);
    this.ctx.http.invalidateCache({ keys, prefixes });
  }
}
