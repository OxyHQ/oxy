import { useQuery } from '@tanstack/react-query';
import { authenticatedApiCall } from '@oxy.so/core';
import { useOxy } from '../../context/OxyContext';

/** Public discovery; deliberately outside persisted customer payment queries. */
export function usePersonalPlans() {
  const { oxyServices } = useOxy();
  return useQuery({
    queryKey: ['personal-plan-catalogue'],
    queryFn: () => oxyServices.billing.personalPlans(),
    staleTime: 0,
  });
}

/** Account and session partitioning plus a server-side expected-subject fence. */
export function usePersonalPlanSubscriptions() {
  const { oxyServices, user, isAuthenticated, activeSessionId } = useOxy();
  const accountId = user?.id;
  return useQuery({
    queryKey: ['personal-plan-sources', accountId, activeSessionId],
    queryFn: () => {
      if (!accountId) throw new Error('Authentication required');
      return authenticatedApiCall(oxyServices, activeSessionId, () =>
        oxyServices.billing.productSubscriptions(accountId),
      );
    },
    enabled: isAuthenticated && !!accountId,
    staleTime: 0,
    gcTime: 0,
  });
}
