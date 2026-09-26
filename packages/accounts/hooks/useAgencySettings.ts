import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import type {
  CreateDelegationGrantInput,
  PutAccountCapabilityPolicyInput,
  UpdateDelegationGrantInput,
} from '@oxy.so/core';

export function agencySettingsQueryKey(accountId: string | null | undefined) {
  return ['agency-settings', accountId ?? null] as const;
}

export function useAgencySettings(accountId: string | null) {
  const { oxyServices, isAuthenticated } = useOxy();
  return useQuery({
    queryKey: agencySettingsQueryKey(accountId),
    enabled: isAuthenticated && accountId !== null,
    queryFn: async () => {
      if (!accountId) throw new Error('An account is required');
      const [catalogs, grants, policies, authorizations, auditEvents] = await Promise.all([
        oxyServices.agency.catalogs(accountId),
        oxyServices.agency.grants.list(accountId),
        oxyServices.agency.policies.list(accountId),
        oxyServices.agency.authorizations.list(accountId),
        oxyServices.agency.auditEvents(accountId),
      ]);
      return { catalogs, grants, policies, authorizations, auditEvents };
    },
    staleTime: 30_000,
  });
}

function useAgencyMutation<TInput, TResult>(
  accountId: string,
  mutationKey: readonly string[],
  mutationFn: (input: TInput) => Promise<TResult>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...mutationKey, accountId],
    mutationFn,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: agencySettingsQueryKey(accountId) });
    },
  });
}

export function useCreateDelegationGrant(accountId: string) {
  const { oxyServices } = useOxy();
  return useAgencyMutation(accountId, ['agency', 'grant', 'create'], (input: CreateDelegationGrantInput) =>
    oxyServices.agency.grants.create(input));
}

export function useRevokeDelegationGrant(accountId: string) {
  const { oxyServices } = useOxy();
  return useAgencyMutation(accountId, ['agency', 'grant', 'revoke'], (grantId: string) =>
    oxyServices.agency.grants.revoke(grantId, accountId));
}

export function useUpdateDelegationGrant(accountId: string) {
  const { oxyServices } = useOxy();
  return useAgencyMutation(
    accountId,
    ['agency', 'grant', 'update'],
    ({ grantId, input }: { grantId: string; input: UpdateDelegationGrantInput }) =>
      oxyServices.agency.grants.update(grantId, accountId, input),
  );
}

export function usePutAccountCapabilityPolicy(accountId: string) {
  const { oxyServices } = useOxy();
  return useAgencyMutation(
    accountId,
    ['agency', 'policy', 'put'],
    ({ appId, policy }: { appId: string; policy: PutAccountCapabilityPolicyInput }) =>
      oxyServices.agency.policies.put(appId, policy),
  );
}

export function useDeleteAccountCapabilityPolicy(accountId: string) {
  const { oxyServices } = useOxy();
  return useAgencyMutation(accountId, ['agency', 'policy', 'delete'], (appId: string) =>
    oxyServices.agency.policies.delete(appId, accountId));
}

export function useRevokeExecutionAuthorization(accountId: string) {
  const { oxyServices } = useOxy();
  return useAgencyMutation(accountId, ['agency', 'authorization', 'revoke'], (authorizationId: string) =>
    oxyServices.agency.authorizations.revoke(authorizationId, accountId));
}
