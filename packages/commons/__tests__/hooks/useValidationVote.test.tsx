import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';

const authenticateMock = jest.fn<Promise<{ success: boolean; error?: string }>, [string?]>();
jest.mock('@/lib/biometricAuth', () => ({
  authenticate: (...args: [string?]) => authenticateMock(...args),
}));

// eslint-disable-next-line import/first
import { useValidationVote } from '@/hooks/useValidationVote';

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function install(overrides: Record<string, jest.Mock> = {}) {
  const services = {
    submitValidationVote: jest.fn(async () => ({
      recorded: true,
      requestId: 'req-1',
      verdict: 'valid',
      status: 'pending',
    })),
    denyValidation: jest.fn(async () => ({ denied: true })),
    ...overrides,
  };
  __setOxyState({ isAuthenticated: true, user: { id: 'me' }, oxyServices: services });
  return services;
}

describe('useValidationVote', () => {
  beforeEach(() => {
    __resetOxyState();
    authenticateMock.mockReset();
  });

  it('signs a verdict via submitValidationVote only after biometric passes', async () => {
    const services = install();
    authenticateMock.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useValidationVote('req-1', 'hash-1', 'reason'), {
      wrapper: makeWrapper(),
    });

    await act(async () => {
      await result.current.vote('valid');
    });

    expect(authenticateMock).toHaveBeenCalledWith('reason');
    expect(services.submitValidationVote).toHaveBeenCalledWith('req-1', 'hash-1', 'valid');
    await waitFor(() => expect(result.current.state).toBe('done'));
  });

  it('does NOT submit a verdict when the biometric gate fails', async () => {
    const services = install();
    authenticateMock.mockResolvedValue({ success: false });
    const { result } = renderHook(() => useValidationVote('req-1', 'hash-1', 'reason'), {
      wrapper: makeWrapper(),
    });

    await act(async () => {
      await result.current.vote('invalid');
    });

    expect(services.submitValidationVote).not.toHaveBeenCalled();
    expect(result.current.biometricFailed).toBe(true);
  });

  it('recuses via denyValidation WITHOUT a biometric gate', async () => {
    const services = install();
    const { result } = renderHook(() => useValidationVote('req-1', 'hash-1', 'reason'), {
      wrapper: makeWrapper(),
    });

    await act(async () => {
      await result.current.deny();
    });

    expect(authenticateMock).not.toHaveBeenCalled();
    expect(services.denyValidation).toHaveBeenCalledWith('req-1');
    await waitFor(() => expect(result.current.state).toBe('done'));
  });

  it('classifies a vote rejection into an error code', async () => {
    install({
      submitValidationVote: jest.fn(async () => {
        throw new Error('Vote rejected: already_voted');
      }),
    });
    authenticateMock.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useValidationVote('req-1', 'hash-1', 'reason'), {
      wrapper: makeWrapper(),
    });

    await act(async () => {
      await result.current.vote('valid');
    });

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorCode).toBe('already_voted');
  });
});
