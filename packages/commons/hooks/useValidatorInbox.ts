import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import type { ValidationRequestSummary } from '@oxy.so/contracts';

/** React Query key for the juror inbox (shared by the entry badge, list + vote screen). */
export const VALIDATOR_INBOX_KEY = ['civic', 'validator-inbox'] as const;

/**
 * The current user's pending jury duties (`getValidatorInbox`). The inbox is a
 * LIVE queue (the SDK never caches it), so this query keeps a short staleTime and
 * the vote screen invalidates it after a vote/recusal. The reputation entry, the
 * inbox list, and the vote screen all read from this one cached query so a single
 * fetch backs the badge count, the list, and the per-request lookup.
 */
export function useValidatorInbox(): UseQueryResult<ValidationRequestSummary[]> {
  const { oxyServices, user } = useOxy();
  const userId = user?.id ?? oxyServices?.getCurrentUserId?.() ?? null;

  return useQuery<ValidationRequestSummary[]>({
    queryKey: VALIDATOR_INBOX_KEY,
    queryFn: () => {
      if (!oxyServices) {
        throw new Error('OxyServices not initialized');
      }
      return oxyServices.getValidatorInbox();
    },
    enabled: Boolean(oxyServices) && Boolean(userId),
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
  });
}
