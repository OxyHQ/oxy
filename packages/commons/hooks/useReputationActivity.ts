/**
 * React Query wrapper around a user's recent reputation ledger entries.
 *
 * `oxyServices.getReputationTransactions(userId, limit)` returns the user's
 * append-only ledger, newest first. The reputation screen shows the most recent
 * handful as a human "recent activity" feed. Offline-first via the same
 * `civic`-namespaced React Query mechanism as `useCivicReputation` — a cached
 * list renders instantly while a background refetch runs.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import type { ReputationTransaction } from '@oxyhq/contracts';

/** How many recent ledger entries the reputation screen surfaces. */
export const RECENT_ACTIVITY_LIMIT = 8;

const ACTIVITY_STALE_TIME_MS = 60 * 1000;
const ACTIVITY_GC_TIME_MS = 24 * 60 * 60 * 1000;

/**
 * Query a user's most recent reputation transactions (newest first).
 *
 * @param userId - The subject account's id, or `null` (query disabled).
 */
export function useReputationActivity(
  userId: string | null,
): UseQueryResult<ReputationTransaction[]> {
  const { oxyServices } = useOxy();

  return useQuery<ReputationTransaction[]>({
    queryKey: ['civic', 'reputation-activity', userId],
    queryFn: () => {
      if (!oxyServices) {
        throw new Error('OxyServices not initialized');
      }
      if (!userId) {
        throw new Error('No user id to resolve activity for');
      }
      return oxyServices.getReputationTransactions(userId, RECENT_ACTIVITY_LIMIT);
    },
    enabled: Boolean(oxyServices) && Boolean(userId),
    staleTime: ACTIVITY_STALE_TIME_MS,
    gcTime: ACTIVITY_GC_TIME_MS,
  });
}
