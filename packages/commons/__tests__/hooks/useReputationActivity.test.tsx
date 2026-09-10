import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';
import { useReputationActivity, RECENT_ACTIVITY_LIMIT } from '@/hooks/useReputationActivity';

const TRANSACTIONS = [
  {
    id: 'txn-1',
    userId: 'me',
    points: 25,
    actionType: 'real_life_attested',
    category: 'physical' as const,
    status: 'active' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useReputationActivity', () => {
  beforeEach(() => {
    __resetOxyState();
  });

  it('calls getReputationTransactions with the recent-activity limit and surfaces the list', async () => {
    const getReputationTransactions = jest.fn(async () => TRANSACTIONS);
    __setOxyState({
      isAuthenticated: true,
      user: { id: 'me' },
      oxyServices: { getReputationTransactions },
    });

    const { result } = renderHook(() => useReputationActivity('me'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getReputationTransactions).toHaveBeenCalledTimes(1);
    expect(getReputationTransactions).toHaveBeenCalledWith('me', RECENT_ACTIVITY_LIMIT);
    expect(result.current.data).toEqual(TRANSACTIONS);
  });

  it('is disabled (never fetches) when there is no user id', async () => {
    const getReputationTransactions = jest.fn(async () => TRANSACTIONS);
    __setOxyState({ oxyServices: { getReputationTransactions } });

    const { result } = renderHook(() => useReputationActivity(null), { wrapper: makeWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getReputationTransactions).not.toHaveBeenCalled();
  });
});
