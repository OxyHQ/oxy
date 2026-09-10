import { useEffect } from 'react';
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import { authenticatedApiCall } from '@oxy.so/core';
import type { ConnectedApp, User } from '@oxy.so/core';
import { queryKeys } from './queryKeys';
import { mutationKeys } from '../mutations/mutationKeys';
import { useOxy } from '../../context/OxyContext';
import { useAuthStore } from '../../stores/authStore';

/**
 * Get user profile by session ID
 */
export const useUserProfile = (sessionId: string | null, options?: { enabled?: boolean }) => {
  const { oxyServices } = useOxy();

  return useQuery({
    queryKey: queryKeys.users.profile(sessionId || ''),
    queryFn: async () => {
      if (!sessionId) {
        throw new Error('Session ID is required');
      }
      return await oxyServices.getUserBySession(sessionId);
    },
    enabled: (options?.enabled !== false) && !!sessionId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 30 * 60 * 1000, // 30 minutes
  });
};

/**
 * Get multiple user profiles by session IDs (batch query)
 */
export const useUserProfiles = (sessionIds: string[], options?: { enabled?: boolean }) => {
  const { oxyServices } = useOxy();

  return useQueries({
    queries: sessionIds.map((sessionId) => ({
      queryKey: queryKeys.users.profile(sessionId),
      queryFn: async () => {
        const results = await oxyServices.getUsersBySessions([sessionId]);
        return results[0]?.user || null;
      },
      enabled: (options?.enabled !== false) && !!sessionId,
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
    })),
  });
};

/**
 * Get current authenticated user.
 *
 * Hydrates from `GET /users/me` (the bearer identifies the session) rather than
 * `GET /session/user/:activeSessionId`. Post zero-cookie cutover the bearer is
 * the single source of session truth, so keying the CURRENT user off a session
 * id in the URL was a second, independently-updated source that could disagree
 * with the bearer during an account switch — the request fired under the
 * previous account's token against the new account's session id and 404'd. The
 * query KEY stays scoped to the active account so the cache re-scopes (and
 * refetches) on a switch; only the URL stopped carrying a session id.
 *
 * The store-mirror effect must NOT overwrite the in-memory user while a
 * write mutation is in flight — otherwise a stale background refetch
 * landing between optimistic update and server-confirmed update would
 * revert the optimistic value and flicker the UI.
 *
 * We gate the mirror on the mutation-cache state for any mutation that
 * touches `User` shape (profile, avatar, settings, privacy). When any of
 * those is in flight we skip the mirror entirely; the winning onSuccess
 * handler is responsible for writing the final value to the store.
 */
export const useCurrentUser = (options?: { enabled?: boolean }) => {
  const { oxyServices, activeSessionId, isAuthenticated } = useOxy();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: queryKeys.accounts.current(activeSessionId),
    queryFn: async () => {
      return await oxyServices.getCurrentUser();
    },
    enabled: (options?.enabled !== false) && isAuthenticated && !!activeSessionId,
    staleTime: 1 * 60 * 1000, // 1 minute for current user
    gcTime: 30 * 60 * 1000,
  });

  // Mirror fresh server-side user into the auth store so consumers reading
  // useOxy().user pick up newly-arriving fields (createdAt, updatedAt, etc.).
  //
  // Guard 1 (mutation in flight): skip if ANY user-shape mutation is in
  // flight — the in-progress optimistic value must not be reverted by a
  // background refetch.
  // Guard 2 (staleness): if the existing store user has a strictly newer
  // `updatedAt` than the incoming data, skip. Protects against late-
  // arriving refetches that race with an already-completed mutation.
  const data = query.data;
  useEffect(() => {
    if (!data) return;

    // Check for any write mutation that mutates the user shape. Match by
    // any prefix of the user-write mutation keys we own — `isMutating`
    // matches mutations whose `mutationKey` starts with the provided key.
    const userWriteMutationsInFlight =
      queryClient.isMutating({ mutationKey: mutationKeys.account.updateProfile }) +
      queryClient.isMutating({ mutationKey: mutationKeys.account.uploadAvatar }) +
      queryClient.isMutating({ mutationKey: mutationKeys.account.updateSettings }) +
      queryClient.isMutating({ mutationKey: mutationKeys.account.updatePrivacySettings });

    if (userWriteMutationsInFlight > 0) {
      return;
    }

    // updatedAt-based staleness gate. Tolerates missing fields on either
    // side: when the server response or stored user omits `updatedAt`
    // (partial updates, legacy users), fall through to the mirror — the
    // mutation-in-flight guard above is the primary defense.
    const storedUser = useAuthStore.getState().user;
    const incomingUpdatedAt = parseUpdatedAt(data.updatedAt);
    const storedUpdatedAt = parseUpdatedAt(storedUser?.updatedAt);
    if (
      incomingUpdatedAt !== null &&
      storedUpdatedAt !== null &&
      incomingUpdatedAt < storedUpdatedAt
    ) {
      return;
    }

    useAuthStore.getState().setUser(data);
  }, [data, queryClient]);

  return query;
};

/**
 * Best-effort parser for the various `updatedAt` representations the API
 * returns (ISO string, epoch number, Date instance, undefined). Returns
 * `null` when the value can't be interpreted as a finite timestamp — the
 * caller then falls back to the mutation-in-flight guard.
 */
