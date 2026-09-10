/**
 * Tests for the payment / wallet / subscription query hooks.
 *
 * These hooks replace the imperative `oxyServices.*` + `useEffect` fetching
 * that app screens (e.g. the accounts `payments` tab) previously hand-rolled.
 *
 * The contract each test pins:
 *  - The hook calls the EXACT SDK method it claims to wrap.
 *  - The resolved data flows through unchanged and is correctly typed.
 *  - The hook is gated on authentication (`enabled` is false when signed out,
 *    so the SDK method is never called).
 *  - `authenticatedApiCall` is the auth wrapper, matching `useUserDevices`.
 *
 * `@oxy.so/core`'s `authenticatedApiCall` is mocked to invoke its callback
 * directly so the test exercises hook wiring, not token-refresh internals
 * (those are covered by core's own suite). `useOxy` is mocked to supply a
 * stub `oxyServices` whose payment methods are jest mocks.
 */

import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  Subscription,
  Payment,
  Wallet,
  WalletTransactionsResponse,
} from '../../src/ui/hooks/queries/paymentTypes';

interface MockOxyServices {
  getCurrentUserSubscription: jest.Mock;
  getUserPayments: jest.Mock;
  getCurrentUserWallet: jest.Mock;
  getCurrentUserWalletTransactions: jest.Mock;
}

interface MockOxyState {
  oxyServices: MockOxyServices;
  isAuthenticated: boolean;
  activeSessionId: string | null;
  // Payment/wallet/subscription queries scope by the ACTIVE account (the
  // account switched into), not the device-session owner.
  user: { id: string } | null;
}

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

const makeServices = (): MockOxyServices => ({
  getCurrentUserSubscription: jest.fn(async () => SUBSCRIPTION_FIXTURE),
  getUserPayments: jest.fn(async () => PAYMENTS_FIXTURE),
  getCurrentUserWallet: jest.fn(async () => WALLET_FIXTURE),
  getCurrentUserWalletTransactions: jest.fn(async () => TRANSACTIONS_FIXTURE),
});

const defaultMockState = (): MockOxyState => ({
  oxyServices: makeServices(),
  isAuthenticated: true,
  activeSessionId: 'sess-1',
  user: { id: 'u1' },
});

let mockState: MockOxyState = defaultMockState();

jest.mock('../../src/ui/context/OxyContext', () => ({
  __esModule: true,
  useOxy: () => mockState,
}));

// Strip the auth/token-refresh layer: run the supplied API call directly so
// the test asserts hook wiring, not core's token machinery.
const authenticatedApiCallMock = jest.fn(
  async <T,>(_svc: unknown, _sid: unknown, apiCall: () => Promise<T>): Promise<T> =>
    apiCall(),
);

jest.mock('@oxy.so/core', () => ({
  __esModule: true,
  authenticatedApiCall: (
    svc: unknown,
    sid: unknown,
    apiCall: () => Promise<unknown>,
  ) => authenticatedApiCallMock(svc, sid, apiCall),
}));

import {
  useUserSubscription,
  useUserPayments,
  useUserWallet,
  useUserWalletTransactions,
} from '../../src/ui/hooks/queries/usePaymentQueries';
import { queryKeys } from '../../src/ui/hooks/queries/queryKeys';

const makeWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

