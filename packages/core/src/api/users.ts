/**
 * `oxy.users` — people and their profiles.
 */
import type {
  RecommendationItem,
  RecommendationRequest,
  UserProfileUpdate,
} from '@oxy.so/contracts';
import { recommendationRequestSchema } from '@oxy.so/contracts';
import type { OxyContext } from '../client/context';
import type { PaginationInfo, SearchProfilesResponse, User } from '../models/interfaces';
import { buildQueryParams, type PaginationParams } from '../utils/apiUtils';
import { normalizeUserIdentity, normalizeUserIdentityOrNull } from '../utils/userIdentity';
import { OXY_IDENTITY_CACHE_PREFIXES, oxyUserByIdCacheKey } from '../utils/identityCacheSweep';
import {
  OXY_ACCOUNT_LIST_CACHE_KEY,
  OXY_ACCOUNT_LIST_CACHE_QUERY_PREFIX,
  oxyAccountDetailCacheKey,
} from '../utils/accountCacheSweep';
import { extractErrorStatus } from '../utils/errorUtils';
import { logger } from '../logger';

const PROFILE_TTL = 5 * 60 * 1000;
const SESSION_USER_TTL = 2 * 60 * 1000;
const ME_TTL = 60 * 1000;
const SEARCH_TTL = 2 * 60 * 1000;

/**
 * Maximum number of ids sent per `POST /users/by-ids` request. Matches the
 * server-side batch cap; larger inputs are split into chunked calls.
 */
const USERS_BY_IDS_CHUNK_SIZE = 100;

/** A non-local user to find or create (`PUT /users/resolve`). */
export interface ResolveExternalUserInput {
  type: 'federated' | 'agent' | 'automated';
  username: string;
  actorUri?: string;
  domain?: string;
  displayName?: string;
  avatar?: string;
  bio?: string;
  ownerId?: string;
}

/**
 * What proves an account deletion (`DELETE /users/me`):
 * - `reauth` — an account without a key: a code just sent to its email by
 *   `oxy.auth.requestReauthCode('delete_account')`, plus its authenticator code
 *   when it has one;
 * - `deviceKey` — a Commons account: signed with the identity key held on this
 *   device (plus `totpCode` when the account has an authenticator).
 */
export type DeleteAccountProof =
  | { reauth: { emailCode: { verificationId: string; code: string }; totpCode?: string } }
  | { deviceKey: true; totpCode?: string };

export class UsersApi {
  constructor(private readonly ctx: OxyContext) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  /**
   * A user by id. Cached 5 minutes; pass `{ cache: false }` for a
   * registry-fresh read that neither serves nor overwrites a cached entry.
   */
  async get(userId: string, options?: { cache?: boolean }): Promise<User> {
    const user = await this.ctx.request<User>('GET', `/users/${userId}`, undefined, {
      cache: options?.cache ?? true,
      cacheTTL: PROFILE_TTL,
    });
    return normalizeUserIdentity(user);
  }

  /**
   * Many users by id, one round-trip per chunk of 100 — for hydration call
   * sites that would otherwise issue one `get` per author.
   *
   * Ids are deduplicated and blank ids dropped; the result is unordered (map
   * by `id`). `/users/by-ids` accepts a service token, a user session or an
   * anonymous caller and returns the same public payload in every case: on a
   * server that can mint a service token (`OxyServer`) the chunks go over the
   * service lane — an anonymous call from a backend is charged to its shared
   * NAT address's per-IP budget — and everywhere else over the user bearer.
   *
   * Chunks are independent: a failed chunk is logged and skipped. Not cached.
   */
  async getMany(ids: string[]): Promise<User[]> {
    const uniqueIds = Array.from(
      new Set(ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)),
    );
    if (uniqueIds.length === 0) return [];

    const chunks: string[][] = [];
    for (let i = 0; i < uniqueIds.length; i += USERS_BY_IDS_CHUNK_SIZE) {
      chunks.push(uniqueIds.slice(i, i + USERS_BY_IDS_CHUNK_SIZE));
    }

    const service = this.ctx.service?.available ? this.ctx.service : null;

