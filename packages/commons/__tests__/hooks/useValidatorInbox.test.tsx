import React from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';
import { useValidatorInbox } from '@/hooks/useValidatorInbox';

const INBOX = [
  {
    id: 'req-1',
    subjectUserId: 'u1',
    actionType: 'real_life_attested',
    payload: { about: 'did:web:oxy.so:u:u1' },
    payloadHash: 'hash-1',
    status: 'pending' as const,
    highValue: true,
    expiresAt: new Date().toISOString(),
  },
];

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe('useValidatorInbox', () => {
  beforeEach(() => {
    __resetOxyState();
  });

  it('calls getValidatorInbox and surfaces the list', async () => {
    const getValidatorInbox = jest.fn(async () => INBOX);
    __setOxyState({ isAuthenticated: true, user: { id: 'me' }, oxyServices: { getValidatorInbox } });

    const { result } = renderHook(() => useValidatorInbox(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(getValidatorInbox).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(INBOX);
  });

  it('does not fetch until a session user id resolves', async () => {
    const getValidatorInbox = jest.fn(async () => INBOX);
    const getCurrentUserId = jest.fn(() => null);
    __setOxyState({
      isAuthenticated: false,
      user: null,
      oxyServices: { getValidatorInbox, getCurrentUserId },
    });

    const { result } = renderHook(() => useValidatorInbox(), { wrapper: makeWrapper() });

    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(getValidatorInbox).not.toHaveBeenCalled();
    expect(result.current.isPending).toBe(true);
  });
});
