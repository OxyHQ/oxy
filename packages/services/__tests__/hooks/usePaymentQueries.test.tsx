/**
 * Tests for the payment / wallet / subscription hooks.
 *
 * The contract each test pins:
 *  - The hook calls the EXACT SDK method it claims to wrap, through
 *    `authenticatedApiCall`, and its answer is the view's `value`.
 *  - The hook reads nothing until there is a signed-in account.
 *  - The read edge cases the SDK's reads share: staleness, the retry rule,
 *    and a late answer after an account switch.
 *
 * `@oxy.so/core`'s `authenticatedApiCall` is mocked to invoke its callback
 * directly so the test exercises hook wiring, not token-refresh internals
 * (those are covered by core's own suite).
 */

import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { DataProvider, setActiveStore, Store } from '@oxy.so/bloom-data';
import type {
  Payment,
  Subscription,
  Wallet,
  WalletTransactionsResponse,
} from '../../src/ui/hooks/queries/paymentTypes';
import {
  useUserPayments,
  useUserSubscription,
  useUserWallet,
  useUserWalletTransactions,
} from '../../src/ui/hooks/queries/usePaymentQueries';

const mockBilling = {
  subscription: jest.fn(),
  payments: jest.fn(),
  wallet: jest.fn(),
  walletTransactions: jest.fn(),
};
const mockSession = {
  user: { id: 'a' } as { id: string } | null,
  isAuthenticated: true,
};
jest.mock('../../src/ui/context/oxyRuntimeContext', () => ({
  useOxy: () => ({
    oxyServices: { billing: mockBilling },
    user: mockSession.user,
    isAuthenticated: mockSession.isAuthenticated,
    activeSessionId: 'session',
  }),
}));
// The token is valid: the read goes straight to the API.
jest.mock('@oxy.so/core', () => ({
  ...jest.requireActual('@oxy.so/core'),
  authenticatedApiCall: (_oxy: unknown, _session: unknown, call: () => Promise<unknown>) => call(),
}));

const SUBSCRIPTION_FIXTURE: Subscription = {
  plan: 'pro',
  status: 'active',
  userId: 'u1',
  startDate: '2026-01-01T00:00:00.000Z',
  endDate: '2026-02-01T00:00:00.000Z',
  autoRenew: true,
  features: {
    analytics: true,
    premiumBadge: true,
    unlimitedFollowing: true,
    higherUploadLimits: true,
    promotedPosts: false,
    businessTools: false,
  },
};

const PAYMENTS_FIXTURE: Payment[] = [
  {
    id: 'p1',
    userId: 'u1',
    type: 'purchase',
    amount: 9.99,
    status: 'completed',
    timestamp: '2026-01-15T12:00:00.000Z',
  },
];

const WALLET_FIXTURE: Wallet = {
  userId: 'u1',
  balance: 42.5,
  address: null,
};

const TRANSACTIONS_FIXTURE: WalletTransactionsResponse = {
  data: [
    {
      id: 't1',
      userId: 'u1',
      type: 'deposit',
      amount: 10,
      status: 'completed',
      timestamp: '2026-01-20T09:00:00.000Z',
    },
  ],
  pagination: { total: 1, limit: 5, offset: 0, hasMore: false },
};

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  setActiveStore(new Store());
  for (const call of Object.values(mockBilling)) call.mockReset();
  mockSession.user = { id: 'a' };
  mockSession.isAuthenticated = true;
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('what each hook reads', () => {
  it('useUserSubscription reads the subscription', async () => {
    mockBilling.subscription.mockResolvedValue(SUBSCRIPTION_FIXTURE);
    const { result } = renderHook(() => useUserSubscription());
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(mockBilling.subscription).toHaveBeenCalledTimes(1);
    expect(result.current.value?.plan).toBe('pro');
    expect(result.current.value?.features?.analytics).toBe(true);
    expect(result.current.value?.endDate).toBe('2026-02-01T00:00:00.000Z');
  });

  it('useUserPayments reads the payment history', async () => {
    mockBilling.payments.mockResolvedValue(PAYMENTS_FIXTURE);
    const { result } = renderHook(() => useUserPayments());
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(mockBilling.payments).toHaveBeenCalledTimes(1);
    expect(result.current.value).toHaveLength(1);
    expect(result.current.value?.[0]?.amount).toBe(9.99);
  });

  it('useUserWallet reads the wallet', async () => {
    mockBilling.wallet.mockResolvedValue(WALLET_FIXTURE);
    const { result } = renderHook(() => useUserWallet());
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(result.current.value?.balance).toBe(42.5);
    expect(result.current.value?.address).toBeNull();
  });

  it('useUserWalletTransactions forwards the page and returns the envelope', async () => {
    mockBilling.walletTransactions.mockResolvedValue(TRANSACTIONS_FIXTURE);
    const { result } = renderHook(() => useUserWalletTransactions({ limit: 5 }));
    await waitFor(() => expect(result.current.status).toBe('success'));
    expect(mockBilling.walletTransactions).toHaveBeenCalledWith({ limit: 5, offset: undefined });
    expect(result.current.value?.data[0]?.type).toBe('deposit');
    expect(result.current.value?.pagination.total).toBe(1);
  });
});

