import { act, renderHook, waitFor } from '@testing-library/react';
import type { CredentialVerifyResult, VerifiableCredentialResponse } from '@oxy.so/contracts';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';
import { useVerifyCredential } from '@/hooks/useVerifyCredential';

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

describe('useVerifyCredential', () => {
  beforeEach(() => {
    __resetOxyState();
  });

  it('renders a VALID verdict when the credential verifies', async () => {
    const result: CredentialVerifyResult = { valid: true, credential: makeCredential() };
    const verifyCredential = jest.fn(async () => result);
    __setOxyState({ oxyServices: { verifyCredential } });

    const { result: hook } = renderHook(() => useVerifyCredential('rec1'));

    await act(async () => {
      await hook.current.verify();
    });

    expect(verifyCredential).toHaveBeenCalledWith('rec1');
    await waitFor(() => expect(hook.current.state).toBe('valid'));
    expect(hook.current.result?.valid).toBe(true);
    expect(hook.current.reasonCode).toBeNull();
  });

  it('renders an INVALID verdict and classifies the reason', async () => {
    const result: CredentialVerifyResult = {
      valid: false,
      reason: 'revoked',
      credential: makeCredential({ status: 'revoked' }),
    };
    __setOxyState({ oxyServices: { verifyCredential: jest.fn(async () => result) } });

    const { result: hook } = renderHook(() => useVerifyCredential('rec1'));

    await act(async () => {
      await hook.current.verify();
    });

    await waitFor(() => expect(hook.current.state).toBe('invalid'));
    expect(hook.current.reasonCode).toBe('revoked');
  });

  it('maps issuer_key_not_current to its own reason code', async () => {
    const result: CredentialVerifyResult = {
      valid: false,
      reason: 'issuer_key_not_current',
      credential: makeCredential(),
    };
    __setOxyState({ oxyServices: { verifyCredential: jest.fn(async () => result) } });

    const { result: hook } = renderHook(() => useVerifyCredential('rec1'));

    await act(async () => {
      await hook.current.verify();
    });

    await waitFor(() => expect(hook.current.state).toBe('invalid'));
    expect(hook.current.reasonCode).toBe('issuer_key_not_current');
  });

  it('surfaces a transport failure as the error state', async () => {
    __setOxyState({
      oxyServices: {
        verifyCredential: jest.fn(async () => {
          throw new Error('Network request failed');
        }),
      },
    });

    const { result: hook } = renderHook(() => useVerifyCredential('rec1'));

    await act(async () => {
      await hook.current.verify();
    });

    await waitFor(() => expect(hook.current.state).toBe('error'));
  });

  it('no-ops when there is no record id', async () => {
    const verifyCredential = jest.fn(async () => ({ valid: true, credential: makeCredential() }));
    __setOxyState({ oxyServices: { verifyCredential } });

    const { result: hook } = renderHook(() => useVerifyCredential(null));

    await act(async () => {
      await hook.current.verify();
    });

    expect(verifyCredential).not.toHaveBeenCalled();
    expect(hook.current.state).toBe('idle');
  });
});
