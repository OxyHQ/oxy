import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import type {
  CreateDelegationGrantInput,
  PutAccountCapabilityPolicyInput,
  UpdateDelegationGrantInput,
} from '@oxyhq/core';

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
        oxyServices.listAvailableCapabilityCatalogs(accountId),
        oxyServices.listDelegationGrants(accountId),
        oxyServices.listAccountCapabilityPolicies(accountId),
        oxyServices.listCapabilityExecutionAuthorizations(accountId),
        oxyServices.listCapabilityAuditEvents(accountId),
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
    oxyServices.createDelegationGrant(input));
}

export function useRevokeDelegationGrant(accountId: string) {
  const { oxyServices } = useOxy();
  return useAgencyMutation(accountId, ['agency', 'grant', 'revoke'], (grantId: string) =>
    oxyServices.revokeDelegationGrant(grantId, accountId));
}

export function useUpdateDelegationGrant(accountId: string) {
  const { oxyServices } = useOxy();
  return useAgencyMutation(
    accountId,
    ['agency', 'grant', 'update'],
    ({ grantId, input }: { grantId: string; input: UpdateDelegationGrantInput }) =>
      oxyServices.updateDelegationGrant(grantId, accountId, input),
  );
}

export function usePutAccountCapabilityPolicy(accountId: string) {
  const { oxyServices } = useOxy();
  return useAgencyMutation(
    accountId,
    ['agency', 'policy', 'put'],
    ({ appId, policy }: { appId: string; policy: PutAccountCapabilityPolicyInput }) =>
      oxyServices.putAccountCapabilityPolicy(appId, policy),
  );
}

export function useDeleteAccountCapabilityPolicy(accountId: string) {
  const { oxyServices } = useOxy();
  return useAgencyMutation(accountId, ['agency', 'policy', 'delete'], (appId: string) =>
    oxyServices.deleteAccountCapabilityPolicy(appId, accountId));
}

export function useRevokeExecutionAuthorization(accountId: string) {
  const { oxyServices } = useOxy();
  return useAgencyMutation(accountId, ['agency', 'authorization', 'revoke'], (authorizationId: string) =>
    oxyServices.revokeCapabilityExecutionAuthorization(authorizationId, accountId));
}
