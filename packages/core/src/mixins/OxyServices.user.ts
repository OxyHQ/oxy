/**
 * User Management Methods Mixin
 */
import type {
  User,
  Notification,
  NotificationPreferences,
  UserPreferences,
  SearchProfilesResponse,
  PaginationInfo,
  PrivacySettings,
} from '../models/interfaces';
import type {
  UserNameResponse,
  UserProfileUpdate,
  RecommendationRequest,
  RecommendationItem,
  ThemePreference,
} from '@oxyhq/contracts';
import { recommendationRequestSchema } from '@oxyhq/contracts';
import type { OxyServicesBase } from '../OxyServices.base';
import {
  buildQueryParams,
  buildPaginationParams,
  type PaginationParams,
  type FollowGraphParams,
} from '../utils/apiUtils';
import { KeyManager } from '../crypto/keyManager';
import { SignatureService } from '../crypto/signatureService';
import { normalizeUserIdentity, normalizeUserIdentityOrNull } from '../utils/userIdentity';
import { evictOxyIdentityCache } from '../utils/identityCacheSweep';
import { evictOxyAccountForestCache } from '../utils/accountCacheSweep';
import { logger } from '../logger';
import { extractErrorStatus } from '../utils/errorUtils';

/**
 * Maximum number of ids sent per `POST /users/by-ids` request. Matches the
 * server-side batch cap; larger inputs are split into multiple chunked calls.
 */
const USERS_BY_IDS_CHUNK_SIZE = 100;

/**
 * Maximum number of ids sent per `POST /users/follow-status/bulk` request.
 * Matches the server-side `MAX_BULK_FOLLOW` cap; larger inputs are split into
 * multiple chunked calls whose result maps are merged.
 */
const FOLLOW_STATUS_CHUNK_SIZE = 200;

/**
 * Response of the single follow/unfollow toggle route
 * (`POST /users/:id/follow` and `DELETE /users/:id/follow`). The route reports a
 * status message, which side of the toggle was applied, and the post-write
 * follower/following counts for the affected users.
 */
export interface FollowMutationResult {
  /** Human-readable status message. */
  message: string;
  /** Which side of the toggle was applied, when reported by the route. */
  action?: 'follow' | 'unfollow';
  /** Post-write counts, when reported by the route. */
  counts?: {
    /** The target user's follower count after the write. */
    followers: number;
    /** The viewer's following count after the write. */
    following: number;
  };
}

/** Per-user outcome returned by `POST /users/follow/bulk`. */
export interface BulkFollowEntry {
  /** The user ID that was processed. */
  userId: string;
  /** Whether the follow was applied (or already in place) without error. */
  success: boolean;
  /** Whether the caller was already following this user before the request. */
  alreadyFollowing: boolean;
}

/** Response shape of `POST /users/follow/bulk`. */
export interface BulkFollowResult {
  /** Per-user outcomes, in request order. */
  results: BulkFollowEntry[];
  /** Number of users newly followed by this request. */
  followedCount: number;
}

/**
 * The authenticated viewer's OWN social graph, ids-only — the response of
 * `GET /users/me/graph`. Consolidates the accounts the viewer follows, the
 * subset who follow back (mutuals), and the accounts the viewer has blocked
 * into one payload so a consumer can fetch its whole viewer graph in a single
 * round trip instead of three. Each list is server-bounded; bare ids only (no
 * hydrated DTOs) because the consumer hydrates/ranks itself.
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

/** Per-user outcome returned by `POST /users/unfollow/bulk`. */
export interface BulkUnfollowEntry {
  /** The user ID that was processed. */
  userId: string;
  /** Whether the unfollow was applied (or already absent) without error. */
  success: boolean;
  /** Whether the caller was following this user before the request. */
  wasFollowing: boolean;
}

/** Response shape of `POST /users/unfollow/bulk`. */
export interface BulkUnfollowResult {
  /** Per-user outcomes, in request order. */
  results: BulkUnfollowEntry[];
  /** Number of users newly unfollowed by this request. */
  unfollowedCount: number;
}

