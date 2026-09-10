import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import type { ConnectedApp } from '@oxy.so/core';

/**
 * React Query key for the current user's connected (OAuth-authorized) apps.
 * Scoped by user id so switching the active session never surfaces another
 * account's grants from cache.
 */
export function connectedAppsQueryKey(userId: string | null | undefined) {
  return ['connected-apps', userId ?? null] as const;
}

/**
 * Reads the third-party applications the current user has authorized via the
 * OAuth consent flow (`oxyServices.listConnectedApps()` → `GET /auth/grants`).
 *
 * The API returns only revocable third-party grants — trusted/official Oxy apps
 * are never listed — so no client-side special-casing is needed. The query is
 * gated on an authenticated session with a resolved user id.
 */
export function useConnectedApps() {
  const { oxyServices, user, isAuthenticated } = useOxy();

  return useQuery<ConnectedApp[]>({
    queryKey: connectedAppsQueryKey(user?.id),
    queryFn: () => oxyServices.listConnectedApps(),
    enabled: isAuthenticated && Boolean(user?.id),
    staleTime: 60 * 1000,
  });
}

/** Snapshot captured by the optimistic revoke so it can roll back on error. */
interface RevokeContext {
  previous?: ConnectedApp[];
}

/**
 * Revokes the current user's grant for a connected application, identified by
 * its `applicationId`.
 *
 * Optimistically removes the row, rolls the list back if the request fails, and
 * invalidates the connected-apps query on success so it reconciles with the
 * server (the SDK also busts its own `GET:/auth/grants` cache on revoke).
 */
export function useRevokeAppGrant() {
  const { oxyServices, user } = useOxy();
  const queryClient = useQueryClient();
  const queryKey = connectedAppsQueryKey(user?.id);

  return useMutation<void, Error, string, RevokeContext>({
    mutationKey: ['connected-apps', 'revoke', user?.id ?? null],
    mutationFn: (applicationId: string) => oxyServices.revokeAppGrant(applicationId),
    onMutate: async (applicationId: string): Promise<RevokeContext> => {
      // Cancel in-flight reads so they don't overwrite the optimistic update.
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ConnectedApp[]>(queryKey);
      if (previous) {
        queryClient.setQueryData<ConnectedApp[]>(
          queryKey,
          previous.filter((app) => app.applicationId !== applicationId),
        );
      }
      return { previous };
    },
    onError: (_error, _applicationId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });
}
