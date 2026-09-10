import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { VerifiableCredentialResponse } from '@oxy.so/contracts';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';

const authenticateMock = jest.fn<Promise<{ success: boolean; error?: string }>, [string?]>();
jest.mock('@/lib/biometricAuth', () => ({
  authenticate: (...args: [string?]) => authenticateMock(...args),
}));

// eslint-disable-next-line import/first
import { useRevokeCredential } from '@/hooks/useRevokeCredential';
// eslint-disable-next-line import/first
import { canRevokeCredential } from '@/lib/civic/credential-display';

function makeCredential(
  overrides: Partial<VerifiableCredentialResponse> = {},
): VerifiableCredentialResponse {
  return {
    id: 'vc1',
    recordId: 'rec1',
    holderUserId: 'holderUser',
    holderDid: 'did:web:oxy.so:u:holderUser',
    issuerUserId: 'me',
    issuerDid: 'did:web:oxy.so:u:me',
    types: ['VerifiableCredential', 'EmploymentCredential'],
    claims: { statement: 'Worked here' },
    status: 'active',
    issuedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

function install(overrides: Record<string, jest.Mock> = {}) {
  const services = {
    revokeCredential: jest.fn(async () => ({
      revoked: true,
      credential: makeCredential({ status: 'revoked', revokedAt: 1_700_000_100_000 }),
    })),
    ...overrides,
  };
  __setOxyState({ isAuthenticated: true, user: { id: 'me' }, oxyServices: services });
  return services;
}

describe('useRevokeCredential', () => {
  beforeEach(() => {
    __resetOxyState();
    authenticateMock.mockReset();
  });

  it('revokes via revokeCredential only AFTER the biometric gate passes', async () => {
    const services = install();
    authenticateMock.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useRevokeCredential('reason'), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.revoke(makeCredential());
    });

    expect(authenticateMock).toHaveBeenCalledWith('reason');
    expect(services.revokeCredential).toHaveBeenCalledWith('vc1');
    await waitFor(() => expect(result.current.state).toBe('done'));
    expect(result.current.result?.credential.status).toBe('revoked');
  });

  it('does NOT revoke when the biometric gate fails', async () => {
    const services = install();
    authenticateMock.mockResolvedValue({ success: false, error: 'user_cancel' });
    const { result } = renderHook(() => useRevokeCredential('reason'), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.revoke(makeCredential());
    });

    expect(services.revokeCredential).not.toHaveBeenCalled();
    expect(result.current.biometricFailed).toBe(true);
    expect(result.current.state).toBe('idle');
  });

  it('classifies a non-issuer rejection into a revoke error code', async () => {
    install({
      revokeCredential: jest.fn(async () => {
        throw new Error('Only the original issuer may revoke this credential');
      }),
    });
    authenticateMock.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useRevokeCredential('reason'), { wrapper: makeWrapper() });

    await act(async () => {
      await result.current.revoke(makeCredential());
    });

    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.errorCode).toBe('not_issuer');
  });

  // The revoke action is only OFFERED by the detail screen when the viewer is the
  // original issuer of an active credential — encoded in `canRevokeCredential`,
  // which the screen gates the button on.
  it('is offered only to the original issuer of an active credential', () => {
    expect(canRevokeCredential(makeCredential(), 'me')).toBe(true);
    expect(canRevokeCredential(makeCredential(), 'holderUser')).toBe(false);
    expect(canRevokeCredential(makeCredential({ status: 'revoked' }), 'me')).toBe(false);
  });
});
