import { useAccount } from '@/hooks/use-account';

/**
 * What the caller may do with the money of the account they are working in.
 *
 * Read off the account node the API serves (`callerMembership.permissions`), never
 * re-derived from a role name; every reporting and billing screen asks this once.
 */
export function useBillingAccess() {
  const { currentAccount, canReadBilling, canManageBilling } = useAccount();
  return {
    account: currentAccount,
    accountId: currentAccount?.accountId,
    canRead: currentAccount !== null && canReadBilling(currentAccount),
    canManage: currentAccount !== null && canManageBilling(currentAccount),
  };
}