    const settled = await Promise.all(
      chunks.map(async (chunk): Promise<User[]> => {
        try {
          const users = service
            ? await service.request<User[]>('POST', '/users/by-ids', { ids: chunk })
            : await this.ctx.request<User[]>('POST', '/users/by-ids', { ids: chunk }, { cache: false });
          return Array.isArray(users) ? users.map((user) => normalizeUserIdentity(user)) : [];
        } catch (error: unknown) {
          logger.warn('users.getMany: chunk failed, continuing with remaining chunks', {
            method: 'users.getMany',
            mode: service ? 'service' : 'user',
            chunkSize: chunk.length,
            status: extractErrorStatus(error),
            error: error instanceof Error ? error.message : String(error),
          });
          return [];
        }
      }),
    );
    return settled.flat();
  }

  /** The signed-in user. Cached 1 minute. */
  async me(): Promise<User> {
    const user = await this.ctx.request<User>('GET', '/users/me', undefined, { cache: true, cacheTTL: ME_TTL });
    return normalizeUserIdentity(user);
  }

  /** A profile by username. Cached 5 minutes; `{ cache: false }` as in `get`. */
  async byUsername(username: string, options?: { cache?: boolean }): Promise<User> {
    const user = await this.ctx.request<User>('GET', `/profiles/username/${encodeURIComponent(username)}`, undefined, {
      cache: options?.cache ?? true,
      cacheTTL: PROFILE_TTL,
    });
    return normalizeUserIdentity(user);
  }

  /** The user owning a public key. Public (pre-session): sends no bearer. */
  async byPublicKey(publicKey: string): Promise<User> {
    const user = await this.ctx.request<User>('GET', `/auth/user/${encodeURIComponent(publicKey)}`, undefined, {
      cache: true,
      cacheTTL: SESSION_USER_TTL,
      skipAuth: true,
    });
    return normalizeUserIdentity(user);
  }

  /** The user a session belongs to. */
  async bySession(sessionId: string): Promise<User> {
    const user = await this.ctx.request<User>('GET', `/session/user/${sessionId}`, undefined, {
      cache: true,
      cacheTTL: SESSION_USER_TTL,
    });
    return normalizeUserIdentity(user);
  }

  /** The users of many sessions in one request; `user` is `null` for a dead session. */
  async bySessions(sessionIds: string[]): Promise<Array<{ sessionId: string; user: User | null }>> {
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) return [];
    const unique = Array.from(new Set(sessionIds)).sort();
    const entries = await this.ctx.request<Array<{ sessionId: string; user: User | null }>>(
      'POST',
      '/session/users/batch',
      { sessionIds: unique },
      // A read over POST: sorted ids make the body a stable cache/dedupe key.
      { cache: true, cacheTTL: SESSION_USER_TTL, deduplicate: true },
    );
    return entries.map((entry) => ({ ...entry, user: normalizeUserIdentityOrNull(entry.user) }));
  }

  /**
   * Search profiles. Pass `signal` from a search box: every keystroke would
   * otherwise run a search to completion while holding a request-queue slot.
   */
  async search(
    query: string,
    pagination?: PaginationParams,
    options?: { signal?: AbortSignal },
  ): Promise<SearchProfilesResponse> {
    const response = await this.ctx.request<SearchProfilesResponse>(
      'GET',
      '/profiles/search',
      buildQueryParams({ query, ...pagination }),
      { cache: true, cacheTTL: SEARCH_TTL, signal: options?.signal },
    );

    if (typeof response !== 'object' || response === null || !Array.isArray(response.data)) {
      throw new Error('Unexpected search response format');
    }

    const limit = pagination?.limit ?? response.data.length;
    const paginationInfo: PaginationInfo = response.pagination ?? {
      total: response.data.length,
      limit,
      offset: pagination?.offset ?? 0,
      hasMore: response.data.length === limit && limit > 0,
    };
    return { data: response.data, pagination: paginationInfo };
  }

  /**
   * Resolve a fediverse handle (`@user@mastodon.social`) to an Oxy profile by
   * WebFinger. `null` when it cannot be resolved — discovery is best-effort.
   * Cached 5 minutes: the profile carries the viewer-relative `relationship`.
   */
  async resolveHandle(handle: string): Promise<User | null> {
    try {
      const result = await this.ctx.request<User | null>('GET', '/profiles/resolve', { handle }, {
        cache: true,
        cacheTTL: PROFILE_TTL,
      });
      return normalizeUserIdentityOrNull(result);
    } catch (error: unknown) {
      // A 404 (absent) and an upstream failure both return null; the log keeps
      // them distinguishable without turning expected misses into noise.
      const status = extractErrorStatus(error);
      logger.debug(status === 404 ? 'users.resolveHandle: handle not found' : 'users.resolveHandle: discovery failed', {
        method: 'users.resolveHandle',
        handle,
        status,
        notFound: status === 404,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Find or create a non-local user (federated, agent, automated). All user
   * creation for external accounts goes through here — services never write
   * user data directly.
   */
  async resolveExternal(input: ResolveExternalUserInput): Promise<User> {
    return normalizeUserIdentity(await this.ctx.request<User>('PUT', '/users/resolve', input));
  }

  /** Profiles similar to `userId`, by co-follower overlap. Cached 5 minutes. */
  async similar(userId: string, limitOrPagination?: number | PaginationParams): Promise<User[]> {
    const pagination = typeof limitOrPagination === 'number' ? { limit: limitOrPagination } : limitOrPagination ?? {};
    const users = await this.ctx.request<User[]>('GET', `/profiles/${userId}/similar`, buildQueryParams(pagination), {
      cache: true,
      cacheTTL: PROFILE_TTL,
    });
    return users.map((user) => normalizeUserIdentity(user));
  }

  /**
   * Profile recommendations. Works signed out (popular public profiles) and
   * personalises when signed in.
   *
   * Only `excludeTypes` / `limit` → the cached `GET /profiles/recommendations`.
   * Any scored field (`boosts`, `excludeIds`, `signalWeights`, `clientId`,
   * `offset`) → `POST` with the body validated by `recommendationRequestSchema`
   * (also cached, keyed on the body).
   */
  async recommendations(options?: RecommendationRequest): Promise<RecommendationItem[]> {
    const scored = Boolean(
      options &&
        (options.clientId !== undefined ||
          options.offset !== undefined ||
          (options.excludeIds?.length ?? 0) > 0 ||
          (options.boosts?.length ?? 0) > 0 ||
          options.signalWeights !== undefined),
    );

    try {
      if (scored && options) {
        const body = recommendationRequestSchema.parse(options);
        return await this.ctx.request<RecommendationItem[]>('POST', '/profiles/recommendations', body, { cache: true });
      }
      const params: Record<string, string> = {};
      if (options?.excludeTypes?.length) params.excludeTypes = options.excludeTypes.join(',');
      if (options?.limit !== undefined) params.limit = String(options.limit);
      return await this.ctx.request<RecommendationItem[]>(
        'GET',
        '/profiles/recommendations',
        Object.keys(params).length > 0 ? params : undefined,
        { cache: true },
      );
    } catch (error: unknown) {
      logger.debug('users.recommendations: discovery read failed', {
        method: 'users.recommendations',
        path: scored ? 'POST' : 'GET',
        excludeTypes: options?.excludeTypes,
        status: extractErrorStatus(error),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // ── The signed-in user ───────────────────────────────────────────────────

  /**
   * Update the signed-in user's profile and settings (`PUT /users/me`) —
   * including `notificationPreferences`, `userPreferences` and
   * `themePreference`.
   *
   * Every cached read that can return this user goes, in one pass: the
   * identity reads (the list `identityCacheSweep` owns) and the account forest
   * (a personal account IS this user, and `AccountNode.account` embeds it).
   *
   * A 401 with no token held rejects with `AUTH_REQUIRED_OFFLINE_SESSION: …` so
   * the caller knows to sync an offline session before retrying.
   */
  async updateMe(updates: UserProfileUpdate): Promise<User> {
    let result: User;
    try {
      result = normalizeUserIdentity(await this.ctx.request<User>('PUT', '/users/me', updates, { cache: false }));
    } catch (error) {
      if (extractErrorStatus(error) === 401 && !this.ctx.oxy.session.isAuthenticated) {
        throw new Error('AUTH_REQUIRED_OFFLINE_SESSION: Session needs to be synced to get a token');
      }
      throw error;
    }

    const id = result?.id;
    this.ctx.http.invalidateCache({
      prefixes: [...OXY_IDENTITY_CACHE_PREFIXES, OXY_ACCOUNT_LIST_CACHE_QUERY_PREFIX],
      keys: id
        ? [oxyUserByIdCacheKey(id), OXY_ACCOUNT_LIST_CACHE_KEY, oxyAccountDetailCacheKey(id)]
        : [OXY_ACCOUNT_LIST_CACHE_KEY],
    });
    return result;
  }

  /** Ask for the verified badge. */
  async requestVerification(reason: string, evidence?: string): Promise<{ message: string; requestId: string }> {
    return this.ctx.request('POST', '/users/verify/request', { reason, evidence }, { cache: false });
  }

  /**
   * Delete the signed-in account permanently. `confirmText` must equal the
   * username. See {@link DeleteAccountProof} for what confirms it.
   */
  async deleteMe(confirmText: string, proof: DeleteAccountProof): Promise<{ message: string }> {
    if ('reauth' in proof) {
      return this.ctx.request('DELETE', '/users/me', { confirmText, reauth: proof.reauth }, { cache: false });
    }

    // Loaded on demand: only a Commons account deleting from its own device
    // needs the key store, and nobody else should ship it.
    const { KeyManager, SignatureService } = await import('../crypto/internal');
    const publicKey = await KeyManager.getPublicKey();
    if (!publicKey) {
      throw new Error('No identity found on this device. Account deletion requires the device that holds your identity key.');
    }
    const timestamp = Date.now();
    const signature = await SignatureService.sign(`delete:${publicKey}:${timestamp}`);
    return this.ctx.request(
      'DELETE',
      '/users/me',
      { signature, timestamp, confirmText, ...(proof.totpCode ? { totpCode: proof.totpCode } : {}) },
      { cache: false },
    );
  }
}
