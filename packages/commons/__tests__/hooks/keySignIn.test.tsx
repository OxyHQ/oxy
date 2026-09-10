import { renderHook, act } from '@testing-library/react';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';
import { __resetAsyncStorage, __seedAsyncStorage } from '@/__mocks__/async-storage';

// Spy on the biometric gate primitives so we can assert whether the gate ran.
const authenticate = jest.fn(async () => ({ success: true }));
const canUseBiometrics = jest.fn(async () => true);
jest.mock('@/lib/biometricAuth', () => ({
  authenticate: (reason?: string) => authenticate(reason),
  canUseBiometrics: () => canUseBiometrics(),
  getErrorMessage: () => 'Biometric error',
}));

// The silent core resolves the public key from KeyManager when none is passed.
const getPublicKeyMock = jest.fn(async () => 'resolved-pubkey');
jest.mock('@oxy.so/core', () => {
  const actual = jest.requireActual('@oxy.so/core');
  return {
    ...actual,
    KeyManager: { ...actual.KeyManager, getPublicKey: () => getPublicKeyMock() },
  };
});

// eslint-disable-next-line import/first
import { useSilentKeySignIn } from '@/hooks/useSilentKeySignIn';
// eslint-disable-next-line import/first
import { useBiometricSignIn } from '@/hooks/useBiometricSignIn';

const sdkSignIn = jest.fn(async () => ({ id: 'me' }));

describe('key sign-in — silent core vs biometric-gated wrapper', () => {
  beforeEach(() => {
    __resetAsyncStorage();
    __resetOxyState();
    sdkSignIn.mockClear().mockResolvedValue({ id: 'me' });
    __setOxyState({ signIn: sdkSignIn });
    authenticate.mockClear().mockResolvedValue({ success: true });
    canUseBiometrics.mockClear().mockResolvedValue(true);
    getPublicKeyMock.mockClear().mockResolvedValue('resolved-pubkey');
  });

  describe('useSilentKeySignIn (the non-gesture register-and-connect path)', () => {
    it('signs in with the given key and NEVER prompts for biometrics', async () => {
      const { result } = renderHook(() => useSilentKeySignIn());

      let user: unknown;
      await act(async () => {
        user = await result.current.signInWithKeySilent('my-pub');
      });

      expect(sdkSignIn).toHaveBeenCalledWith('my-pub');
      expect(authenticate).not.toHaveBeenCalled();
      expect(user).toEqual({ id: 'me' });
    });

    it('resolves the public key from KeyManager when none is passed — still silent', async () => {
      const { result } = renderHook(() => useSilentKeySignIn());

      await act(async () => {
        await result.current.signInWithKeySilent();
      });

      expect(getPublicKeyMock).toHaveBeenCalledTimes(1);
      expect(sdkSignIn).toHaveBeenCalledWith('resolved-pubkey');
      expect(authenticate).not.toHaveBeenCalled();
    });
  });

  describe('useBiometricSignIn (interactive create/import path)', () => {
    it('runs the biometric gate before signing in when biometrics are enabled', async () => {
      __seedAsyncStorage('oxy_biometric_enabled', 'true');
      const { result } = renderHook(() => useBiometricSignIn());

      await act(async () => {
        await result.current.signIn('my-pub');
      });

      expect(authenticate).toHaveBeenCalledTimes(1);
      expect(sdkSignIn).toHaveBeenCalledWith('my-pub');
    });

    it('rejects and does NOT sign in when the biometric gate fails', async () => {
      __seedAsyncStorage('oxy_biometric_enabled', 'true');
      authenticate.mockResolvedValueOnce({ success: false, error: 'lockout' });
      const { result } = renderHook(() => useBiometricSignIn());

      await expect(result.current.signIn('my-pub')).rejects.toThrow();
      expect(sdkSignIn).not.toHaveBeenCalled();
    });

    it('skips the gate (but still signs in) when biometrics are not enabled', async () => {
      const { result } = renderHook(() => useBiometricSignIn());

      await act(async () => {
        await result.current.signIn('my-pub');
      });

      expect(authenticate).not.toHaveBeenCalled();
      expect(sdkSignIn).toHaveBeenCalledWith('my-pub');
    });
  });
});
