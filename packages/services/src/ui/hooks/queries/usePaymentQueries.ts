import { skip } from '@oxy.so/bloom-data';
import { useOxy } from '../../context/oxyRuntimeContext';
import { useAnswer } from '../../data/answer';
import { paymentHistory, subscription, wallet, walletTransactions } from '../../data/payments';

/**
 * Payment / wallet / subscription hooks over `data/payments.ts`.
 *
 * Each hook is gated on a signed-in account (the underlying SDK methods read
 * the current user id off the access token and throw when unauthenticated)
 * and returns a bloom-data `RecordView`: the answer is its `value`.
 */

/** The arguments of a private billing read, or `skip` until there is a signed-in account. */
function useBillingAccount(options?: { enabled?: boolean }) {
  const { oxyServices, isAuthenticated, activeSessionId, user } = useOxy();
  const enabled = options?.enabled !== false && isAuthenticated && !!user?.id;
  return enabled && user?.id ? ([oxyServices, user.id, activeSessionId ?? null] as const) : null;
}

/**
 * The current user's subscription (`GET /subscription/:userId`, billing-first):
 * the persisted subscription, or the API's `{ plan: 'basic' }` fallback when
 * the user has never subscribed.
 */
export const useUserSubscription = (options?: { enabled?: boolean }) => {
  const account = useBillingAccount(options);
  return useAnswer(subscription, ...(account ?? [skip]));
};

/**
 * The current user's payment / billing history (`GET /payments/user`): its
 * `deposit` and `purchase` transactions, newest first.
 */
export const useUserPayments = (options?: { enabled?: boolean }) => {
  const account = useBillingAccount(options);
  return useAnswer(paymentHistory, ...(account ?? [skip]));
};

/** The current user's FairCoin wallet balance (`GET /wallet/:userId`). */
export const useUserWallet = (options?: { enabled?: boolean }) => {
  const account = useBillingAccount(options);
  return useAnswer(wallet, ...(account ?? [skip]));
};

/**
 * The current user's wallet transaction history (`GET /wallet/transactions/:userId`),
 * as the API's `{ data, pagination }` envelope.
 *
 * @param params - Optional `limit` / `offset`; each page is held on its own.
 */
export const useUserWalletTransactions = (
  params?: { limit?: number; offset?: number },
  options?: { enabled?: boolean },
) => {
  const account = useBillingAccount(options);
  return useAnswer(
    walletTransactions,
    ...(account ? ([...account, params?.limit, params?.offset] as const) : [skip]),
  );
};
