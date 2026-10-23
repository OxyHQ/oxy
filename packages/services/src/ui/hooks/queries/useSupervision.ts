import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SUPERVISION_CHANGED_EVENT } from '@oxy.so/contracts/client';
import { useOxy } from '../../context/oxyRuntimeContext';
import { useOxyEvent } from '../useOxyEvent';

export const supervisionQueryKeys = {
  all: ['oxy', 'safety', 'supervision'] as const,
  account: (id: string, sessionId: string) =>
    ['oxy', 'safety', 'supervision', id, sessionId] as const,
};

/**
 * The signed-in personal account's supervision (parental-control) state.
 *
 * Policy: the SDK keeps the session's supervision state always current — it is
 * fetched when the session is established, refetched when the app returns to
 * the foreground, and refetched when the session socket signals
 * `supervision_changed` (`SupervisionStateObserver`, mounted by `OxyProvider`).
 * Screens read it from the cache without waiting for the network: no observer
 * forces its own refetch on mount. `data` is undefined only while the session's
 * first fetch is pending, when the query is disabled (signed out, or not a
 * personal account) and after a failed fetch.
 *
 * Advisory UI state only. The server keeps enforcing supervision on every
 * content request; never treat this value as authorization.
 */
export function useSupervision() {
  const { oxyServices, user, canUsePrivateApi, activeSessionId } = useOxy();
  const result = useQuery({
    queryKey: supervisionQueryKeys.account(user?.id ?? '', activeSessionId ?? ''),
    queryFn: () => oxyServices.safety.supervisionState(),
    enabled: canUsePrivateApi && !!activeSessionId && user?.kind === 'personal',
    // Fresh until the socket signal or a return to the foreground says otherwise.
    staleTime: Number.POSITIVE_INFINITY,
    // The observer below keeps the current session's entry alive; this only
    // bounds how long a previous session's entry outlives it.
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: 'always',
  });
  return {
    ...result,
    data: result.isError ? undefined : result.data,
  };
}

/**
 * Keeps the session's supervision state current for every `useSupervision()`
 * reader: its observer fetches once the session is established and on each
 * return to the foreground, and the `supervision_changed` socket signal
 * refetches it. Rendered once by `OxyProvider`.
 */
export function SupervisionStateObserver() {
  const queryClient = useQueryClient();
  useSupervision();
  useOxyEvent(SUPERVISION_CHANGED_EVENT, () => {
    void queryClient.invalidateQueries({ queryKey: supervisionQueryKeys.all });
  });
  return null;
}