describe('payment query hooks', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    mockState = defaultMockState();
    authenticatedApiCallMock.mockClear();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
        mutations: { retry: false },
      },
    });
  });

  afterEach(() => {
    queryClient.clear();
  });

  describe('useUserSubscription', () => {
    it('calls getCurrentUserSubscription and returns the typed subscription', async () => {
      const { result } = renderHook(() => useUserSubscription(), {
        wrapper: makeWrapper(queryClient),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockState.oxyServices.getCurrentUserSubscription).toHaveBeenCalledTimes(1);
      expect(authenticatedApiCallMock).toHaveBeenCalled();

      const data = result.current.data;
      expect(data?.plan).toBe('pro');
      expect(data?.features?.analytics).toBe(true);
      expect(data?.endDate).toBe('2026-02-01T00:00:00.000Z');
    });

    it('does not call the SDK when unauthenticated', () => {
      mockState.isAuthenticated = false;

      const { result } = renderHook(() => useUserSubscription(), {
        wrapper: makeWrapper(queryClient),
      });

      expect(result.current.fetchStatus).toBe('idle');
      expect(mockState.oxyServices.getCurrentUserSubscription).not.toHaveBeenCalled();
    });

    it('honours an explicit enabled: false override even when authenticated', () => {
      const { result } = renderHook(() => useUserSubscription({ enabled: false }), {
        wrapper: makeWrapper(queryClient),
      });

      expect(result.current.fetchStatus).toBe('idle');
      expect(mockState.oxyServices.getCurrentUserSubscription).not.toHaveBeenCalled();
    });

    it('does not call the SDK without a scoped active account id', () => {
      mockState.user = null;

      const { result } = renderHook(() => useUserSubscription(), {
        wrapper: makeWrapper(queryClient),
      });

      expect(result.current.fetchStatus).toBe('idle');
      expect(mockState.oxyServices.getCurrentUserSubscription).not.toHaveBeenCalled();
    });
  });

  describe('useUserPayments', () => {
    it('calls getUserPayments and returns the typed payment array', async () => {
      const { result } = renderHook(() => useUserPayments(), {
        wrapper: makeWrapper(queryClient),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockState.oxyServices.getUserPayments).toHaveBeenCalledTimes(1);
      expect(result.current.data).toHaveLength(1);
      expect(result.current.data?.[0]?.amount).toBe(9.99);
      expect(result.current.data?.[0]?.status).toBe('completed');
    });
  });

  describe('useUserWallet', () => {
    it('calls getCurrentUserWallet and returns the typed wallet', async () => {
      const { result } = renderHook(() => useUserWallet(), {
        wrapper: makeWrapper(queryClient),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockState.oxyServices.getCurrentUserWallet).toHaveBeenCalledTimes(1);
      expect(result.current.data?.balance).toBe(42.5);
      expect(result.current.data?.address).toBeNull();
    });
  });

  describe('useUserWalletTransactions', () => {
    it('forwards pagination params and returns the paginated envelope', async () => {
      const { result } = renderHook(
        () => useUserWalletTransactions({ limit: 5 }),
        { wrapper: makeWrapper(queryClient) },
      );

      await waitFor(() => expect(result.current.isSuccess).toBe(true));

      expect(mockState.oxyServices.getCurrentUserWalletTransactions).toHaveBeenCalledWith({
        limit: 5,
        offset: undefined,
      });
      expect(result.current.data?.data).toHaveLength(1);
      expect(result.current.data?.data[0]?.type).toBe('deposit');
      expect(result.current.data?.pagination.total).toBe(1);
    });

    it('caches distinct pages under distinct query keys', async () => {
      const first = renderHook(
        () => useUserWalletTransactions({ limit: 5, offset: 0 }),
        { wrapper: makeWrapper(queryClient) },
      );
      const second = renderHook(
        () => useUserWalletTransactions({ limit: 5, offset: 5 }),
        { wrapper: makeWrapper(queryClient) },
      );

      await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
      await waitFor(() => expect(second.result.current.isSuccess).toBe(true));

      // Two distinct offsets => two independent fetches.
      expect(mockState.oxyServices.getCurrentUserWalletTransactions).toHaveBeenCalledTimes(2);
    });
  });

  it('scopes payment query keys by the active account id', async () => {
    const { result: firstResult } = renderHook(() => useUserWallet(), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(firstResult.current.isSuccess).toBe(true));

    const firstServices = mockState.oxyServices;
    const secondWallet: Wallet = { userId: 'u2', balance: 7, address: null };
    mockState = {
      oxyServices: {
        ...makeServices(),
        getCurrentUserWallet: jest.fn(async () => secondWallet),
      },
      isAuthenticated: true,
      activeSessionId: 'sess-2',
      user: { id: 'u2' },
    };

    const { result: secondResult } = renderHook(() => useUserWallet(), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(secondResult.current.isSuccess).toBe(true));

    expect(firstServices.getCurrentUserWallet).toHaveBeenCalledTimes(1);
    expect(mockState.oxyServices.getCurrentUserWallet).toHaveBeenCalledTimes(1);
    expect(secondResult.current.data?.userId).toBe('u2');
    expect(queryClient.getQueryData(queryKeys.payments.wallet('u1'))).toEqual(WALLET_FIXTURE);
    expect(queryClient.getQueryData(queryKeys.payments.wallet('u2'))).toEqual(secondWallet);
  });
});
