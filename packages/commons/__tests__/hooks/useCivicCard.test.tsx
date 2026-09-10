import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CivicCardResult } from '@oxy.so/core';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';
import { useCivicCard } from '@/hooks/useCivicCard';

/** A signed public card with the client-side verdict flipped per test. */
function makeCard(verified: boolean): CivicCardResult {
  return {
    card: {
      did: 'did:web:oxy.so:u:u1',
      userId: 'u1',
      name: 'Nate Isern',
      username: 'nate',
      trustTier: 'trusted',
      personhoodStatus: 'unverified',
      verifiedDomains: [],
      credentialBadges: [],
      issuedAt: 1,
    },
    attestation: null,
    verified,
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

describe('useCivicCard', () => {
  beforeEach(() => {
    __resetOxyState();
  });

  it('surfaces a VERIFIED card from getPublicCard', async () => {
    const getPublicCard = jest.fn(async () => makeCard(true));
    __setOxyState({ isAuthenticated: true, user: { id: 'me' }, oxyServices: { getPublicCard } });

    const { result } = renderHook(() => useCivicCard('u1'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getPublicCard).toHaveBeenCalledWith('u1');
    expect(result.current.data?.verified).toBe(true);
    expect(result.current.data?.card.name).toBe('Nate Isern');
    expect(result.current.data?.card.trustTier).toBe('trusted');
  });

  it('surfaces an UNVERIFIED card without rejecting (renders as untrusted)', async () => {
    const getPublicCard = jest.fn(async () => makeCard(false));
    __setOxyState({ oxyServices: { getPublicCard } });

    const { result } = renderHook(() => useCivicCard('u1'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.verified).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  it('is disabled (never fetches) when the DID could not be resolved to a userId', () => {
    const getPublicCard = jest.fn(async () => makeCard(true));
    __setOxyState({ oxyServices: { getPublicCard } });

    const { result } = renderHook(() => useCivicCard(null), { wrapper: makeWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getPublicCard).not.toHaveBeenCalled();
  });
});
