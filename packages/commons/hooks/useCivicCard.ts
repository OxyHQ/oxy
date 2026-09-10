/**
 * React Query wrapper around a user's signed public Oxy ID card.
 *
 * `oxyServices.getPublicCard(userId)` fetches the card AND verifies the Oxy
 * custodial attestation client-side, returning `{ card, attestation, verified }`
 * — a bad/absent signature yields `verified: false` (untrusted) rather than
 * throwing, so the card view can always render a trust indicator.
 *
 * Wrapping it in React Query gives the scanned-card view its offline-first
 * behaviour: a previously-resolved card is served from cache immediately
 * (`networkMode: 'offlineFirst'`) and kept around long enough to survive going
 * offline. The query key is namespaced under `civic` so it never collides with
 * the SDK's account/session caches.
 *
 * NOTE: cross-app-restart persistence of `civic` keys would require adding the
 * `civic` prefix to the `@oxy.so/services` persist whitelist
 * (`PERSISTED_QUERY_PREFIXES` in `packages/services/src/ui/hooks/queryClient.ts`)
 * — an upstream change. Within a session the in-memory cache already serves the
 * last-known card while offline.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import type { CivicCardResult } from '@oxy.so/core';

/** Keep a resolved card available for a day so the offline view has something
 *  to render after the 5-minute freshness window lapses. */
const CARD_GC_TIME_MS = 24 * 60 * 60 * 1000;
const CARD_STALE_TIME_MS = 5 * 60 * 1000;

/**
 * Query the signed public card (with client-side verdict) for a user.
 *
 * @param userId - The subject account's id, or `null` (query disabled) when the
 *   DID could not be resolved.
 */
export function useCivicCard(userId: string | null): UseQueryResult<CivicCardResult> {
  const { oxyServices } = useOxy();

  return useQuery<CivicCardResult>({
    queryKey: ['civic', 'card', userId],
    queryFn: () => {
      if (!oxyServices) {
        throw new Error('OxyServices not initialized');
      }
      if (!userId) {
        throw new Error('No user id to resolve a card for');
      }
      return oxyServices.getPublicCard(userId);
    },
    enabled: Boolean(oxyServices) && Boolean(userId),
    staleTime: CARD_STALE_TIME_MS,
    gcTime: CARD_GC_TIME_MS,
  });
}
