import { useCallback } from 'react';
import { Linking } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import type { IdentityRootStatus } from '@oxy.so/contracts';
import { IDENTITY_WEB_ORIGIN } from '@oxy.so/core';
import { useOxy } from '@oxy.so/services';

/**
 * The signed-in account's root readiness (ADR 0024 D5) — metadata only, so this
 * screen can remind a person to save their recovery phrase without ever holding
 * anything that opens their identity. `undefined` while unknown: no reminder is
 * shown on a guess.
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
 * Open the person's Oxy identity (save or show the recovery phrase, recover,
 * add Commons). It runs on Oxy's own identity page, never inside this app.
 */
export function useOpenIdentity(): () => void {
  return useCallback(() => {
    Linking.openURL(`${IDENTITY_WEB_ORIGIN}/`).catch(() => undefined);
  }, []);
}
