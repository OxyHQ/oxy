import { useCallback } from 'react';
import { Linking } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { IdentityRootStatus } from '@oxy.so/contracts';
import { AUTH_WEB_ORIGIN } from '@oxy.so/core';
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

/**
 * Link Commons to this passkey account (ADR 0029 D3). It runs on
 * auth.oxy.so/link-commons, where Oxy passkeys are asserted, never in this app.
 */
export function useOpenLinkCommons(): () => void {
  return useCallback(() => {
    Linking.openURL(`${AUTH_WEB_ORIGIN}/link-commons`).catch(() => undefined);
  }, []);
}
