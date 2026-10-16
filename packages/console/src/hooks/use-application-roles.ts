import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services';
import type {
  ApplicationPermissionDeclaration,
  ApplicationPermissionList,
  ApplicationRoleGrant,
  ApplicationRoleGrantList,
  DeclareApplicationPermissionsResponse,
} from '@oxy.so/contracts';

/**
 * Application roles in the Console: the application's own permission
 * vocabulary and who holds it (`docs/auth/application-roles.md`). Reads need
 * `roles:read`, writes `roles:manage`; the API enforces both.
 *
 * Through `oxyServices.request` rather than a namespace method, the way the
 * credential audit read is: the wire contract is `@oxy.so/contracts`, which is
 * what these types come from.
 */

export type {
  ApplicationPermissionDeclaration,
  ApplicationRoleGrant,
} from '@oxy.so/contracts';

const roleKeys = {
  permissions: (appId: string) => ['application-role-permissions', appId] as const,
  grants: (appId: string) => ['application-role-grants', appId] as const,
};

/** The page the grant list asks for: the server's maximum, since operators are few. */
const GRANT_PAGE_LIMIT = 200;

export function useApplicationRolePermissions(appId: string, enabled: boolean) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();
  return useQuery({
    queryKey: roleKeys.permissions(appId),
    queryFn: () =>
      oxyServices.request<ApplicationPermissionList>(
        'GET',
        `/applications/${encodeURIComponent(appId)}/roles/permissions`,
        undefined,
        { cache: false },
      ),
    enabled: isReady && isAuthenticated && !!appId && enabled,
  });
}

export function useApplicationRoleGrants(appId: string, enabled: boolean) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();
  return useQuery({
    queryKey: roleKeys.grants(appId),
    queryFn: () =>
      oxyServices.request<ApplicationRoleGrantList>(
        'GET',
        `/applications/${encodeURIComponent(appId)}/roles/grants`,
        { limit: GRANT_PAGE_LIMIT },
        { cache: false },
      ),
    enabled: isReady && isAuthenticated && !!appId && enabled,
  });
}

export function useDeclareApplicationPermissions() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      appId,
      permissions,
    }: {
      appId: string;
      permissions: ApplicationPermissionDeclaration[];
    }) =>
      oxyServices.request<DeclareApplicationPermissionsResponse>(
        'PUT',
        `/applications/${encodeURIComponent(appId)}/roles/permissions`,
        { permissions },
        { cache: false },
      ),
    onSuccess: (_result, { appId }) => {
      void queryClient.invalidateQueries({ queryKey: roleKeys.permissions(appId) });
      // Retiring a key revokes its grants.
      void queryClient.invalidateQueries({ queryKey: roleKeys.grants(appId) });
    },
  });
}

export function useGrantApplicationPermission() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      appId,
      username,
      permission,
      reason,
    }: {
      appId: string;
      username: string;
      permission: string;
      reason?: string;
    }) =>
      oxyServices.request<ApplicationRoleGrant>(
        'POST',
        `/applications/${encodeURIComponent(appId)}/roles/grants`,
        { username, permission, ...(reason ? { reason } : {}) },
        { cache: false },
      ),
    onSuccess: (_grant, { appId }) => {
      void queryClient.invalidateQueries({ queryKey: roleKeys.grants(appId) });
    },
  });
}

export function useRevokeApplicationRoleGrant() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ appId, grantId }: { appId: string; grantId: string }) =>
      oxyServices.request<ApplicationRoleGrant>(
        'POST',
        `/applications/${encodeURIComponent(appId)}/roles/grants/${encodeURIComponent(grantId)}/revoke`,
        {},
        { cache: false },
      ),
    onSuccess: (_grant, { appId }) => {
      void queryClient.invalidateQueries({ queryKey: roleKeys.grants(appId) });
    },
  });
}
