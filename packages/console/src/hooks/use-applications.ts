import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import type {
  AccountMember,
  AccountRole,
  Application,
  ApplicationCredential,
  ApplicationCredentialStatus,
  ApplicationCredentialType,
  ApplicationCredentialWithSecret,
  ApplicationEnvironment,
  ApplicationStatus,
  ApplicationType,
  ApplicationUsagePeriod,
  ApplicationUsageStats,
  CreateApplicationCredentialInput,
  CreateApplicationInput,
  UpdateApplicationInput,
} from '@oxyhq/core';
import { useAccount } from '@/hooks/use-account';

// ===========================================================================
// Types — re-exported from @oxyhq/core so the Console shares the single
// source of truth (the `accounts` mixin, which owns app management) rather
// than maintaining a parallel copy that can drift from the API contract.
//
// Applications are owned by an account (`Application.ownerAccountId`); access
// derives from the caller's `AccountMember` on that account (with inheritance).
// There is no per-application membership — members are managed at the account
// level (see `use-account.tsx`).
// ===========================================================================

export type {
  Application,
  ApplicationType,
  ApplicationStatus,
  ApplicationCredential,
  ApplicationCredentialType,
  ApplicationCredentialStatus,
  ApplicationEnvironment,
  CreateApplicationInput,
  UpdateApplicationInput,
};

/** Result of creating/rotating a credential — the secret is returned ONCE. */
export type CredentialWithSecret = ApplicationCredentialWithSecret;

/** Usage statistics for an application over a period. */
export type AppUsageStats = ApplicationUsageStats;

export interface CreateCredentialInput {
  name: string;
  type: ApplicationCredentialType;
  environment: ApplicationEnvironment;
  scopes?: Array<string>;
}

// ===========================================================================
// Query keys
// ===========================================================================

/**
 * Prefix matching every account-scoped applications list. Used to patch all
 * cached lists (across accounts) on update/delete via a partial key match.
 */
const APPLICATIONS_LIST_PREFIX = ['applications'] as const;

const queryKeys = {
  applications: (accountId: string | undefined) => ['applications', accountId ?? null] as const,
  application: (appId: string, accountId: string | undefined) =>
    ['application', appId, accountId ?? null] as const,
  credentials: (appId: string) => ['application-credentials', appId] as const,
  credentialAudit: (appId: string, credentialId: string) =>
    ['application-credential-audit', appId, credentialId] as const,
  usage: (appId: string, period: string) => ['application-usage', appId, period] as const,
};

// ===========================================================================
// Applications
// ===========================================================================

export function useApplications() {
  const { oxyServices, isAuthenticated, isReady } = useAuth();
  const { currentAccount } = useAccount();
  const accountId = currentAccount?.accountId;

  return useQuery({
    queryKey: queryKeys.applications(accountId),
    // Apps are scoped to the active account. The query is gated on `accountId`,
    // so the empty-array branch is only here to satisfy the type when disabled.
    queryFn: () =>
      accountId ? oxyServices.listAccountApps(accountId) : Promise.resolve([] as Array<Application>),
    staleTime: 1000 * 60 * 5,
    retry: 2,
    enabled: isReady && isAuthenticated && !!accountId,
  });
}

export function useApplication(appId: string) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();
  const { currentAccount } = useAccount();
  const accountId = currentAccount?.accountId;

  return useQuery({
    queryKey: queryKeys.application(appId, accountId),
    queryFn: () => oxyServices.getApp(appId),
    enabled: isReady && isAuthenticated && !!appId && !!accountId,
    staleTime: 1000 * 60 * 2,
    retry: 1,
  });
}

export function useCreateApplication() {
  const { oxyServices } = useAuth();
  const { currentAccount } = useAccount();
  const queryClient = useQueryClient();
  const accountId = currentAccount?.accountId;

  return useMutation({
    mutationFn: (data: CreateApplicationInput): Promise<Application> =>
      // New apps land under the current account. An explicit `ownerAccountId`
      // on the input still wins; otherwise scope to the active account.
      oxyServices.createApp(accountId ? { ownerAccountId: accountId, ...data } : data),
    onSuccess: (newApp) => {
      queryClient.setQueryData<Array<Application>>(queryKeys.applications(accountId), (old) =>
        old ? [newApp, ...old] : [newApp]
      );
      queryClient.setQueryData(queryKeys.application(newApp._id, accountId), newApp);
    },
  });
}

