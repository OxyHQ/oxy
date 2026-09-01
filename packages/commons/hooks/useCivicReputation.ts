/**
 * React Query wrapper around the SIGNED-IN user's reputation balance, plus the
 * derived "by source" view the civic reputation screen renders.
 *
 * `oxyServices.getMyReputationBalance()` returns the canonical balance (total,
 * per-category breakdown, trust tier, influence, reliability). It is the
 * subject-view read, and deliberately so: the API serves `breakdown` /
 * `influence` / `reliability` ONLY to the balance's own subject and to platform
 * staff, and this screen renders all three. Asking for them by user id
 * (`getReputationBalance(id)`) would compile but come back without them for
 * anyone but yourself.
 *
 * The source split (Real life / Peer-civic / Apps / Penalties) is derived
 * client-side from `breakdown` via `deriveReputationSources` — the schema is not
 * changed. Offline-first by the same `civic`-namespaced React Query mechanism as
 * `useCivicCard`.
 */

import { useMemo } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import type { ReputationBalance } from '@oxyhq/contracts';
import {
  deriveReputationSources,
  type ReputationSource,
} from '@/lib/civic/reputation-sources';

const BALANCE_STALE_TIME_MS = 5 * 60 * 1000;
const BALANCE_GC_TIME_MS = 24 * 60 * 60 * 1000;

/**
 * Query the signed-in user's own reputation balance.
 *
 * @param userId - The signed-in account's id, or `null` (query disabled). Scopes
 *   the cache entry so a switched account does not read the previous one's
 *   snapshot; the READ itself always resolves whoever the SDK is authenticated
 *   as, so no id is passed to it.
 */
export function useCivicReputation(
  userId: string | null,
): UseQueryResult<ReputationBalance> {
  const { oxyServices } = useOxy();

  return useQuery<ReputationBalance>({
    queryKey: ['civic', 'reputation', userId],
    queryFn: () => {
      if (!oxyServices) {
        throw new Error('OxyServices not initialized');
      }
      return oxyServices.getMyReputationBalance();
    },
    enabled: Boolean(oxyServices) && Boolean(userId),
    staleTime: BALANCE_STALE_TIME_MS,
    gcTime: BALANCE_GC_TIME_MS,
  });
}

/**
 * The four ordered civic reputation sources derived from a balance, or `null`
 * until a balance has resolved. Memoized so the screen's list identity is
 * stable across re-renders.
 */
export function useReputationSources(
  balance: ReputationBalance | undefined,
): ReputationSource[] | null {
  return useMemo(
    () => (balance ? deriveReputationSources(balance.breakdown) : null),
    [balance],
  );
}