export function OxyServicesUserMixin<T extends typeof OxyServicesBase>(Base: T) {
  return class extends Base {
    constructor(...args: any[]) {
      super(...(args as [any]));
    }

    /**
     * Service-token request, implemented by the auth mixin earlier in the
     * composition pipeline (see `mixins/index.ts`). The user mixin is typed
     * against `OxyServicesBase`, which does not carry the auth mixin's methods,
     * so this `declare` surfaces the inherited runtime method to TypeScript
     * without re-implementing it. Used by `getUsersByIds` to authenticate the
     * server-to-server `/users/by-ids` bulk fetch with a bearer service token.
     */
    declare makeServiceRequest: <R = unknown>(
      method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
      url: string,
      data?: unknown,
      userId?: string,
    ) => Promise<R>;

    /**
     * Raw service credentials stored by `configureServiceAuth()` on the auth
     * mixin (earlier in the pipeline). Surfaced here via `declare` — for the
     * same typing reason as `makeServiceRequest` above — so `getUsersByIds` can
     * detect whether this instance is service-configured (a backend) and pick
     * the bearer-service path, or fall back to the user-session path (a browser/
     * RN client). Both are `null` until `configureServiceAuth(apiKey, apiSecret)`
     * is called.
     */
    declare _serviceApiKey: string | null;
    declare _serviceApiSecret: string | null;

    /**
     * Get profile by username.
     *
     * @param username - The profile's username.
     * @param options.cache - Defaults to `true` (5-minute TTL), matching prior
     *   behavior. Pass `{ cache: false }` to force a registry-fresh read: the
     *   request bypasses BOTH the cache lookup and the post-fetch cache write
     *   (see {@link HttpService.request}'s `cache` handling), so it neither
     *   serves nor overwrites any entry already cached for this key — a
     *   previously cached response (if one exists) is left in place until its
     *   own TTL expires or is explicitly invalidated elsewhere. Use this when a
     *   caller must observe a just-written change (e.g. a privacy/consent flag)
     *   that would otherwise be masked by the TTL window.
     */
    async getProfileByUsername(username: string, options?: { cache?: boolean }): Promise<User> {
      try {
        const user = await this.makeRequest<User>('GET', `/profiles/username/${encodeURIComponent(username)}`, undefined, {
          cache: options?.cache ?? true,
          cacheTTL: 5 * 60 * 1000, // 5 minutes cache for profiles
        });
        return normalizeUserIdentity(user);
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Lightweight username lookup for login flows.
     * Returns minimal public info: exists, color, avatar, name.displayName.
     * Faster than getProfileByUsername — no stats, no formatting.
     */
    async lookupUsername(username: string): Promise<{
      exists: boolean;
      username: string;
      color: string | null;
      avatar: string | null;
      name: UserNameResponse;
    }> {
      return await this.makeRequest('GET', `/auth/lookup/${encodeURIComponent(username)}`, undefined, {
        cache: true,
        cacheTTL: 60 * 1000, // 1 minute cache
        // Public login-flow lookup (pre-session) — skip the bearer preflight.
        skipAuth: true,
      });
    }

    /**
     * Search user profiles
     */
    async searchProfiles(query: string, pagination?: PaginationParams): Promise<SearchProfilesResponse> {
      try {
        const response = await this.makeRequest<SearchProfilesResponse>(
          'GET',
          '/profiles/search',
          buildQueryParams({ query, ...pagination }),
          {
            cache: true,
            cacheTTL: 2 * 60 * 1000, // 2 minutes cache
          }
        );

        if (
          typeof response !== 'object' ||
          response === null ||
          !Array.isArray(response.data)
        ) {
          throw new Error('Unexpected search response format');
        }

        const paginationInfo: PaginationInfo = response.pagination ?? {
          total: response.data.length,
          limit: pagination?.limit ?? response.data.length,
          offset: pagination?.offset ?? 0,
          hasMore: response.data.length === (pagination?.limit ?? response.data.length) &&
            (pagination?.limit ?? response.data.length) > 0,
        };

        return {
          data: response.data,
          pagination: paginationInfo,
        };
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Resolve a fediverse handle to an Oxy user profile.
     * Performs WebFinger discovery and returns the user, or null if not found.
     * @param handle - Fediverse handle (e.g. "@user@mastodon.social" or "user@domain")
     */
    async resolveProfile(handle: string): Promise<User | null> {
      try {
        const result = await this.makeRequest<User | null>('GET', '/profiles/resolve', {
          handle,
        }, {
          cache: true,
          // 5 min — matches the sibling profile fetches (getUserById /
          // getProfileByUsername). /profiles/resolve now carries the viewer-relative
          // `relationship` (isFollowing / followsYou); `followsYou` is target→viewer,
          // so the viewer can't self-refresh it via a follow action. The GET cache is
          // identity-scoped (keyed by the caller's access-token identity tag → no
          // cross-viewer poison), so a short TTL keeps "Follows you" reasonably fresh
          // without a per-call bypass. The identity fields alone tolerate a longer
          // window, but a 24h stale relationship is not acceptable.
          cacheTTL: 5 * 60 * 1000,
        });
        return normalizeUserIdentityOrNull(result);
      } catch (error: unknown) {
        // Discovery is best-effort: an unresolvable handle is a normal "not
        // found", not an exceptional condition, so the contract stays `null`.
        // But a 404 (handle genuinely absent) must be distinguishable from a
        // network/server failure (WebFinger upstream down, 5xx) for debugging —
        // both used to be swallowed identically. Log at `debug` with context so
        // the distinction is observable without turning expected misses into
        // noise. Return contract is unchanged.
        const status = extractErrorStatus(error);
        const isNotFound = status === 404;
        logger.debug(
          isNotFound ? 'resolveProfile: handle not found' : 'resolveProfile: discovery failed',
          {
            method: 'resolveProfile',
            handle,
            status,
            notFound: isNotFound,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return null;
      }
    }

    /**
     * Resolve (find or create) a non-local user. All user creation for
     * external accounts (federated, agent, automated) goes through this
     * method — calling services never write user data directly.
     */
    async resolveExternalUser(data: {
      type: 'federated' | 'agent' | 'automated';
      username: string;
      actorUri?: string;
      domain?: string;
      displayName?: string;
      avatar?: string;
      bio?: string;
      ownerId?: string;
    }): Promise<User> {
      return normalizeUserIdentity(await this.makeRequest<User>('PUT', '/users/resolve', data));
    }

    /**
     * Get profile recommendations.
     *
     * Public discovery read — works WITHOUT authentication. The SDK attaches the
     * access token automatically when one is available (personalized via
     * mutual-connection overlap), and falls back to popular public profiles when
     * the caller is logged out. This deliberately does NOT use `withAuthRetry`,
     * which would throw an authentication timeout for logged-out callers before
     * the request is ever sent.
     *
     * Routing (two server endpoints, both validated against the same
     * `@oxyhq/contracts` recommendation schemas so the wire shape cannot drift):
     *
     *  - **GET `/profiles/recommendations`** (cached) is used for the simple,
     *    back-compatible case: no options at all, or only `excludeTypes` and/or
     *    `limit`. `excludeTypes` is sent as a comma-joined query param and
     *    `limit` as a numeric query param — byte-for-byte identical to the legacy
     *    behavior so every existing caller keeps the same request and cache key.
     *  - **POST `/profiles/recommendations`** is used whenever any of the scored
     *    (v2) fields — `boosts`, `excludeIds`, `signalWeights`, `clientId`, or
     *    `offset` — is present. The full options object is validated with
     *    `recommendationRequestSchema` and sent as the request body. The POST is
     *    cached by the HttpService keyed on the serialized body, so repeated
     *    identical scored requests are deduplicated/cached just like the GET path.
     *
     * @param options - {@link RecommendationRequest} from `@oxyhq/contracts`.
     *   Omitted entirely (or `{ excludeTypes }`) preserves the legacy GET path.
     */
    async getProfileRecommendations(
      options?: RecommendationRequest,
    ): Promise<RecommendationItem[]> {
      // The scored (v2) POST path is selected when any field beyond the
      // legacy GET-supported `excludeTypes`/`limit` pair is present.
      const usesScoredPath = Boolean(
        options &&
          (options.clientId !== undefined ||
            options.offset !== undefined ||
            (options.excludeIds?.length ?? 0) > 0 ||
            (options.boosts?.length ?? 0) > 0 ||
            options.signalWeights !== undefined),
      );

      try {
        if (usesScoredPath && options) {
          // Validate the full request against the shared contract before
          // sending. A malformed payload is surfaced to the caller rather than
          // bounced by the server, and the parsed value strips unknown keys.
          const body = recommendationRequestSchema.parse(options);
          return await this.makeRequest<RecommendationItem[]>(
            'POST',
            '/profiles/recommendations',
            body,
            // Cache keyed on the serialized body (see HttpService.generateCacheKey)
            // so identical scored requests are served from cache, matching the
            // GET path's caching semantics.
            { cache: true },
          );
        }

        const params: Record<string, string> = {};
        if (options?.excludeTypes?.length) {
          params.excludeTypes = options.excludeTypes.join(',');
        }
        if (options?.limit !== undefined) {
          params.limit = String(options.limit);
        }
        return await this.makeRequest<RecommendationItem[]>(
          'GET',
          '/profiles/recommendations',
          Object.keys(params).length > 0 ? params : undefined,
          { cache: true },
        );
      } catch (error: unknown) {
        // Recommendations are a discovery read; failures are surfaced to the
        // caller (contract unchanged: rethrow via `handleError`). Add debug
        // observability first so a recurring upstream failure is diagnosable
        // — distinguishing an auth/transport problem from a server 5xx.
        logger.debug('getProfileRecommendations: discovery read failed', {
          method: 'getProfileRecommendations',
          path: usesScoredPath ? 'POST' : 'GET',
          excludeTypes: options?.excludeTypes,
          status: extractErrorStatus(error),
          error: error instanceof Error ? error.message : String(error),
        });
        throw this.handleError(error);
      }
    }

    /**
     * Get profiles similar to a given user, based on co-follower overlap.
     */
    async getSimilarProfiles(
      userId: string,
      limitOrParams?: number | { limit?: number; offset?: number },
    ): Promise<User[]> {
      const pagination =
        typeof limitOrParams === 'number' ? { limit: limitOrParams } : limitOrParams ?? {};
      const params = buildQueryParams(pagination);
      const users = await this.makeRequest<User[]>('GET', `/profiles/${userId}/similar`, params, {
        cache: true,
        cacheTTL: 5 * 60 * 1000, // 5 min cache
      });
      return users.map((user) => normalizeUserIdentity(user));
    }

    /**
     * Get user by ID.
     *
     * @param userId - The target user's id.
     * @param options.cache - Defaults to `true` (5-minute TTL), matching prior
     *   behavior. Pass `{ cache: false }` to force a registry-fresh read: the
     *   request bypasses BOTH the cache lookup and the post-fetch cache write
     *   (see {@link HttpService.request}'s `cache` handling), so it neither
     *   serves nor overwrites any entry already cached for this key — a
     *   previously cached response (if one exists) is left in place until its
     *   own TTL expires or is explicitly invalidated elsewhere. Use this when a
     *   caller must observe a just-written change (e.g. a privacy/consent flag)
     *   that would otherwise be masked by the TTL window.
     */
    async getUserById(userId: string, options?: { cache?: boolean }): Promise<User> {
      try {
        const user = await this.makeRequest<User>('GET', `/users/${userId}`, undefined, {
          cache: options?.cache ?? true,
          cacheTTL: 5 * 60 * 1000, // 5 minutes cache
        });
        return normalizeUserIdentity(user);
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Fetch many users by id in one round-trip per chunk.
     *
     * Built for feed/hydration call sites that would otherwise issue one
     * `getUserById` request per unique author (the classic M+1). Ids are
     * deduplicated and validated (empty/blank ids dropped) before being split
     * into chunks of {@link USERS_BY_IDS_CHUNK_SIZE} and POSTed to
     * `/users/by-ids` as `{ ids }`. The server returns the matched users as a
     * flat `User[]` (order is not guaranteed and the caller is expected to map
     * by `id`); each is run through `normalizeUserIdentity`, matching
     * `getUserById`.
     *
     * **Dual-mode auth.** `/users/by-ids` is `optionalUserOrServiceAuth` on
     * oxy-api: it accepts a service token, a user session, or an anonymous
     * caller, and returns the SAME public `{ data: PublicUserProfile[] }`
     * payload (canonical `name.displayName` + `_count`) in every case — no
     * viewer-specific fields. This method picks the path automatically:
     * - **Service-configured host (backend):** when `configureServiceAuth(apiKey,
     *   apiSecret)` has been called, the chunk is fetched via `makeServiceRequest`
     *   (attaches `Authorization: Bearer <serviceToken>`). This is the
     *   server-to-server feed/notification hydration path (e.g. Mention's
     *   `PostHydrationService`) and is unchanged.
     * - **Plain client (browser / React Native with a user session):** when no
     *   service credentials are configured, the chunk is fetched via
     *   `makeRequest`, which attaches the configured user bearer. oxy-api's CSRF
     *   middleware skips bearer-authenticated writes, and `makeRequest` only
     *   fetches a CSRF token for cookie-only (no-bearer) state-changing requests,
     *   so the user-bearer POST is sent without CSRF and succeeds. Previously
     *   this method always used the service path, so every client-side caller
     *   silently received `[]` because `getServiceToken()` had no credentials.
     *
     * Both paths run results through `normalizeUserIdentity` and unwrap the
     * API's `{ data }` envelope identically (`makeServiceRequest` is literally
     * `makeRequest` plus a bearer service header).
     *
     * Resilience: chunks are independent. A failed chunk is logged and skipped
     * — the method returns every user that resolved successfully rather than
     * discarding the whole call on one chunk's failure. An empty/whitespace-only
     * input resolves immediately with `[]` and performs no network call.
     *
     * Not cached at the SDK layer: the response is keyed on a multi-id POST body
     * (low hit rate) and the backend maintains its own per-id Redis cache.
     */
    async getUsersByIds(ids: string[]): Promise<User[]> {
      const uniqueIds = Array.from(
        new Set(ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)),
      );
      if (uniqueIds.length === 0) {
        return [];
      }

      const chunks: string[][] = [];
      for (let i = 0; i < uniqueIds.length; i += USERS_BY_IDS_CHUNK_SIZE) {
        chunks.push(uniqueIds.slice(i, i + USERS_BY_IDS_CHUNK_SIZE));
      }

      // A backend that called configureServiceAuth() uses the bearer-service
      // path; any other caller (browser / RN with a user session) uses the
      // user-bearer path. See the method doc for why the user path is CSRF-safe.
      const useServiceAuth = Boolean(this._serviceApiKey && this._serviceApiSecret);

      // Run chunks concurrently; a single chunk failure must not sink the rest.
      const settled = await Promise.all(
        chunks.map(async (chunk): Promise<User[]> => {
          try {
            const users = useServiceAuth
              ? await this.makeServiceRequest<User[]>('POST', '/users/by-ids', { ids: chunk })
              : await this.makeRequest<User[]>('POST', '/users/by-ids', { ids: chunk }, { cache: false });
            return Array.isArray(users) ? users.map((user) => normalizeUserIdentity(user)) : [];
          } catch (error: unknown) {
            logger.warn('getUsersByIds: chunk failed, continuing with remaining chunks', {
              method: 'getUsersByIds',
              mode: useServiceAuth ? 'service' : 'user',
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

    /**
     * Get current user
     */
    async getCurrentUser(): Promise<User> {
      return this.withAuthRetry(async () => {
        const user = await this.makeRequest<User>('GET', '/users/me', undefined, {
          cache: true,
          cacheTTL: 1 * 60 * 1000, // 1 minute cache for current user
        });
        return normalizeUserIdentity(user);
      }, 'getCurrentUser');
    }

    /**
     * Update user profile.
     *
     * Invalidates the SDK-side response cache for every endpoint that can
     * return this user — the list is owned by {@link evictOxyIdentityCache}, so
     * a new identity read is added in one place instead of to each writer
     * separately (this method's own hand-written copy had already drifted from
     * the server-side one, missing `GET /auth/lookup/*` and
     * `GET /profiles/resolve`). The account forest (`GET /accounts` and the
     * caller's own detail row) is swept too — a personal account IS this user,
     * and `AccountNode.account` embeds the whole profile — from the list that
     * {@link evictOxyAccountForestCache} owns, for the same reason: the accounts
     * mixin writes those keys as well, and two hand-written copies drift.
     *
     * TanStack Query handles offline queuing automatically.
     */
    async updateProfile(updates: UserProfileUpdate): Promise<User> {
      try {
        const result = normalizeUserIdentity(
          await this.makeRequest<User>('PUT', '/users/me', updates, { cache: false }),
        );

        evictOxyIdentityCache(this, result?.id);
        evictOxyAccountForestCache(this, result?.id);

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const status = extractErrorStatus(error);

        // Check if it's an authentication error (401)
        const isAuthError = status === 401 ||
          errorMessage.includes('Authentication required') ||
          errorMessage.includes('Invalid or missing authorization header');

        // If authentication error and we don't have a token, this might be an offline session
        // The caller should handle syncing the session before retrying
        if (isAuthError && !this.hasValidToken()) {
          // Re-throw with a specific message so the caller knows to sync
          throw new Error('AUTH_REQUIRED_OFFLINE_SESSION: Session needs to be synced to get a token');
        }

        throw this.handleError(error);
      }
    }

    /**
     * Get privacy settings for a user
     * @param userId - The user ID (defaults to current user)
     */
    async getPrivacySettings(userId?: string): Promise<PrivacySettings> {
      try {
        const id = userId || (await this.getCurrentUser()).id;
        return await this.makeRequest<PrivacySettings>('GET', `/privacy/${id}/privacy`, undefined, {
          cache: true,
          cacheTTL: 2 * 60 * 1000, // 2 minutes cache
        });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Update privacy settings.
     *
     * Invalidates the cached `GET /privacy/<id>/privacy` response (the exact
     * key `getPrivacySettings` reads, scoped to the same `id`) after the write.
     * `getPrivacySettings` caches for ~2 minutes (identity-scoped); without
     * busting that entry, a follow-up read within the TTL window returns the
     * pre-update settings. `clearCacheEntry` deletes every identity-scoped
     * variant of the key.
     * @param settings - Partial privacy settings object
     * @param userId - The user ID (defaults to current user)
     */
    async updatePrivacySettings(settings: Partial<PrivacySettings>, userId?: string): Promise<PrivacySettings> {
      try {
        const id = userId || (await this.getCurrentUser()).id;
        const result = await this.makeRequest<PrivacySettings>('PATCH', `/privacy/${id}/privacy`, settings, {
          cache: false,
        });
        // Privacy settings ride the user DTO, so every identity read goes stale
        // too — same key list as any other profile write.
        evictOxyIdentityCache(this, id);
        this.clearCacheEntry(`GET:/privacy/${id}/privacy`);
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Update the authenticated user's notification preferences.
     *
     * Thin wrapper over `updateProfile` that constrains the patch to known
     * notification channels — same persistence path, same cache invalidation,
     * but type-safe at the call site.
     */
    async updateNotificationPreferences(
      preferences: Partial<NotificationPreferences>
    ): Promise<User> {
      return this.updateProfile({ notificationPreferences: preferences });
    }

    /**
     * Update the authenticated user's general preferences (language, theme,
     * reduce-motion, timezone). Persisted on the User document via
     * `PUT /users/me` — same cache-invalidation behaviour as `updateProfile`.
     */
    async updateUserPreferences(
      preferences: Partial<UserPreferences>
    ): Promise<User> {
      return this.updateProfile({ userPreferences: preferences });
    }

    /**
     * Update the authenticated user's portable theme preference (light/dark/
     * system + Bloom color-preset key). Persisted on the User document via the
     * SAME `PUT /users/me` settings path as the other preferences — same cache
     * invalidation — so the next cold boot serves it on the self/session payload
     * with no extra network call. The full object is written (both `mode` and
     * `colorPreset` are required by the API).
     */
    async updateThemePreference(
      themePreference: ThemePreference
    ): Promise<User> {
      return this.updateProfile({ themePreference });
    }

    /**
     * Request account verification
     */
    async requestAccountVerification(reason: string, evidence?: string): Promise<{ message: string; requestId: string }> {
      try {
        return await this.makeRequest<{ message: string; requestId: string }>('POST', '/users/verify/request', {
          reason,
          evidence,
        }, { cache: false });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Download account data export
     */
    async downloadAccountData(format: 'json' | 'csv' = 'json'): Promise<Blob> {
      try {
        // Use httpService for blob responses (it handles blob responses automatically)
        const result = await this.getClient().request<Blob>({
          method: 'GET',
          url: `/users/me/data`,
          params: { format },
          cache: false,
          responseType: 'blob',
        });
        
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Delete account permanently.
     *
     * Signs `delete:{publicKey}:{timestamp}` with the locally-stored identity
     * private key and submits the signature alongside the confirmation text
     * (must equal the user's username). The signature is the cryptographic
     * proof of ownership — only the device holding the private key can issue
     * a valid signature, so no password is required.
     *
     * @param confirmText - Must equal the user's username (verified server-side)
     * @throws If no identity is stored on this device, or signing fails
     */
    async deleteAccount(confirmText: string): Promise<{ message: string }> {
      try {
        const publicKey = await KeyManager.getPublicKey();
        if (!publicKey) {
          throw new Error('No identity found on this device. Account deletion requires the device that holds your identity key.');
        }

        const timestamp = Date.now();
        const message = `delete:${publicKey}:${timestamp}`;
        const signature = await SignatureService.sign(message);

        return await this.makeRequest<{ message: string }>('DELETE', '/users/me', {
          signature,
          timestamp,
          confirmText,
        }, { cache: false });
      } catch (error) {
        throw this.handleError(error);
      }
    }


    /**
     * Invalidate every cached read a follow/unfollow write invalidates.
     *
     * Shared by the four mutation entry points (`followUser`, `unfollowUser`,
     * `followUsers`, `unfollowUsers`) so they can never drift on which caches a
     * write busts.
     *
     * The follower/following/mutuals LISTS are cleared by PREFIX rather than by
     * exact key. Those reads are paginated and ordered, so one logical list is
     * spread across many content-addressed keys
     * (`GET:/users/<id>/followers:{"limit":"20","offset":"40","sort":"oldest"}`);
     * an exact-key clear would only bust whichever page/sort variant happened to
     * be read last and would leave every other page stale. `clearCacheByPrefix`
     * deletes all of them, and all identity-scoped variants of each.
     */
    invalidateFollowGraphCaches(targetUserIds: string[]): void {
      for (const id of targetUserIds) {
        this.clearCacheEntry(`GET:/users/${id}/follow-status`);
        // Profile fetches embed viewer-relative `relationship` — bust so a
        // remount doesn't serve a stale isFollowing for up to 5 minutes.
        this.clearCacheEntry(`GET:/users/${id}`);
        // The target gained/lost a follower, and the viewer's presence in the
        // target's "followers you know" set changed with it.
        this.clearCacheByPrefix(`GET:/users/${id}/followers`);
        this.clearCacheByPrefix(`GET:/users/${id}/mutuals`);
      }
      this.clearCacheByPrefix('GET:/profiles/username/');
      this.clearCacheByPrefix('GET:/profiles/resolve');
      // The write changed the viewer's OWN following list and graph.
      const viewerId = this.getCurrentUserId();
      if (viewerId) {
        this.clearCacheByPrefix(`GET:/users/${viewerId}/following`);
      }
      this.clearCacheEntry('GET:/users/me/graph');
    }

    /**
     * Follow a user.
     *
     * Invalidates the cached `GET /users/<id>/follow-status` response after
     * the write. `getFollowStatus` caches for ~1 minute (identity-scoped);
     * without busting that entry, a `FollowButton` that remounts within the
     * TTL window re-reads the STALE pre-write status and reverts the optimistic
     * UI (the "follow resets after navigating away and back" bug).
     * `clearCacheEntry` deletes every identity-scoped variant of the key.
     */
    async followUser(userId: string): Promise<FollowMutationResult> {
      try {
        const result = await this.makeRequest<FollowMutationResult>('POST', `/users/${userId}/follow`, undefined, { cache: false });
        this.invalidateFollowGraphCaches([userId]);
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Follow multiple users in a single request.
     *
     * POSTs `/users/follow/bulk` with `{ userIds }` (server caps the batch at
     * 200). Returns the per-user outcomes and the count of users newly
     * followed. An empty `userIds` array resolves immediately with an empty
     * result and performs no network call.
     */
    async followUsers(userIds: string[]): Promise<BulkFollowResult> {
      if (userIds.length === 0) {
        return { results: [], followedCount: 0 };
      }
      try {
        const result = await this.makeRequest<BulkFollowResult>('POST', '/users/follow/bulk', { userIds }, { cache: false });
        this.invalidateFollowGraphCaches(userIds);
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Unfollow multiple users in a single request.
     *
     * POSTs `/users/unfollow/bulk` with `{ userIds }` (server caps the batch at
     * 200). Returns the per-user outcomes and the count of users newly
     * unfollowed. An empty `userIds` array resolves immediately with an empty
     * result and performs no network call.
     */
    async unfollowUsers(userIds: string[]): Promise<BulkUnfollowResult> {
      if (userIds.length === 0) {
        return { results: [], unfollowedCount: 0 };
      }
      try {
        const result = await this.makeRequest<BulkUnfollowResult>('POST', '/users/unfollow/bulk', { userIds }, { cache: false });
        this.invalidateFollowGraphCaches(userIds);
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Unfollow a user
     */
    async unfollowUser(userId: string): Promise<FollowMutationResult> {
      try {
        const result = await this.makeRequest<FollowMutationResult>('DELETE', `/users/${userId}/follow`, undefined, { cache: false });
        this.invalidateFollowGraphCaches([userId]);
        return result;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Get follow status
     */
    async getFollowStatus(userId: string): Promise<{ isFollowing: boolean }> {
      try {
        return await this.makeRequest('GET', `/users/${userId}/follow-status`, undefined, {
          cache: true,
          cacheTTL: 1 * 60 * 1000, // 1 minute cache
        });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Resolve the viewer's follow status for MANY users in one round-trip per
     * chunk. Built for list UIs (a page of `FollowButton`s) that would otherwise
     * fire one `getFollowStatus` per button (the classic N+1).
     *
     * Ids are deduplicated and validated (empty/blank ids dropped), split into
     * chunks of {@link FOLLOW_STATUS_CHUNK_SIZE} (the server's bulk cap), and
     * POSTed to `/users/follow-status/bulk` as `{ userIds }`. The per-chunk
     * `{ statuses }` maps are merged into one `Record<string, boolean>` covering
     * every requested id — ids the viewer does not follow come back `false`.
     *
     * Uncached (`{ cache: false }`): the UI store owns follow-status freshness
     * and writes optimistically on every mutation, so an SDK cache here would
     * serve a stale status right after a follow/unfollow. An empty/whitespace-
     * only input resolves immediately with `{}` and performs no network call.
     */
    async getFollowStatuses(userIds: string[]): Promise<Record<string, boolean>> {
      const uniqueIds = Array.from(
        new Set(userIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)),
      );
      if (uniqueIds.length === 0) {
        return {};
      }

      const chunks: string[][] = [];
      for (let i = 0; i < uniqueIds.length; i += FOLLOW_STATUS_CHUNK_SIZE) {
        chunks.push(uniqueIds.slice(i, i + FOLLOW_STATUS_CHUNK_SIZE));
      }

      try {
        const responses = await Promise.all(
          chunks.map((chunk) =>
            this.makeRequest<{ statuses: Record<string, boolean> }>(
              'POST',
              '/users/follow-status/bulk',
              { userIds: chunk },
              { cache: false },
            ),
          ),
        );

        const merged: Record<string, boolean> = {};
        for (const response of responses) {
          Object.assign(merged, response?.statuses ?? {});
        }
        return merged;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Get user followers.
     *
     * `sort` orders the underlying follow edges — `recent` (newest first, the
     * server default) or `oldest`. Because the response is cached and the cache
     * key is content-addressed on the query params, each `limit`/`offset`/`sort`
     * combination is its own entry.
     */
    async getUserFollowers(
      userId: string,
      pagination?: FollowGraphParams
    ): Promise<{ followers: User[]; total: number; hasMore: boolean }> {
      try {
        const params = buildQueryParams(pagination || {});
        const response = await this.makeRequest<{ data: User[]; pagination: { total: number; hasMore: boolean } }>('GET', `/users/${userId}/followers`, params, {
          cache: true,
          cacheTTL: 2 * 60 * 1000, // 2 minutes cache
        });
        return {
          followers: response.data || [],
          total: response.pagination.total,
          hasMore: response.pagination.hasMore,
        };
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Get user following. `sort` behaves as in {@link getUserFollowers}.
     */
    async getUserFollowing(
      userId: string,
      pagination?: FollowGraphParams
    ): Promise<{ following: User[]; total: number; hasMore: boolean }> {
      try {
        const params = buildQueryParams(pagination || {});
        const response = await this.makeRequest<{ data: User[]; pagination: { total: number; hasMore: boolean } }>('GET', `/users/${userId}/following`, params, {
          cache: true,
          cacheTTL: 2 * 60 * 1000, // 2 minutes cache
        });
        return {
          following: response.data || [],
          total: response.pagination.total,
          hasMore: response.pagination.hasMore,
        };
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Get user mutuals ("followers you know" — users the authenticated viewer
     * follows who also follow `userId`). The viewer is derived server-side from auth.
     */
    async getUserMutuals(
      userId: string,
      pagination?: FollowGraphParams
    ): Promise<{ mutuals: User[]; total: number; hasMore: boolean }> {
      try {
        const params = buildQueryParams(pagination || {});
        const response = await this.makeRequest<{ data: User[]; pagination: { total: number; hasMore: boolean } }>('GET', `/users/${userId}/mutuals`, params, {
          cache: true,
          cacheTTL: 2 * 60 * 1000, // 2 minutes cache
        });
        return {
          mutuals: response.data || [],
          total: response.pagination.total,
          hasMore: response.pagination.hasMore,
        };
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Get the authenticated VIEWER's OWN mutual-follow user ids — the accounts the
     * viewer follows that ALSO follow the viewer back (a bidirectional follow
     * edge). The viewer is derived server-side from the SDK's auth token (never a
     * param), so there is no target id to pass.
     *
     * Returns a bounded, lean list of ids meant to SEED a "Mutuals" feed (the
     * consumer hydrates/ranks the posts itself) — distinct from
     * {@link getUserMutuals}, which returns hydrated "followers you know" DTOs
     * about ANOTHER profile. An anonymous caller resolves to an empty array.
     */
    async getMutualUserIds(
      params?: { limit?: number }
    ): Promise<string[]> {
      try {
        const query = buildPaginationParams(params || {});
        const response = await this.makeRequest<{ data: string[] }>('GET', '/users/mutual-ids', query, {
          cache: true,
          cacheTTL: 2 * 60 * 1000, // 2 minutes cache
        });
        return response.data || [];
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Get the authenticated VIEWER's bounded "follows-of-follows" user ids — the
     * union of the accounts followed by the accounts the viewer follows (a
     * two-hop walk of the follow graph), MINUS the viewer's own follows and the
     * viewer themselves. The viewer is derived server-side from the SDK's auth
     * token (never a param), so there is no target id to pass.
     *
     * Returns a bounded, lean list of ids meant to SEED a friends-of-friends
     * feed (the consumer hydrates/ranks the posts itself), ordered by frequency
     * (accounts followed by more of the viewer's follows first), then recency.
     * An anonymous caller resolves to an empty array. Mirrors
     * {@link getMutualUserIds}'s caching posture.
     */
    async getFollowsOfFollowsIds(
      params?: { limit?: number }
    ): Promise<string[]> {
      try {
        const query = buildPaginationParams(params || {});
        const response = await this.makeRequest<{ data: string[] }>('GET', '/users/follows-of-follows-ids', query, {
          cache: true,
          cacheTTL: 2 * 60 * 1000, // 2 minutes cache
        });
        return response.data || [];
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Get the authenticated VIEWER's OWN social graph — the accounts they follow,
     * the subset who follow back (mutuals), and the accounts they have blocked —
     * as ONE ids-only payload. The viewer is derived server-side from the SDK's
     * auth token (never a param).
     *
     * Consolidates what were three separate round trips (`getUserFollowing` /
     * `getMutualUserIds` / `getBlockedUsers`) into a single request so a consumer
     * can prime its whole viewer graph at once. Mirrors {@link getMutualUserIds}'s
     * caching posture (2-minute identity-scoped cache); the follow/unfollow/block/
     * unblock write methods bust this entry so a local mutation is reflected
     * immediately. An anonymous caller resolves to empty lists.
     */
    async getViewerGraph(): Promise<ViewerGraph> {
      try {
        const response = await this.makeRequest<{ data: ViewerGraph }>('GET', '/users/me/graph', undefined, {
          cache: true,
          cacheTTL: 2 * 60 * 1000, // 2 minutes cache
        });
        const graph = response.data;
        return {
          followingIds: graph?.followingIds || [],
          mutualIds: graph?.mutualIds || [],
          blockedIds: graph?.blockedIds || [],
          restrictedIds: graph?.restrictedIds || [],
        };
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Get notifications
     */
    async getNotifications(): Promise<Notification[]> {
      return this.withAuthRetry(async () => {
        return await this.makeRequest<Notification[]>('GET', '/notifications', undefined, {
          cache: false, // Don't cache notifications - always get fresh data
        });
      }, 'getNotifications');
    }

    /**
     * Get unread notification count
     */
    async getUnreadCount(): Promise<number> {
      try {
        const res = await this.makeRequest<{ count: number }>('GET', '/notifications/unread-count', undefined, {
          cache: false, // Don't cache unread count - always get fresh data
        });
        return res.count;
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Create notification
     */
    async createNotification(data: Partial<Notification>): Promise<Notification> {
      try {
        return await this.makeRequest<Notification>('POST', '/notifications', data, { cache: false });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Mark notification as read
     */
    async markNotificationAsRead(notificationId: string): Promise<void> {
      try {
        await this.makeRequest('PUT', `/notifications/${notificationId}/read`, undefined, { cache: false });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Mark all notifications as read
     */
    async markAllNotificationsAsRead(): Promise<void> {
      try {
        await this.makeRequest('PUT', '/notifications/read-all', undefined, { cache: false });
      } catch (error) {
        throw this.handleError(error);
      }
    }

    /**
     * Delete notification
     */
    async deleteNotification(notificationId: string): Promise<void> {
      try {
        await this.makeRequest('DELETE', `/notifications/${notificationId}`, undefined, { cache: false });
      } catch (error) {
        throw this.handleError(error);
      }
    }
  };
}