export function useUpdateApplication() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      appId,
      data,
    }: {
      appId: string;
      data: UpdateApplicationInput;
    }): Promise<Application> => oxyServices.updateApp(appId, data),
    onSuccess: (updatedApp) => {
      // Patch the app in every cached account-scoped list (prefix match).
      queryClient.setQueriesData<Array<Application>>(
        { queryKey: APPLICATIONS_LIST_PREFIX },
        (old) =>
          old ? old.map((app) => (app._id === updatedApp._id ? updatedApp : app)) : old
      );
      queryClient.setQueriesData<Application>(
        { queryKey: ['application', updatedApp._id] },
        updatedApp
      );
    },
  });
}

export function useDeleteApplication() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (appId: string): Promise<string> => {
      await oxyServices.deleteApp(appId);
      return appId;
    },
    onSuccess: (appId) => {
      // Drop the app from every cached account-scoped list (prefix match).
      queryClient.setQueriesData<Array<Application>>(
        { queryKey: APPLICATIONS_LIST_PREFIX },
        (old) => (old ? old.filter((app) => app._id !== appId) : old)
      );
      queryClient.removeQueries({ queryKey: ['application', appId] });
      queryClient.removeQueries({ queryKey: queryKeys.credentials(appId) });
    },
  });
}

// ===========================================================================
// Credentials
// ===========================================================================

export function useApplicationCredentials(appId: string, enabled: boolean = true) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.credentials(appId),
    queryFn: () => oxyServices.listAppCredentials(appId),
    enabled: isReady && isAuthenticated && !!appId && enabled,
    staleTime: 1000 * 60 * 2,
    retry: 1,
  });
}

export function useCreateCredential() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      appId,
      data,
    }: {
      appId: string;
      data: CreateCredentialInput;
    }): Promise<CredentialWithSecret> => {
      const payload: CreateApplicationCredentialInput = {
        name: data.name,
        type: data.type,
        environment: data.environment,
        scopes: data.scopes,
      };
      return oxyServices.createAppCredential(appId, payload);
    },
    onSuccess: ({ credential }) => {
      queryClient.setQueryData<Array<ApplicationCredential>>(
        queryKeys.credentials(credential.applicationId),
        (old) => (old ? [credential, ...old] : [credential])
      );
    },
  });
}

export function useRotateCredential() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      appId,
      credentialId,
    }: {
      appId: string;
      credentialId: string;
    }): Promise<CredentialWithSecret> => oxyServices.rotateAppCredential(appId, credentialId),
    onSuccess: ({ credential }, { appId, credentialId }) => {
      queryClient.setQueryData<Array<ApplicationCredential>>(
        queryKeys.credentials(credential.applicationId),
        (old) => (old ? old.map((c) => (c._id === credential._id ? credential : c)) : [credential])
      );
      // A rotation writes the `rotated` row AND the replacement's `created` row,
      // so an open trail is stale the instant this lands. Invalidated for both
      // ids: the rotated credential and the one that replaced it.
      queryClient.invalidateQueries({ queryKey: queryKeys.credentialAudit(appId, credentialId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.credentialAudit(appId, credential._id),
      });
    },
  });
}

/**
 * One credential's audit trail — `created`, `rotated`, `revoked` and every
 * refused validation — newest first.
 *
 * There is no `select` projection here, and its absence is the point. The BYOK
 * equivalent (`use-provider-connections.ts`) projects `metadata` away in `select`
 * because the server sends whole rows and a cache holding that blob is one
 * component away from printing it. This endpoint has nothing to project: the
 * server's own wire type, `CredentialAuditTrailEntry`, has no `metadata`
 * property at all, so the field is absent STRUCTURALLY rather than by this
 * hook's discipline. Re-adding a projection here would imply the opposite.
 *
 * These rows exist BECAUSE a secret was shown exactly once, and they carry none:
 * the only writer takes ids and closed enums, so there is no parameter a secret
 * could arrive through.
 */
export interface CredentialAuditEvent {
  readonly eventType: 'created' | 'rotated' | 'revoked' | 'validation_failed';
  /**
   * Why a validation was refused. Non-null ONLY on `validation_failed`, which is
   * also the only event with a null `actorUserId` — two correlated states, not
   * four independent ones.
   */
  readonly reason:
    | 'secret_mismatch'
    | 'not_usable'
    | 'environment_mismatch'
    | 'application_inactive'
    | 'scope_missing'
    | null;
  /** The member who performed a transition; null on `validation_failed`. */
  readonly actorUserId: string | null;
  readonly environment: string | null;
  readonly createdAt: string;
  /** A deadline the event established — a rotation's grace end. */
  readonly effectiveUntil: string | null;
}

/**
 * How many events one trail asks for. The server accepts 1–200 and defaults to
 * 50; this asks for the default rather than the maximum, because a collapsible
 * trail under one credential row is read, not analysed — a member auditing a
 * long history wants an export, which is a different surface.
 */
const CREDENTIAL_AUDIT_LIMIT = 50;