it('reads nothing until there is a signed-in account, or while the caller disables it', async () => {
  mockSession.user = null;
  mockSession.isAuthenticated = false;
  const signedOut = renderHook(() => useUserSubscription());
  mockSession.user = { id: 'a' };
  mockSession.isAuthenticated = true;
  const disabled = renderHook(() => useUserSubscription({ enabled: false }));
  await act(async () => {});

  expect(mockBilling.subscription).not.toHaveBeenCalled();
  expect(signedOut.result.current.isLoading).toBe(false);
  expect(disabled.result.current.value).toBeUndefined();
});

it('returns the answer as the view value', async () => {
  mockBilling.subscription.mockResolvedValue({ plan: 'pro', status: 'active' });
  const { result } = renderHook(() => useUserSubscription());
  expect(result.current.isLoading).toBe(true);

  await waitFor(() => expect(result.current.value?.plan).toBe('pro'));
  expect(result.current.isLoading).toBe(false);
});

it('serves a fresh answer to a new screen, and reads again once it is stale', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
  mockBilling.wallet.mockResolvedValue({ userId: 'a', balance: 5, address: null });
  const first = renderHook(() => useUserWallet());
  await waitFor(() => expect(first.result.current.value?.balance).toBe(5));
  first.unmount();

  now.mockReturnValue(1_000_000 + 59_000);
  const fresh = renderHook(() => useUserWallet());
  await act(async () => {});
  expect(fresh.result.current.value?.balance).toBe(5);
  expect(mockBilling.wallet).toHaveBeenCalledTimes(1);
  fresh.unmount();

  // The wallet is stale after a minute.
  now.mockReturnValue(1_000_000 + 61_000);
  mockBilling.wallet.mockResolvedValue({ userId: 'a', balance: 7, address: null });
  const stale = renderHook(() => useUserWallet());
  expect(stale.result.current.value?.balance).toBe(5);
  await waitFor(() => expect(stale.result.current.value?.balance).toBe(7));
  expect(mockBilling.wallet).toHaveBeenCalledTimes(2);
});

it('retries a server failure, and never a refusal', async () => {
  jest.useFakeTimers();
  mockBilling.subscription
    .mockRejectedValueOnce(httpError(503))
    .mockResolvedValue({ plan: 'basic' });
  const retried = renderHook(() => useUserSubscription());
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1_000);
  });
  expect(retried.result.current.value?.plan).toBe('basic');
  expect(mockBilling.subscription).toHaveBeenCalledTimes(2);

  mockBilling.wallet.mockRejectedValue(httpError(404));
  const refused = renderHook(() => useUserWallet());
  await act(async () => {
    await jest.advanceTimersByTimeAsync(10_000);
  });
  expect(refused.result.current.status).toBe('error');
  expect(mockBilling.wallet).toHaveBeenCalledTimes(1);
});

it('drops an answer that lands after the account was left', async () => {
  const late = deferred<{ plan: string }>();
  mockBilling.subscription.mockReturnValueOnce(late.promise);
  const first = new Store();
  const second = new Store();
  let store = first;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DataProvider store={store}>{children}</DataProvider>
  );
  const { result, rerender } = renderHook(() => useUserSubscription(), { wrapper });
  await act(async () => {});
  expect(mockBilling.subscription).toHaveBeenCalledTimes(1);

  // The person switches account: the first store closes, the second opens.
  mockSession.user = { id: 'b' };
  mockBilling.subscription.mockResolvedValue({ plan: 'business' });
  await act(async () => {
    await first.close();
    store = second;
    rerender();
  });
  await waitFor(() => expect(result.current.value?.plan).toBe('business'));

  await act(async () => {
    late.resolve({ plan: 'pro' });
  });
  expect(result.current.value?.plan).toBe('business');
});

it('keys each ledger page on its own', async () => {
  mockBilling.walletTransactions.mockImplementation(async ({ offset }: { offset?: number }) => ({
    data: [],
    pagination: { total: 40, limit: 20, offset: offset ?? 0, hasMore: true },
  }));
  const first = renderHook(() => useUserWalletTransactions({ limit: 20 }));
  const second = renderHook(() => useUserWalletTransactions({ limit: 20, offset: 20 }));
  await waitFor(() => expect(second.result.current.value?.pagination.offset).toBe(20));
  expect(first.result.current.value?.pagination.offset).toBe(0);
  expect(mockBilling.walletTransactions).toHaveBeenCalledTimes(2);
});
