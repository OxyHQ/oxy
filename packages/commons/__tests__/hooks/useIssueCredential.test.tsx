import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';

const authenticateMock = jest.fn<Promise<{ success: boolean; error?: string }>, [string?]>();
jest.mock('@/lib/biometricAuth', () => ({
  authenticate: (...args: [string?]) => authenticateMock(...args),
}));

// eslint-disable-next-line import/first
import { useIssueCredential } from '@/hooks/useIssueCredential';

const HOLDER_DID = 'did:web:oxy.so:u:holderUser';

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function install(overrides: Record<string, jest.Mock> = {}) {
  const services = {
    issueCredential: jest.fn(async () => ({
      accepted: true,
      credential: {
        id: 'vc1',
        recordId: 'rec1',
        holderUserId: 'holderUser',
        holderDid: HOLDER_DID,
        issuerUserId: 'me',
        issuerDid: 'did:web:oxy.so:u:me',
        types: ['VerifiableCredential', 'EmploymentCredential'],
        claims: { statement: 'Worked here' },
        status: 'active',
        issuedAt: 1_700_000_000_000,
      },
    })),
    ...overrides,
  };
  __setOxyState({ isAuthenticated: true, user: { id: 'me' }, oxyServices: services });
  return services;
}

const PARAMS = {
  types: ['EmploymentCredential'],
  claims: { statement: 'Worked here' },
};

describe('useIssueCredential', () => {
  beforeEach(() => {
    __resetOxyState();
    authenticateMock.mockReset();
  });

  it('signs the credential via issueCredential only AFTER the biometric gate passes', async () => {
    const services = install();
    authenticateMock.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useIssueCredential(HOLDER_DID, 'reason'), {
      wrapper: makeWrapper(),
    });

    await act(async () => {
      await result.current.issue({ ...PARAMS, expiresAt: '2099-01-01T00:00:00.000Z' });
    });

    expect(authenticateMock).toHaveBeenCalledWith('reason');
    expect(services.issueCredential).toHaveBeenCalledWith({
      holderDid: HOLDER_DID,
      types: ['EmploymentCredential'],
      claims: { statement: 'Worked here' },
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    await waitFor(() => expect(result.current.state).toBe('done'));
    expect(result.current.result?.credential.recordId).toBe('rec1');
  });

  it('does NOT submit when the biometric gate fails', async () => {
    const services = install();
    authenticateMock.mockResolvedValue({ success: false, error: 'user_cancel' });
    const { result } = renderHook(() => useIssueCredential(HOLDER_DID, 'reason'), {
      wrapper: makeWrapper(),
    });

    await act(async () => {
      await result.current.issue(PARAMS);
    });

    expect(services.issueCredential).not.toHaveBeenCalled();
    expect(result.current.biometricFailed).toBe(true);
    expect(result.current.state).toBe('idle');
  });

  it('classifies a self-credential rejection into an issue error code', async () => {
    install({
      issueCredential: jest.fn(async () => {
        throw new Error('Credential rejected: self_credential');
      }),
    });
    authenticateMock.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useIssueCredential(HOLDER_DID, 'reason'), {
      wrapper: makeWrapper(),
    });

    await act(async () => {
      await result.current.issue(PARAMS);
    });

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorCode).toBe('self_credential');
  });

  it('classifies an invalid-expiry rejection', async () => {
    install({
      issueCredential: jest.fn(async () => {
        throw new Error('Credential rejected: invalid_expiry');
      }),
    });
    authenticateMock.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useIssueCredential(HOLDER_DID, 'reason'), {
      wrapper: makeWrapper(),
    });

    await act(async () => {
      await result.current.issue(PARAMS);
    });

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorCode).toBe('invalid_expiry');
  });

  it('no-ops (no biometric prompt) when the holder DID is null', async () => {
    const services = install();
    authenticateMock.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useIssueCredential(null, 'reason'), {
      wrapper: makeWrapper(),
    });

    await act(async () => {
      await result.current.issue(PARAMS);
    });

    expect(authenticateMock).not.toHaveBeenCalled();
    expect(services.issueCredential).not.toHaveBeenCalled();
  });
});
