import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CredentialListResult, VerifiableCredentialResponse } from '@oxy.so/contracts';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';
import { useCredentials, useMyCredentials } from '@/hooks/useCredentials';

function makeCredential(
  overrides: Partial<VerifiableCredentialResponse> = {},
): VerifiableCredentialResponse {
  return {
    id: 'vc1',
    recordId: 'rec1',
    holderUserId: 'me',
    holderDid: 'did:web:oxy.so:u:me',
    issuerUserId: 'issuer',
    issuerDid: 'did:web:oxy.so:u:issuer',
    types: ['VerifiableCredential', 'EmploymentCredential'],
    claims: { statement: 'Worked here' },
    status: 'active',
    issuedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeList(...credentials: VerifiableCredentialResponse[]): CredentialListResult {
  return { credentials };
}

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useCredentials', () => {
  beforeEach(() => {
    __resetOxyState();
  });

  it('renders a holder credential list from listCredentials', async () => {
    const listCredentials = jest.fn(async () => makeList(makeCredential(), makeCredential({ recordId: 'rec2' })));
    __setOxyState({ isAuthenticated: true, user: { id: 'me' }, oxyServices: { listCredentials } });

    const { result } = renderHook(() => useCredentials('holder-1'), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listCredentials).toHaveBeenCalledWith('holder-1', {});
    expect(result.current.data?.credentials).toHaveLength(2);
    expect(result.current.data?.credentials[0].recordId).toBe('rec1');
  });

  it('passes a status filter through to the SDK', async () => {
    const listCredentials = jest.fn(async () => makeList(makeCredential({ status: 'revoked' })));
    __setOxyState({ oxyServices: { listCredentials } });

    const { result } = renderHook(() => useCredentials('holder-1', { status: 'revoked' }), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listCredentials).toHaveBeenCalledWith('holder-1', { status: 'revoked' });
  });

  it('is disabled (never fetches) when the holder id is null', () => {
    const listCredentials = jest.fn(async () => makeList());
    __setOxyState({ oxyServices: { listCredentials } });

    const { result } = renderHook(() => useCredentials(null), { wrapper: makeWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(listCredentials).not.toHaveBeenCalled();
  });
});

describe('useMyCredentials', () => {
  beforeEach(() => {
    __resetOxyState();
  });

  it('reads the current user list via listMyCredentials', async () => {
    const listMyCredentials = jest.fn(async () => makeList(makeCredential()));
    __setOxyState({ isAuthenticated: true, user: { id: 'me' }, oxyServices: { listMyCredentials } });

    const { result } = renderHook(() => useMyCredentials(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listMyCredentials).toHaveBeenCalledTimes(1);
    expect(result.current.data?.credentials[0].holderUserId).toBe('me');
  });

  it('is disabled until a current user id is known', () => {
    const listMyCredentials = jest.fn(async () => makeList());
    const getCurrentUserId = jest.fn(() => null);
    __setOxyState({ user: null, oxyServices: { listMyCredentials, getCurrentUserId } });

    const { result } = renderHook(() => useMyCredentials(), { wrapper: makeWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(listMyCredentials).not.toHaveBeenCalled();
  });
});
