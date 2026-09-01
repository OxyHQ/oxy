import { useQuery } from '@tanstack/react-query';
import { authenticatedApiCall } from '@oxyhq/core';
import { queryKeys } from './queryKeys';
import { useOxy } from '../../context/OxyContext';
import type {
  Subscription,
  Payment,
  Wallet,
  WalletTransactionsResponse,
} from './paymentTypes';

/**
 * Payment / wallet / subscription query hooks.
 *
 * These replace the imperative `oxyServices.*` + `Promise.allSettled` +
 * `useEffect` pattern used in app screens. Each hook:
 *  - is gated on `isAuthenticated` (the underlying SDK methods read the
 *    current user id off the access token and throw when unauthenticated),
 *  - routes through `authenticatedApiCall` so a stale token is refreshed and
 *    auth errors are handled consistently (matches `useUserDevices` /
 *    `usePrivacySettings`),
 *  - keeps its `queryFn` pure — no store writes, no side effects.
 *
 * The wrapped SDK methods (`@oxyhq/core` payment mixin) return `any`; the
 * generic on `authenticatedApiCall<T>` pins the resolved value to the
 * precise domain type so consumers get full typing.
 */

/**
 * Get the current user's subscription.
 *
 * Wraps `oxyServices.getCurrentUserSubscription()`
 * (`GET /subscription/:userId`, billing-first). Returns the persisted
 * subscription or the API's `{ plan: 'basic' }` fallback when the user has
 * never subscribed.
 */
export const useUserSubscription = (options?: { enabled?: boolean }) => {
  const { oxyServices, isAuthenticated, activeSessionId, user } = useOxy();

  return useQuery({
    queryKey: queryKeys.payments.subscription(user?.id),
    queryFn: async () => {
      return authenticatedApiCall<Subscription>(
        oxyServices,
        activeSessionId,
        () => oxyServices.getCurrentUserSubscription(),
      );
    },
    enabled: (options?.enabled !== false) && isAuthenticated && !!user?.id,
    // Subscription state changes rarely; tolerate a longer fresh window.
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 30 * 60 * 1000, // 30 minutes
  });
};

/**
 * Get the current user's payment / billing history.
 *
 * Wraps `oxyServices.getUserPayments()` (`GET /payments/user`), which
 * returns the user's `deposit` and `purchase` transactions newest-first.
 */
export const useUserPayments = (options?: { enabled?: boolean }) => {
  const { oxyServices, isAuthenticated, activeSessionId, user } = useOxy();

  return useQuery({
    queryKey: queryKeys.payments.history(user?.id),
    queryFn: async () => {
      return authenticatedApiCall<Payment[]>(
        oxyServices,
        activeSessionId,
        () => oxyServices.getUserPayments(),
      );
    },
    enabled: (options?.enabled !== false) && isAuthenticated && !!user?.id,
    // Billing history is append-mostly; a short fresh window is fine.
    staleTime: 2 * 60 * 1000, // 2 minutes
    gcTime: 30 * 60 * 1000, // 30 minutes
  });
};

/**
 * Get the current user's FairCoin wallet balance.
 *
 * Wraps `oxyServices.getCurrentUserWallet()` (`GET /wallet/:userId`).
 * Balance changes frequently, so the fresh window is intentionally short.
 */
export const useUserWallet = (options?: { enabled?: boolean }) => {
  const { oxyServices, isAuthenticated, activeSessionId, user } = useOxy();

  return useQuery({
    queryKey: queryKeys.payments.wallet(user?.id),
    queryFn: async () => {
      return authenticatedApiCall<Wallet>(
        oxyServices,
        activeSessionId,
        () => oxyServices.getCurrentUserWallet(),
      );
    },
    enabled: (options?.enabled !== false) && isAuthenticated && !!user?.id,
    staleTime: 60 * 1000, // 1 minute (balance moves often)
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
};

/**
 * Get the current user's wallet transaction history (paginated).
 *
 * Wraps `oxyServices.getCurrentUserWalletTransactions(options)`
 * (`GET /wallet/transactions/:userId`). The API responds with a
 * `{ data, pagination }` envelope, preserved here as
 * `WalletTransactionsResponse`.
 *
 * @param params - Optional `limit` / `offset` pagination controls. These are
 *   part of the query key, so distinct pages cache independently.
 */
export const useUserWalletTransactions = (
  params?: { limit?: number; offset?: number },
  options?: { enabled?: boolean },
) => {
  const { oxyServices, isAuthenticated, activeSessionId, user } = useOxy();
  const limit = params?.limit;
  const offset = params?.offset;

  return useQuery({
    queryKey: queryKeys.payments.walletTransactions(limit, offset, user?.id),
    queryFn: async () => {
      return authenticatedApiCall<WalletTransactionsResponse>(
        oxyServices,
        activeSessionId,
        () => oxyServices.getCurrentUserWalletTransactions({ limit, offset }),
      );
    },
    enabled: (options?.enabled !== false) && isAuthenticated && !!user?.id,
    staleTime: 60 * 1000, // 1 minute (ledger updates frequently)
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
};
