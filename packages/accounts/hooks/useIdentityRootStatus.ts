import { useQuery } from '@tanstack/react-query';
import type { IdentityRootStatus } from '@oxy.so/contracts';
import { useOxy } from '@oxy.so/services';

/**
 * How the signed-in account is kept (ADR 0029 D3): Commons' root, or a passkey
 * and a recovery email. `undefined` while unknown: nothing is shown on a guess.
 */
export function useIdentityRootStatus(): IdentityRootStatus | undefined {
  const { oxyServices, isAuthenticated } = useOxy();
  const { data } = useQuery({
    queryKey: ['identity', 'root-status'],
    queryFn: () => oxyServices.getIdentityRootStatus(),
    enabled: isAuthenticated,
    staleTime: 60_000,
  });
  return data;
}
