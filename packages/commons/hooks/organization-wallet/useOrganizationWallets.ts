/**
 * Organization wallets (ADR 0061): the organizations the signed-in person
 * governs, and each one's key as Oxy and this device see it.
 *
 * Never cached past the screen: the key is money, and a stale answer would
 * offer to set up a wallet that exists or hide one that was replaced.
 */
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useCallback } from 'react';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { getOrganizationPublicKey } from '@oxy.so/core/crypto';
import type { OrganizationIdentityKeyState } from '@oxy.so/contracts';
import { useOxy } from '@oxy.so/services';
import {
  deviceKeyStatus,
  governedOrganizations,
  type DeviceKeyStatus,
} from '@/lib/organization-wallet';

export interface GovernedOrganization {
  accountId: string;
  name: string;
}

export interface OrganizationWallet {
  state: OrganizationIdentityKeyState;
  /** The organization key this device holds, or `null`. */
  deviceKey: string | null;
  status: DeviceKeyStatus;
}

const ROOT = 'organizationWallet';

/** The organizations this person owns or administers. */
export function useGovernedOrganizations(): UseQueryResult<GovernedOrganization[]> {
  const { oxyServices, user } = useOxy();
  return useQuery<GovernedOrganization[]>({
    queryKey: [ROOT, 'list', user?.id ?? null],
    enabled: Boolean(oxyServices && user),
    staleTime: 0,
    queryFn: async () => {
      if (!oxyServices) throw new Error('OxyServices not initialized');
      const accounts = await oxyServices.accounts.list();
      return governedOrganizations(accounts).map((node) => ({
        accountId: node.accountId,
        name:
          node.account.name?.displayName || getNormalizedUserHandle(node.account) || node.accountId,
      }));
    },
  });
}

/** One organization's key: Oxy's answer and this device's. */
export function useOrganizationWallet(
  accountId: string | null,
): UseQueryResult<OrganizationWallet> {
  const { oxyServices } = useOxy();
  return useQuery<OrganizationWallet>({
    queryKey: [ROOT, 'wallet', accountId],
    enabled: Boolean(oxyServices && accountId),
    staleTime: 0,
    gcTime: 0,
    queryFn: async () => {
      if (!oxyServices || !accountId) throw new Error('OxyServices not initialized');
      const [state, deviceKey] = await Promise.all([
        oxyServices.accounts.identityKey.get(accountId),
        getOrganizationPublicKey(accountId),
      ]);
      return { state, deviceKey, status: deviceKeyStatus(state.publicKey, deviceKey) };
    },
  });
}

/** Forget every organization-wallet answer after a change. */
export function useInvalidateOrganizationWallets(): () => Promise<void> {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: [ROOT] }), [client]);
}
