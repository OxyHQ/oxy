/**
 * React Query wrappers around a holder's verifiable credentials (Fase 4).
 *
 * `oxyServices.listCredentials(holderUserId, opts?)` returns the credentials a
 * holder has collected (issuer-signed attestations they SHOW); `listMyCredentials()`
 * is the same read for the authenticated user. Both are wrapped here so the
 * credentials screen gets the same offline-first behaviour as `useCivicCard` /
 * `usePersonhood`: a previously-resolved list is served from the in-memory cache
 * immediately and survives going offline. The query key is namespaced under
 * `civic` so it never collides with the SDK's account/session caches, and shares
 * the per-holder key with the issue / revoke invalidation in
 * `useIssueCredential` / `useRevokeCredential`.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import type { CredentialListResult, CredentialStatus } from '@oxy.so/contracts';

/** Build the shared per-holder credentials query key (also used by the mutations). */
export function credentialsQueryKey(
  holderUserId: string | null,
  status?: CredentialStatus,
): (string | null | undefined)[] {
  return ['civic', 'credentials', holderUserId, status ?? 'all'];
}

/** Keep a resolved list for a day so the offline view has something to show after
 *  the 5-minute freshness window lapses. */
const CREDENTIALS_STALE_TIME_MS = 5 * 60 * 1000;
const CREDENTIALS_GC_TIME_MS = 24 * 60 * 60 * 1000;

/**
 * Query a holder's verifiable credentials.
 *
 * @param holderUserId - The holder account's id, or `null` (query disabled) when
 *   the id is not yet known / could not be resolved.
 * @param opts.status - Optional `'active' | 'revoked' | 'expired'` filter.
 */
export function useCredentials(
  holderUserId: string | null,
  opts: { status?: CredentialStatus } = {},
): UseQueryResult<CredentialListResult> {
  const { oxyServices } = useOxy();

  return useQuery<CredentialListResult>({
    queryKey: credentialsQueryKey(holderUserId, opts.status),
    queryFn: () => {
      if (!oxyServices) {
        throw new Error('OxyServices not initialized');
      }
      if (!holderUserId) {
        throw new Error('No holder id to resolve credentials for');
      }
      return oxyServices.listCredentials(holderUserId, opts);
    },
    enabled: Boolean(oxyServices) && Boolean(holderUserId),
    staleTime: CREDENTIALS_STALE_TIME_MS,
    gcTime: CREDENTIALS_GC_TIME_MS,
  });
}

/**
 * Query the CURRENT user's verifiable credentials (the "My credentials" screen).
 *
 * Resolves through the dedicated `listMyCredentials()` SDK method (which derives
 * the holder id from the session) and keys the result by the current user id so
 * it shares the cache with `useCredentials(myId)` — and therefore with the
 * invalidation a revoke performs.
 */
export function useMyCredentials(
  opts: { status?: CredentialStatus } = {},
): UseQueryResult<CredentialListResult> {
  const { user, oxyServices } = useOxy();
  const userId = user?.id ?? oxyServices?.getCurrentUserId() ?? null;

  return useQuery<CredentialListResult>({
    queryKey: credentialsQueryKey(userId, opts.status),
    queryFn: () => {
      if (!oxyServices) {
        throw new Error('OxyServices not initialized');
      }
      return oxyServices.listMyCredentials(opts);
    },
    enabled: Boolean(oxyServices) && Boolean(userId),
    staleTime: CREDENTIALS_STALE_TIME_MS,
    gcTime: CREDENTIALS_GC_TIME_MS,
  });
}
