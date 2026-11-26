/**
 * The signed-in account's billing: its subscription, payment history, wallet,
 * wallet ledger and personal-plan subscriptions, plus the public personal-plan
 * catalogue. Each is one answer per account (`data/answer.ts`), held in that
 * account's store and in memory only.
 *
 * Every private read goes through `authenticatedApiCall`, so a stale token is
 * refreshed first and auth errors are handled as everywhere else in the SDK.
 */
import { authenticatedApiCall, type OxyServices } from '@oxy.so/core';
import type {
  Subscription,
  Payment,
  Wallet,
  WalletTransactionsResponse,
} from '../hooks/queries/paymentTypes';
import { answerSource } from './answer';
import { sdkRead } from './readOptions';

const MINUTE = 60_000;

/** The account and session a private read is made for. */
const accountKey = (_oxy: OxyServices, accountId: string, sessionId: string | null) =>
  `${accountId}:${sessionId ?? ''}`;

export const subscription = answerSource('oxy.billing.subscription', {
  ...sdkRead,
  key: accountKey,
  load: (_request, oxy: OxyServices, _accountId: string, sessionId: string | null) =>
    authenticatedApiCall<Subscription>(oxy, sessionId, () => oxy.billing.subscription()),
  // Subscription state changes rarely.
  stale: 5 * MINUTE,
  gcTime: 30 * MINUTE,
});

export const paymentHistory = answerSource('oxy.billing.payments', {
  ...sdkRead,
  key: accountKey,
  load: (_request, oxy: OxyServices, _accountId: string, sessionId: string | null) =>
    authenticatedApiCall<Payment[]>(oxy, sessionId, () => oxy.billing.payments()),
  // Billing history is append-mostly.
  stale: 2 * MINUTE,
  gcTime: 30 * MINUTE,
});

export const wallet = answerSource('oxy.billing.wallet', {
  ...sdkRead,
  key: accountKey,
  load: (_request, oxy: OxyServices, _accountId: string, sessionId: string | null) =>
    authenticatedApiCall<Wallet>(oxy, sessionId, () => oxy.billing.wallet()),
  // The balance moves often.
  stale: MINUTE,
  gcTime: 10 * MINUTE,
});

/** One page of the wallet ledger (`limit`/`offset`); each page is held on its own. */
export const walletTransactions = answerSource('oxy.billing.wallet-transactions', {
  ...sdkRead,
  key: (
    oxy: OxyServices,
    accountId: string,
    sessionId: string | null,
    limit: number | undefined,
    offset: number | undefined,
  ) => `${accountKey(oxy, accountId, sessionId)}:${limit ?? ''}:${offset ?? ''}`,
  load: (_request, oxy, _accountId, sessionId, limit, offset) =>
    authenticatedApiCall<WalletTransactionsResponse>(oxy, sessionId, () =>
      oxy.billing.walletTransactions({ limit, offset }),
    ),
  // The ledger updates often.
  stale: MINUTE,
  gcTime: 10 * MINUTE,
});

/** The public personal-plan catalogue. */
export const personalPlans = answerSource('oxy.billing.personal-plans', {
  ...sdkRead,
  key: (_oxy: OxyServices) => 'catalogue',
  load: (_request, oxy) => oxy.billing.personalPlans(),
  stale: 0,
  gcTime: 30 * MINUTE,
});

/**
 * The account's personal-plan subscriptions. The server is told which account
 * the answer must be for (an expected-subject fence), and nothing is kept once
 * no screen shows it.
 */
export const personalPlanSubscriptions = answerSource('oxy.billing.personal-plan-subscriptions', {
  ...sdkRead,
  key: accountKey,
  load: (_request, oxy: OxyServices, accountId: string, sessionId: string | null) =>
    authenticatedApiCall(oxy, sessionId, () => oxy.billing.productSubscriptions(accountId)),
  stale: 0,
  gcTime: 0,
});
