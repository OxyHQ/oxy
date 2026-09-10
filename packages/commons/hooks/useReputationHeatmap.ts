/**
 * React Query wrapper that shapes a user's reputation ledger into a day-bucketed
 * activity grid for the {@link ActivityHeatmap}.
 *
 * `oxyServices.getReputationTransactions(userId, limit)` returns the user's
 * append-only ledger, newest first. Where `useReputationActivity` surfaces only
 * the most recent handful for the human feed, the heatmap needs a WIDE window —
 * a full year of entries — so it can render one cell per day. We fetch that
 * window, keep only `active` transactions (voided/reversed ones don't represent
 * real activity), then `bucketByDay` collapses them into `{ date, count }[]`.
 * Offline-first via the same `civic`-namespaced React Query mechanism as
 * `useReputationActivity` — a cached grid renders instantly while a background
 * refetch runs.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import { bucketByDay, type ActivityHeatmapDay } from '@oxy.so/bloom/activity-heatmap';

/** How many recent ledger entries the heatmap draws from — roughly a year. */
export const HEATMAP_ACTIVITY_LIMIT = 365;

const HEATMAP_STALE_TIME_MS = 60 * 1000;
const HEATMAP_GC_TIME_MS = 24 * 60 * 60 * 1000;

/**
 * Query a user's reputation ledger and bucket it by day for the heatmap.
 *
 * @param userId - The subject account's id, or `null` (query disabled).
 */
export function useReputationHeatmap(
  userId: string | null,
): UseQueryResult<ActivityHeatmapDay[]> {
  const { oxyServices } = useOxy();

  return useQuery<ActivityHeatmapDay[]>({
    queryKey: ['civic', 'reputation-heatmap', userId],
    queryFn: async () => {
      if (!oxyServices) {
        throw new Error('OxyServices not initialized');
      }
      if (!userId) {
        throw new Error('No user id to resolve activity for');
      }
      const transactions = await oxyServices.getReputationTransactions(
        userId,
        HEATMAP_ACTIVITY_LIMIT,
        0,
      );
      const active = transactions.filter((transaction) => transaction.status === 'active');
      return bucketByDay(active, (transaction) => transaction.createdAt);
    },
    enabled: Boolean(oxyServices) && Boolean(userId),
    staleTime: HEATMAP_STALE_TIME_MS,
    gcTime: HEATMAP_GC_TIME_MS,
  });
}
