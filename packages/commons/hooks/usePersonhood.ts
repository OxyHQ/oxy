/**
 * React Query wrappers around a user's proof-of-personhood status (Fase 3).
 *
 * `oxyServices.getPersonhood(userId)` returns the public, recomputable
 * personhood snapshot (`{ score, isRealPerson, vouchCount, realLifeCount,
 * biometricBound, sybilPenalty, breakdown }`); `getMyPersonhood()` is the same
 * read for the authenticated user. Both are wrapped here so the personhood
 * status screen and the scanned-card badge get the same offline-first behaviour
 * as `useCivicCard` / `useCivicReputation`: a previously-resolved snapshot is
 * served from the in-memory cache immediately and survives going offline. The
 * query key is namespaced under `civic` so it never collides with the SDK's
 * account/session caches, and shares the per-subject key with the vouch flow's
 * invalidation in `useVouch`.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import type { PersonhoodStatusResult } from '@oxy.so/contracts';

/** Build the shared per-subject personhood query key (also used by `useVouch`). */
export function personhoodQueryKey(userId: string | null): (string | null)[] {
  return ['civic', 'personhood', userId];
}

/** Keep a resolved snapshot for a day so the offline view has something to show
 *  after the 5-minute freshness window lapses. */
const PERSONHOOD_STALE_TIME_MS = 5 * 60 * 1000;
const PERSONHOOD_GC_TIME_MS = 24 * 60 * 60 * 1000;

/**
 * Query a subject's public personhood status (e.g. the scanned-card badge).
 *
 * @param userId - The subject account's id, or `null` (query disabled) when the
 *   DID could not be resolved.
 */
export function usePersonhood(
  userId: string | null,
): UseQueryResult<PersonhoodStatusResult> {
  const { oxyServices } = useOxy();

  return useQuery<PersonhoodStatusResult>({
    queryKey: personhoodQueryKey(userId),
    queryFn: () => {
      if (!oxyServices) {
        throw new Error('OxyServices not initialized');
      }
      if (!userId) {
        throw new Error('No user id to resolve personhood for');
      }
      return oxyServices.getPersonhood(userId);
    },
    enabled: Boolean(oxyServices) && Boolean(userId),
    staleTime: PERSONHOOD_STALE_TIME_MS,
    gcTime: PERSONHOOD_GC_TIME_MS,
  });
}

/**
 * Query the CURRENT user's personhood status (the "Proof of personhood" screen).
 *
 * Resolves through the dedicated `getMyPersonhood()` SDK method (which derives
 * the subject id from the session) and keys the result by the current user id so
 * it shares the cache with `usePersonhood(myId)`.
 */
export function useMyPersonhood(): UseQueryResult<PersonhoodStatusResult> {
  const { user, oxyServices } = useOxy();
  const userId = user?.id ?? oxyServices?.getCurrentUserId() ?? null;

  return useQuery<PersonhoodStatusResult>({
    queryKey: personhoodQueryKey(userId),
    queryFn: () => {
      if (!oxyServices) {
        throw new Error('OxyServices not initialized');
      }
      return oxyServices.getMyPersonhood();
    },
    enabled: Boolean(oxyServices) && Boolean(userId),
    staleTime: PERSONHOOD_STALE_TIME_MS,
    gcTime: PERSONHOOD_GC_TIME_MS,
  });
}