export function useCredentialAudit(
  appId: string,
  credentialId: string | undefined,
  enabled: boolean = true
) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.credentialAudit(appId, credentialId ?? ''),
    queryFn: () =>
      oxyServices.makeRequest<Array<CredentialAuditEvent>>(
        'GET',
        `/applications/${appId}/credentials/${credentialId ?? ''}/audit`,
        { limit: CREDENTIAL_AUDIT_LIMIT },
        { cache: false }
      ),
    enabled: isReady && isAuthenticated && !!appId && !!credentialId && enabled,
    staleTime: 1000 * 30,
    retry: 1,
  });
}

export function useRevokeCredential() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      appId,
      credentialId,
    }: {
      appId: string;
      credentialId: string;
    }): Promise<{ appId: string; credentialId: string }> => {
      await oxyServices.revokeAppCredential(appId, credentialId);
      return { appId, credentialId };
    },
    onSuccess: ({ appId, credentialId }) => {
      queryClient.setQueryData<Array<ApplicationCredential>>(queryKeys.credentials(appId), (old) =>
        old
          ? old.map((c) =>
              c._id === credentialId ? { ...c, status: 'revoked' as const } : c
            )
          : []
      );
      // The revoke writes a `revoked` row; an open trail must show it.
      queryClient.invalidateQueries({ queryKey: queryKeys.credentialAudit(appId, credentialId) });
    },
  });
}

// ===========================================================================
// Usage
// ===========================================================================

export function useApplicationUsage(appId: string, period: string = '7d', enabled: boolean = true) {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: queryKeys.usage(appId, period),
    queryFn: () => oxyServices.getAppUsage(appId, period as ApplicationUsagePeriod),
    enabled: isReady && isAuthenticated && !!appId && enabled,
    staleTime: 1000 * 60,
    retry: 1,
  });
}

// ===========================================================================
// Caller permissions — derived from the caller's embedded account membership.
// The server is the single source of truth for the role→permission map; the
// Console reads `callerMembership.permissions` directly to gate UI affordances.
// Application access derives from the OWNING account's membership (with
// inheritance), so there is no per-application member list to resolve against.
// ===========================================================================

/**
 * What an application's `callerMembership.permissions` actually contains.
 *
 * NOT `AccountPermission`. The two vocabularies overlap enough to look
 * interchangeable and are not: an account grants `apps:read` / `apps:update` /
 * `apps:delete` over the apps it owns, while an APPLICATION grants `app:read` /
 * `app:update` / `app:delete` over itself. The API derives the second from the
 * first (`appPermissionsForAccountAccess`, over the caller's EFFECTIVE account
 * permissions — per-member grants and revokes included) and serialises only the
 * second here, on every path that returns an application.
 *
 * Typing this as `AccountPermission` let `access.can('apps:update')` compile and
 * silently answer false forever, which disabled the whole Settings form for its
 * owner. The union below is what makes the wrong string a build error instead.
 */
export type ApplicationPermission =
  | 'app:read'
  | 'app:update'
  | 'app:delete'
  | 'members:read'
  | 'members:invite'
  | 'members:update'
  | 'members:remove'
  | 'credentials:read'
  | 'credentials:create'
  | 'credentials:rotate'
  | 'credentials:revoke'
  | 'webhooks:read'
  | 'webhooks:update'
  | 'usage:read'
  | 'billing:read'
  | 'billing:manage'
  | 'ownership:transfer'
  | 'updates:manage'
  // The inference lane (#972 workstream 3). Spelled `byok` on an application and
  // `providers` on an account: the same power under the two vocabularies' own
  // names, which is why neither list can be derived from the other.
  | 'inference:invoke'
  | 'inference:routing:read'
  | 'inference:routing:write'
  | 'inference:byok:read'
  | 'inference:byok:write';

export interface CallerAccess {
  /** The caller's membership in the application's owning account, if any. */
  membership: AccountMember | undefined;
  /** The caller's role in the owning account, if a member. */
  role: AccountRole | undefined;
  /** Returns true if the caller holds the given permission over THIS application. */
  can: (permission: ApplicationPermission) => boolean;
  /** True once the application (and its embedded membership) has loaded. */
  isResolved: boolean;
}

function buildCallerAccess(
  membership: AccountMember | undefined,
  isResolved: boolean
): CallerAccess {
  const permissions = new Set<string>(membership?.permissions ?? []);
  return {
    membership,
    role: membership?.role,
    can: (permission) => permissions.has(permission),
    isResolved,
  };
}

/**
 * Resolves the caller's access for an application from its embedded
 * `callerMembership` (the caller's effective membership in the owning account).
 */
export function useCallerAccess(application: Application | undefined): CallerAccess {
  return buildCallerAccess(application?.callerMembership ?? undefined, application !== undefined);
}
