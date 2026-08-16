import * as React from 'react';
import {  useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';
import { getNormalizedUserHandle } from '@oxyhq/core';
import type {UseQueryResult} from '@tanstack/react-query';
import type {
  AccountKind,
  AccountMember,
  AccountMemberSource,
  AccountMemberStatus,
  AccountNode,
  AccountRelationship,
  AccountRole,
  AccountSuccessResult,
  CreateAccountInput,
  UpdateAccountInput,
} from '@oxyhq/core';

// ===========================================================================
// Types — re-exported from @oxyhq/core so the Console shares the single
// source of truth (the `accounts` mixin / unified account graph) rather than
// maintaining a parallel copy that can drift from the API contract.
// ===========================================================================

export type {
  AccountNode,
  AccountKind,
  AccountRelationship,
  AccountMember,
  AccountRole,
  AccountMemberStatus,
  AccountMemberSource,
  CreateAccountInput,
  UpdateAccountInput,
};

/**
 * Permission strings derived from the member's role server-side (the unified
 * account capability set). The Console gates UI affordances on these values
 * directly — it never re-derives them from the role, so the role map stays
 * single-sourced in the API.
 */
export type AccountPermission =
  | 'account:read'
  | 'account:update'
  | 'account:delete'
  | 'account:act_as'
  | 'members:read'
  | 'members:invite'
  | 'members:update'
  | 'members:remove'
  | 'children:read'
  | 'children:create'
  | 'children:update'
  | 'children:delete'
  | 'apps:read'
  | 'apps:create'
  | 'apps:update'
  | 'apps:delete'
  | 'credentials:read'
  | 'credentials:create'
  | 'credentials:rotate'
  | 'credentials:revoke'
  | 'billing:read'
  | 'billing:manage'
  | 'ownership:transfer';

/** Roles assignable via invite/update — everything except `owner`. */
export type AssignableAccountRole = Exclude<AccountRole, 'owner'>;

interface AccountContextValue {
  // State
  accounts: Array<AccountNode>;
  currentAccount: AccountNode | null;
  isLoading: boolean;

  // Account CRUD
  setCurrentAccount: (account: AccountNode) => Promise<void>;
  createAccount: (data: CreateAccountInput) => Promise<AccountNode>;
  updateAccount: (accountId: string, data: UpdateAccountInput) => Promise<AccountNode>;
  archiveAccount: (accountId: string) => Promise<AccountSuccessResult>;

  // Permissions — derived from the node's embedded `callerMembership`.
  canEditAccount: (account: AccountNode) => boolean;
  canManageMembers: (account: AccountNode) => boolean;
  canTransferOwnership: (account: AccountNode) => boolean;
  canArchiveAccount: (account: AccountNode) => boolean;
  canCreateApplications: (account: AccountNode) => boolean;
  canReadBilling: (account: AccountNode) => boolean;
  canManageBilling: (account: AccountNode) => boolean;
  getUserRole: (account: AccountNode) => AccountRole | null;
}

const AccountContext = React.createContext<AccountContextValue | null>(null);

const CURRENT_ACCOUNT_KEY = 'oxy-current-account-id';

const accountQueryKeys = {
  all: ['accounts'] as const,
  members: (accountId: string) => ['account-members', accountId] as const,
  membersAll: ['account-members'] as const,
};

function readStoredAccountId(): string | null {
  try {
    return localStorage.getItem(CURRENT_ACCOUNT_KEY);
  } catch {
    // localStorage can throw in privacy modes / SSR — treat as no selection.
    return null;
  }
}

function persistAccountId(id: string): void {
  try {
    localStorage.setItem(CURRENT_ACCOUNT_KEY, id);
  } catch (error) {
    // Persisting the selection is best-effort; surface for diagnostics only.
    if (import.meta.env.DEV) {
      console.warn('Failed to persist current account id', error);
    }
  }
}

/** Pick the default account: the personal one, else the first available. */
function pickDefaultAccount(accounts: Array<AccountNode>): AccountNode | null {
  if (accounts.length === 0) {
    return null;
  }
  return accounts.find((a) => a.kind === 'personal') ?? accounts[0];
}

/**
 * The account's display label: its `name.displayName`, else its handle.
 *
 * The `displayName ?? handle` pattern the identity contract mandates, and
 * nothing longer — `displayName` is optional on the wire, and rebuilding a
 * multi-field chain here is how a frontend comes to disagree with the
 * serializer about what somebody is called.
 */
export function accountLabel(node: AccountNode): string {
  return node.account.name?.displayName ?? getNormalizedUserHandle(node.account) ?? 'Account';
}

/** An account permission check that reads the embedded `callerMembership`. */
function hasPermission(account: AccountNode, permissions: Array<AccountPermission>): boolean {
  const granted = account.callerMembership?.permissions;
  if (!granted) {
    return false;
  }
  return permissions.some((p) => granted.includes(p));
}

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const { oxyServices, switchToAccount, user, isAuthenticated, isReady } = useAuth();
  const queryClient = useQueryClient();

  const accountsQuery = useQuery({
    queryKey: accountQueryKeys.all,
    queryFn: () => oxyServices.listAccounts(),
    enabled: isReady && isAuthenticated,
    staleTime: 1000 * 60 * 5,
    retry: 2,
  });

  const accounts = React.useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);

  // Selected account id, seeded from localStorage. Updates are user-driven
  // (switcher) so a single setter + a small persistence effect is enough.
  const [selectedId, setSelectedId] = React.useState<string | null>(() => readStoredAccountId());

  // Resolve the current account from the selection, falling back to the
  // default (personal-first) when the selection is missing or invalid.
  const currentAccount = React.useMemo<AccountNode | null>(() => {
    if (accounts.length === 0) {
      return null;
    }
    const selected = selectedId ? accounts.find((a) => a.accountId === selectedId) : undefined;
    return selected ?? pickDefaultAccount(accounts);
  }, [accounts, selectedId]);

  // Keep the persisted selection aligned with the resolved current account.
  // This reconciles a stale/invalid stored id to the actual default once the
  // list loads. Persistence is the only side-effect, so a small effect is fine.
  React.useEffect(() => {
    if (currentAccount && currentAccount.accountId !== selectedId) {
      setSelectedId(currentAccount.accountId);
      persistAccountId(currentAccount.accountId);
    }
  }, [currentAccount, selectedId]);

  const setCurrentAccount = React.useCallback(
    async (account: AccountNode): Promise<void> => {
      if (account.accountId !== currentAccount?.accountId) {
        await switchToAccount(account.accountId);
      }
      setSelectedId(account.accountId);
      persistAccountId(account.accountId);
    },
    [currentAccount?.accountId, switchToAccount],
  );

  // Keep console account context aligned when the device session changes via
  // ProfileButton / OxyAccountDialog (outside the header org switcher).
  React.useEffect(() => {
    if (!user?.id || accounts.length === 0) {
      return;
    }
    const sessionAccount = accounts.find((a) => a.accountId === user.id);
    if (!sessionAccount || sessionAccount.accountId === selectedId) {
      return;
    }
    setSelectedId(sessionAccount.accountId);
    persistAccountId(sessionAccount.accountId);
  }, [accounts, selectedId, user?.id]);

  const createAccountMutation = useMutation({
    mutationFn: (data: CreateAccountInput): Promise<AccountNode> => oxyServices.createAccount(data),
    onSuccess: (created) => {
      queryClient.setQueryData<Array<AccountNode>>(accountQueryKeys.all, (existing) =>
        existing ? [...existing, created] : [created],
      );
      queryClient.invalidateQueries({ queryKey: accountQueryKeys.all });
      void setCurrentAccount(created);
    },
  });

  const updateAccountMutation = useMutation({
    mutationFn: ({ accountId, data }: { accountId: string; data: UpdateAccountInput }): Promise<AccountNode> =>
      oxyServices.updateAccount(accountId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: accountQueryKeys.all });
    },
  });

  const archiveAccountMutation = useMutation({
    mutationFn: (accountId: string): Promise<AccountSuccessResult> =>
      oxyServices.archiveAccount(accountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: accountQueryKeys.all });
    },
  });

  const createAccount = React.useCallback(
    (data: CreateAccountInput): Promise<AccountNode> => createAccountMutation.mutateAsync(data),
    [createAccountMutation]
  );

  const updateAccount = React.useCallback(
    (accountId: string, data: UpdateAccountInput): Promise<AccountNode> =>
      updateAccountMutation.mutateAsync({ accountId, data }),
    [updateAccountMutation]
  );

  const archiveAccount = React.useCallback(
    (accountId: string): Promise<AccountSuccessResult> => archiveAccountMutation.mutateAsync(accountId),
    [archiveAccountMutation]
  );

  const getUserRole = React.useCallback(
    (account: AccountNode): AccountRole | null => account.callerMembership?.role ?? null,
    []
  );

  const canEditAccount = React.useCallback(
    (account: AccountNode): boolean => hasPermission(account, ['account:update']),
    []
  );

  const canManageMembers = React.useCallback(
    (account: AccountNode): boolean =>
      hasPermission(account, ['members:invite', 'members:update', 'members:remove']),
    []
  );

  const canTransferOwnership = React.useCallback(
    (account: AccountNode): boolean => hasPermission(account, ['ownership:transfer']),
    []
  );

  const canArchiveAccount = React.useCallback(
    (account: AccountNode): boolean => hasPermission(account, ['account:delete']),
    []
  );

  /**
   * Creating an application is an ACCOUNT permission, held by owner, admin and
   * editor and by nobody else — a developer, a billing member and a viewer are
   * all refused server-side. Offering the affordance regardless turns a
   * guaranteed 403 into an error toast after the user has filled in a form.
   */
  const canCreateApplications = React.useCallback(
    (account: AccountNode): boolean => hasPermission(account, ['apps:create']),
    []
  );

  /**
   * The two billing rights, read off the membership the API serves rather than
   * re-derived from the role name.
   *
   * They are genuinely different: `billing:read` sees the balance, the charges
   * and the budgets; `billing:manage` moves money — a top-up, a portal session,
   * a budget ceiling. Both are baseline for `owner`, `admin`, `editor` and the
   * `billing` role, absent from `developer` and `viewer`, and removable by a
   * per-member revoke, which is exactly why the client must not infer them.
   */
  const canReadBilling = React.useCallback(
    (account: AccountNode): boolean => hasPermission(account, ['billing:read']),
    []
  );

  const canManageBilling = React.useCallback(
    (account: AccountNode): boolean => hasPermission(account, ['billing:manage']),
    []
  );

  const value = React.useMemo<AccountContextValue>(
    () => ({
      accounts,
      currentAccount,
      isLoading: accountsQuery.isLoading,
      setCurrentAccount,
      createAccount,
      updateAccount,
      archiveAccount,
      canEditAccount,
      canManageMembers,
      canTransferOwnership,
      canArchiveAccount,
      canCreateApplications,
      canReadBilling,
      canManageBilling,
      getUserRole,
    }),
    [
      accounts,
      currentAccount,
      accountsQuery.isLoading,
      setCurrentAccount,
      createAccount,
      updateAccount,
      archiveAccount,
      canEditAccount,
      canManageMembers,
      canTransferOwnership,
      canArchiveAccount,
      canCreateApplications,
      canReadBilling,
      canManageBilling,
      getUserRole,
    ]
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount() {
  const context = React.useContext(AccountContext);
  if (!context) {
    throw new Error('useAccount must be used within AccountProvider');
  }
  return context;
}

// ===========================================================================
// Members — queried per-account. There is NO separate "invite" entity:
// invitations are members with `status: 'invited'`. Pending invites are
// therefore `members.filter((m) => m.status === 'invited')`, and cancelling an
// invite is the same operation as removing a member.
// ===========================================================================

export function useAccountMembers(
  accountId: string | undefined,
  enabled: boolean = true
): UseQueryResult<Array<AccountMember>> {
  const { oxyServices, isAuthenticated, isReady } = useAuth();

  return useQuery({
    queryKey: accountQueryKeys.members(accountId ?? ''),
    queryFn: () => oxyServices.listAccountMembers(accountId ?? ''),
    enabled: isReady && isAuthenticated && !!accountId && enabled,
    staleTime: 1000 * 60 * 2,
    retry: 1,
  });
}

export function useInviteAccountMember() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      accountId,
      usernameOrEmail,
      role,
    }: {
      accountId: string;
      usernameOrEmail: string;
      role: AssignableAccountRole;
    }): Promise<AccountMember> =>
      oxyServices.inviteAccountMember(accountId, { usernameOrEmail, role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: accountQueryKeys.membersAll });
    },
  });
}

export function useUpdateAccountMember() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      accountId,
      memberId,
      role,
    }: {
      accountId: string;
      memberId: string;
      role: AssignableAccountRole;
    }): Promise<AccountMember> => oxyServices.updateAccountMember(accountId, memberId, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: accountQueryKeys.membersAll });
    },
  });
}

export function useRemoveAccountMember() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      accountId,
      memberId,
    }: {
      accountId: string;
      memberId: string;
    }): Promise<{ accountId: string; memberId: string }> => {
      await oxyServices.removeAccountMember(accountId, memberId);
      return { accountId, memberId };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: accountQueryKeys.membersAll });
    },
  });
}

export function useTransferAccountOwnership() {
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      accountId,
      userId,
    }: {
      accountId: string;
      userId: string;
    }): Promise<AccountSuccessResult> =>
      oxyServices.transferAccountOwnership(accountId, { userId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: accountQueryKeys.membersAll });
      queryClient.invalidateQueries({ queryKey: accountQueryKeys.all });
    },
  });
}
