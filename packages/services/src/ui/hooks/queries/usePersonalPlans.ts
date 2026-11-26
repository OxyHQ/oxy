import { skip } from '@oxy.so/bloom-data';
import { useOxy } from '../../context/oxyRuntimeContext';
import { useAnswer } from '../../data/answer';
import { personalPlanSubscriptions, personalPlans } from '../../data/payments';

/** Public discovery; deliberately outside the account's private billing reads. */
export function usePersonalPlans() {
  const { oxyServices } = useOxy();
  return useAnswer(personalPlans, oxyServices);
}

/** Account and session partitioning plus a server-side expected-subject fence. */
export function usePersonalPlanSubscriptions() {
  const { oxyServices, user, isAuthenticated, activeSessionId } = useOxy();
  const accountId = user?.id;
  return useAnswer(
    personalPlanSubscriptions,
    ...(isAuthenticated && accountId
      ? ([oxyServices, accountId, activeSessionId ?? null] as const)
      : [skip]),
  );
}
