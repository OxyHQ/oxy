import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PersonhoodStatusResult } from '@oxy.so/contracts';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';
import { usePersonhood, useMyPersonhood } from '@/hooks/usePersonhood';

/** A personhood snapshot with the verified verdict + score flipped per test. */
function makeStatus(
  userId: string,
  overrides: Partial<PersonhoodStatusResult> = {},
): PersonhoodStatusResult {
  return {
    userId,
    score: 0.72,
    isRealPerson: true,
    vouchCount: 3,
    realLifeCount: 2,
    biometricBound: true,
    sybilPenalty: 0,
    breakdown: {
      vouchSignal: 0.6,
      realLifeSignal: 0.5,
      biometricSignal: 1,
      evidence: 0.72,
      sybilPenalty: 0,
      seed: false,
    },
    updatedAt: '2026-06-27T00:00:00.000Z',
    ...overrides,
  };
}

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('usePersonhood', () => {
  beforeEach(() => {
    __resetOxyState();
  });

  it('resolves a subject personhood snapshot from getPersonhood', async () => {
    const getPersonhood = jest.fn(async () => makeStatus('u1'));
    __setOxyState({ isAuthenticated: true, user: { id: 'me' }, oxyServices: { getPersonhood } });

    const { result } = renderHook(() => usePersonhood('u1'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getPersonhood).toHaveBeenCalledWith('u1');
    expect(result.current.data?.isRealPerson).toBe(true);
    expect(result.current.data?.vouchCount).toBe(3);
    expect(result.current.data?.score).toBeCloseTo(0.72);
  });

  it('surfaces a building (not-yet-verified) snapshot without erroring', async () => {
    const getPersonhood = jest.fn(async () =>
      makeStatus('u1', { score: 0.2, isRealPerson: false, vouchCount: 0, realLifeCount: 0, biometricBound: false, breakdown: null, updatedAt: null }),
    );
    __setOxyState({ oxyServices: { getPersonhood } });

    const { result } = renderHook(() => usePersonhood('u1'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.isRealPerson).toBe(false);
    expect(result.current.data?.breakdown).toBeNull();
    expect(result.current.isError).toBe(false);
  });

  it('is disabled (never fetches) when the userId could not be resolved', () => {
    const getPersonhood = jest.fn(async () => makeStatus('u1'));
    __setOxyState({ oxyServices: { getPersonhood } });

    const { result } = renderHook(() => usePersonhood(null), { wrapper: makeWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getPersonhood).not.toHaveBeenCalled();
  });
});

describe('useMyPersonhood', () => {
  beforeEach(() => {
    __resetOxyState();
  });

  it('reads the current user status via getMyPersonhood', async () => {
    const getMyPersonhood = jest.fn(async () => makeStatus('me'));
    __setOxyState({ isAuthenticated: true, user: { id: 'me' }, oxyServices: { getMyPersonhood } });

    const { result } = renderHook(() => useMyPersonhood(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getMyPersonhood).toHaveBeenCalledTimes(1);
    expect(result.current.data?.userId).toBe('me');
    expect(result.current.data?.isRealPerson).toBe(true);
  });

  it('is disabled until a current user id is known', () => {
    const getMyPersonhood = jest.fn(async () => makeStatus('me'));
    const getCurrentUserId = jest.fn(() => null);
    __setOxyState({ user: null, oxyServices: { getMyPersonhood, getCurrentUserId } });

    const { result } = renderHook(() => useMyPersonhood(), { wrapper: makeWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getMyPersonhood).not.toHaveBeenCalled();
  });
});
