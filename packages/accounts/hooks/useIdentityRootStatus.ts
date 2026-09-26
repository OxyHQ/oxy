import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { IdentityRootStatus } from '@oxy.so/contracts';
import { useOxy } from '@oxy.so/services';

/**
 * How the signed-in account is kept: Commons' root, or an email (with an
 * optional password and authenticator). `undefined` while unknown: nothing is
 * shown on a guess.
 */
export function useIdentityRootStatus(): IdentityRootStatus | undefined {
  const { oxyServices, isAuthenticated } = useOxy();
  const { data } = useQuery({
    queryKey: ['identity', 'root-status'],
    queryFn: () => oxyServices.identity.rootStatus(),
    enabled: isAuthenticated,
    staleTime: 60_000,
  });
  return data;
}

/**
 * Link Commons to this account: the SDK's own panel (`LinkCommons`), right in
 * this app, confirmed with a code by email.
 */
export function useOpenLinkCommons(): () => void {
  const { showBottomSheet } = useOxy();
  return useCallback(() => {
    showBottomSheet?.('LinkCommons');
  }, [showBottomSheet]);
}
