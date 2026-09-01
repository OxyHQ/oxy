/**
 * The reputation screen renders `breakdown`, `influence` and `reliability`, and
 * the API serves those ONLY to the balance's own subject. So the one thing
 * these tests pin is that the hook reads the SIGNED-IN user's balance and never
 * asks for one by id — `getReputationBalance(someId)` would still compile at the
 * call site (it returns the public-view union) and would come back stripped for
 * anybody but yourself.
 */

import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReputationBalance } from '@oxyhq/contracts';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxyhq-services';
import { useCivicReputation, useReputationSources } from '@/hooks/useCivicReputation';

const BALANCE: ReputationBalance = {
  userId: 'me',
  total: 120,
  positive: 150,
  negative: -30,
  breakdown: { content: 80, social: 40, trust: 0, moderation: 0, physical: 0, penalties: 30 },
  trustTier: 'trusted',
  influence: {
    defaultWeight: 1,
    reportWeight: 1,
    moderationWeight: 1,
    rankingFeedbackWeight: 0.8,
  },
  reliability: {
    accurateReports: 2,
    rejectedReports: 0,
    reportAccuracyScore: 1,
    abuseScore: 0,
  },
  recalculatedAt: '2026-06-16T00:00:00.000Z',
  updatedAt: '2026-06-16T00:00:00.000Z',
};

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useCivicReputation', () => {
  beforeEach(() => {
    __resetOxyState();
  });

  it('reads the signed-in user own balance, never one by id', async () => {
    const getMyReputationBalance = jest.fn(async () => BALANCE);
    const getReputationBalance = jest.fn(async () => BALANCE);
    __setOxyState({
      isAuthenticated: true,
      user: { id: 'me' },
      oxyServices: { getMyReputationBalance, getReputationBalance },
    });

    const { result } = renderHook(() => useCivicReputation('me'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMyReputationBalance).toHaveBeenCalledTimes(1);
    expect(getMyReputationBalance).toHaveBeenCalledWith();
    // The subject-only fields the screen depends on survive the round trip.
    expect(result.current.data?.reliability.reportAccuracyScore).toBe(1);
    expect(getReputationBalance).not.toHaveBeenCalled();
  });

  it('is disabled (never fetches) when there is no user id', () => {
    const getMyReputationBalance = jest.fn(async () => BALANCE);
    __setOxyState({ oxyServices: { getMyReputationBalance } });

    const { result } = renderHook(() => useCivicReputation(null), { wrapper: makeWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getMyReputationBalance).not.toHaveBeenCalled();
  });

  it('derives the four sources from the balance breakdown', () => {
    const { result } = renderHook(() => useReputationSources(BALANCE));

    expect(result.current?.map((source) => source.key)).toEqual([
      'realLife',
      'peerCivic',
      'apps',
      'penalties',
    ]);
  });
});
