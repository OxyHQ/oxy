import { useQuery } from '@tanstack/react-query';
import { useOxy } from '../../context/oxyRuntimeContext';
export const supervisionQueryKeys = {
  all: ['oxy', 'safety', 'supervision'] as const,
  account: (id: string, sessionId: string) =>
    ['oxy', 'safety', 'supervision', id, sessionId] as const,
};
/** Advisory UI state only. Every read/write still requires the live server policy. */
export function useSupervision() {
  const { oxyServices, user, isAuthenticated, activeSessionId } = useOxy();
  const result = useQuery({
    queryKey: supervisionQueryKeys.account(user?.id ?? '', activeSessionId ?? ''),
    queryFn: () => oxyServices.safety.supervisionState(),
    enabled: isAuthenticated && !!activeSessionId && user?.kind === 'personal',
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: 'always',
    refetchOnMount: 'always',
    retry: false,
  });
  return {
    ...result,
    data: result.isFetchedAfterMount && !result.isError ? result.data : undefined,
  };
}