function parseUpdatedAt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'string') {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/**
 * Get user by ID (identity-by-id).
 *
 * Keyed on the viewer-INDEPENDENT `queryKeys.users.detail(id)`: this hook is
 * the card-identity workhorse (name, avatar, username, verified) and does NOT
 * read the viewer-relative `relationship` field. Keeping the key
 * viewer-independent lets external by-id identity seeders / precache layers
 * (e.g. Mention's card enrichment) that all write `queryKeys.users.detail(id)`
 * share a single cache entry — a viewer-scoped key would dead-end every seed
 * and cause avatar/name flashes plus N+1 fetches.
 *
 * A viewer-scoped, relationship-aware by-id PROFILE fetch is intentionally NOT
 * this hook — it would be a separate future `useUserProfileById` keyed on
 * `queryKeys.users.detailForViewer(id, viewerId)`. No current consumer reads
 * `relationship` from a by-id fetch (only the username path does).
 */
export const useUserById = (userId: string | null, options?: { enabled?: boolean }) => {
  const { oxyServices } = useOxy();

  return useQuery({
    queryKey: queryKeys.users.detail(userId || ''),
    queryFn: async () => {
      if (!userId) {
        throw new Error('User ID is required');
      }
      return await oxyServices.getUserById(userId);
    },
    enabled: (options?.enabled !== false) && !!userId,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
};

/**
 * Get user profile by username
 */
export const useUserByUsername = (username: string | null, options?: { enabled?: boolean }) => {
  const { oxyServices, user } = useOxy();
  // Viewer-scope the cache. Authenticated single-profile fetches embed a
  // viewer-relative `relationship` ({ isFollowing, followsYou }); anonymous
  // fetches omit it and different viewers get different values. Without the
  // active viewer in the key, react-query freezes the first (often anonymous
  // cold-boot) copy and never refetches when the session lands ~5-25s later,
  // so the "Follows you" tag flashes then vanishes forever. Adding the viewer
  // makes anon vs authed distinct entries AND forces a refetch when the
  // session resolves or the account switches. (The SDK's GET response cache is
  // already identity-scoped by the access-token user id via `computeIdentityTag`,
  // so it never cross-poisons `relationship` — the only gap was this key.)
  const viewerId = user?.id ?? '';

  return useQuery({
    queryKey: queryKeys.users.byUsername(username || '', viewerId),
    queryFn: async () => {
      if (!username) {
        throw new Error('Username is required');
      }
      // Match queryKeys.users.byUsername normalization so the cache key and
      // the API request agree (case-insensitive local handles).
      const normalizedUsername = username.trim().toLowerCase();
      return await oxyServices.getProfileByUsername(normalizedUsername);
    },
    enabled: (options?.enabled !== false) && !!username,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    // Enforce the `upsertCachedUser` stale-seed contract from THIS hook rather
    // than relying on the consuming app's global `refetchOnMount` default.
    // When a feed/post author is precached into the by-username key it is seeded
    // SPARSE (no `createdAt`/`relationship`/`_count`) and marked STALE
    // (`updatedAt: 0`) precisely so this hook refetches the full authoritative
    // profile on mount. A consumer whose QueryClient sets
    // `defaultOptions.queries.refetchOnMount: false` (a common perf setting —
    // Mention does this) would otherwise serve the stale sparse seed forever and
    // the authoritative fetch (which carries `createdAt`) would never run — the
    // "Joined <date> missing depending on where you came from" bug. `true` (NOT
    // `'always'`) with the 5m `staleTime` keeps it efficient: a genuinely fresh
    // real fetch is NOT refetched, only a stale seed / >5m-old entry is.
    // `useUserByUsername` is consumed ONLY for single-profile views (never an
    // N-instance list), so this is exactly one fetch. `useUserById` — the card
    // workhorse in N-instance lists — deliberately does NOT do this.
    refetchOnMount: true,
  });
};

/**
 * Batch get users by session IDs (optimized single API call)
 */
export const useUsersBySessions = (sessionIds: string[], options?: { enabled?: boolean }) => {
  const { oxyServices } = useOxy();

  return useQuery({
    queryKey: queryKeys.accounts.list(sessionIds),
    queryFn: async () => {
      if (sessionIds.length === 0) {
        return [];
      }
      return await oxyServices.getUsersBySessions(sessionIds);
    },
    enabled: (options?.enabled !== false) && sessionIds.length > 0,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
};

/**
 * List the third-party OAuth applications the current user has connected via
 * the consent flow (`GET /auth/grants`). Drives the "Connected apps" management
 * screen.
 */
export const useConnectedApps = (options?: { enabled?: boolean }) => {
  const { oxyServices, activeSessionId, isAuthenticated } = useOxy();

  return useQuery<ConnectedApp[]>({
    queryKey: queryKeys.connectedApps.list(),
    queryFn: async () => {
      return authenticatedApiCall<ConnectedApp[]>(
        oxyServices,
        activeSessionId,
        () => oxyServices.listConnectedApps()
      );
    },
    enabled: (options?.enabled !== false) && isAuthenticated,
    staleTime: 30 * 1000, // 30 seconds — short, drives a management UI
    gcTime: 5 * 60 * 1000,
  });
};

/**
 * Get privacy settings for a user
 */
export const usePrivacySettings = (userId?: string, options?: { enabled?: boolean }) => {
  const { oxyServices, activeSessionId, user } = useOxy();
  // When no explicit user id is supplied, target the ACTIVE account (the
  // account switched into) so "my privacy settings" reflects the current
  // account, matching the imperative PrivacySettingsScreen.
  const targetUserId = userId || user?.id;

  return useQuery({
    queryKey: queryKeys.privacy.settings(targetUserId),
    queryFn: async () => {
      if (!targetUserId) {
        throw new Error('User ID is required');
      }

      return authenticatedApiCall(
        oxyServices,
        activeSessionId,
        () => oxyServices.getPrivacySettings(targetUserId)
      );
    },
    enabled: (options?.enabled !== false) && !!targetUserId,
    staleTime: 2 * 60 * 1000, // 2 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
};

