import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';

const authenticateMock = jest.fn<Promise<{ success: boolean; error?: string }>, [string?]>();
jest.mock('@/lib/biometricAuth', () => ({
  authenticate: (...args: [string?]) => authenticateMock(...args),
}));

// eslint-disable-next-line import/first
import { useVouch } from '@/hooks/useVouch';

const SUBJECT_DID = 'did:web:oxy.so:u:subjectUser';
const SUBJECT_USER_ID = 'subjectUser';

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function install(overrides: Record<string, jest.Mock> = {}) {
  const services = {
    vouchForPerson: jest.fn(async () => ({
      accepted: true,
      recordId: 'rec-1',
      subjectUserId: SUBJECT_USER_ID,
      voucherUserId: 'me',
      stakeAmount: 10,
      points: 40,
    })),
    withdrawVouch: jest.fn(async () => ({ withdrawn: true })),
    ...overrides,
  };
  __setOxyState({ isAuthenticated: true, user: { id: 'me' }, oxyServices: services });
  return services;
}

describe('useVouch', () => {
  beforeEach(() => {
    __resetOxyState();
    authenticateMock.mockReset();
  });

  it('signs the vouch via vouchForPerson only AFTER the biometric gate passes', async () => {
    const services = install();
    authenticateMock.mockResolvedValue({ success: true });
    const { result } = renderHook(
      () => useVouch(SUBJECT_DID, SUBJECT_USER_ID, 'reason'),
      { wrapper: makeWrapper() },
    );

    await act(async () => {
      await result.current.vouch(10);
    });

    expect(authenticateMock).toHaveBeenCalledWith('reason');
    expect(services.vouchForPerson).toHaveBeenCalledWith({
      subjectDid: SUBJECT_DID,
      stakeAmount: 10,
      biometricOk: true,
    });
    await waitFor(() => expect(result.current.state).toBe('done'));
    expect(result.current.result?.points).toBe(40);
    expect(result.current.result?.stakeAmount).toBe(10);
  });

  it('does NOT submit when the biometric gate fails', async () => {
    const services = install();
    authenticateMock.mockResolvedValue({ success: false, error: 'user_cancel' });
    const { result } = renderHook(
      () => useVouch(SUBJECT_DID, SUBJECT_USER_ID, 'reason'),
      { wrapper: makeWrapper() },
    );

    await act(async () => {
      await result.current.vouch(10);
    });

    expect(services.vouchForPerson).not.toHaveBeenCalled();
    expect(result.current.biometricFailed).toBe(true);
    expect(result.current.state).toBe('idle');
  });

  it('classifies a server rejection into a vouch error code', async () => {
    install({
      vouchForPerson: jest.fn(async () => {
        throw new Error('Vouch rejected: already_vouched');
      }),
    });
    authenticateMock.mockResolvedValue({ success: true });
    const { result } = renderHook(
      () => useVouch(SUBJECT_DID, SUBJECT_USER_ID, 'reason'),
      { wrapper: makeWrapper() },
    );

    await act(async () => {
      await result.current.vouch();
    });

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorCode).toBe('already_vouched');
  });

  it('withdraws via withdrawVouch WITHOUT a biometric gate', async () => {
    const services = install();
    const { result } = renderHook(
      () => useVouch(SUBJECT_DID, SUBJECT_USER_ID, 'reason'),
      { wrapper: makeWrapper() },
    );

    await act(async () => {
      await result.current.withdraw();
    });

    expect(authenticateMock).not.toHaveBeenCalled();
    expect(services.withdrawVouch).toHaveBeenCalledWith(SUBJECT_USER_ID);
    await waitFor(() => expect(result.current.state).toBe('withdrawn'));
  });
});
