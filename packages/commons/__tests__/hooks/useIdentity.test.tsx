import { type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { IdentityStatus } from '@oxy.so/core';
import { IdentityAlreadyExistsError, IdentityUnavailableError } from '@oxy.so/core';
import { IdentityMayExistError } from '@/hooks/identity/identityErrors';
import { __resetOxyState, __setOxyState } from '@/__mocks__/oxy-services';

/**
 * Auto-create interlock: `createIdentity` must refuse to overwrite whenever a
 * DIRECT, cache-bypassing verdict (or the independent marker) shows an identity
 * is — or may be — present. It only creates on a genuine `absent` + no-marker
 * device. These tests pin each refusal + the happy path.
 */

const getIdentityStatusMock = jest.fn<Promise<IdentityStatus>, [unknown?]>();
const readIdentityMarkerMock = jest.fn();
const generateMock = jest.fn();
const signInMock = jest.fn();
const importKeyPairMock = jest.fn();
const derivePublicKeyMock = jest.fn();
const derivePublicKeyFromPhraseMock = jest.fn();
const restoreFromPhraseMock = jest.fn();
const isValidPrivateKeyMock = jest.fn();
const deleteRecoveryMnemonicMock = jest.fn();

jest.mock('@oxy.so/core', () => {
  const actual = jest.requireActual('@oxy.so/core');
  return {
    ...actual,
    KeyManager: {
      ...actual.KeyManager,
      getIdentityStatus: (opts?: unknown) => getIdentityStatusMock(opts),
      importKeyPair: (privateKey: string, options?: { overwrite?: boolean }) =>
        importKeyPairMock(privateKey, options),
      derivePublicKey: (privateKey: string) => derivePublicKeyMock(privateKey),
      isValidPrivateKey: (privateKey: string) => isValidPrivateKeyMock(privateKey),
      deleteRecoveryMnemonic: () => deleteRecoveryMnemonicMock(),
      // Quiet the on-mount integrity/backup effect (not under test here).
      hasIdentity: jest.fn(async () => false),
      restoreIdentityFromBackup: jest.fn(async () => false),
      verifyIdentityIntegrity: jest.fn(async () => true),
      backupIdentity: jest.fn(async () => true),
      migrateToSharedIdentity: jest.fn(async () => true),
      subscribeIdentityChanged: jest.fn(() => () => undefined),
    },
    readIdentityMarker: () => readIdentityMarkerMock(),
    RecoveryPhraseService: {
      ...actual.RecoveryPhraseService,
      generateIdentityWithRecovery: () => generateMock(),
      derivePublicKeyFromPhrase: (phrase: string) => derivePublicKeyFromPhraseMock(phrase),
      restoreFromPhrase: (phrase: string) => restoreFromPhraseMock(phrase),
    },
  };
});

// The session sign-in wrapper — provide it directly so createIdentity's
// `if (!signIn)` guard passes without standing up biometrics.
jest.mock('@/hooks/useBiometricSignIn', () => ({
  useBiometricSignIn: () => ({ signIn: signInMock }),
}));

// Avoid the reconnect scheduler's timers in the test environment.
jest.mock('@/hooks/identity/useNetworkReconnect', () => ({
  useNetworkReconnect: jest.fn(),
}));

// Keep the real zustand store; stub only the storage persisters (which would
// otherwise touch SecureStore / the identity marker).
jest.mock('@/hooks/identity/identityStore', () => {
  const actual = jest.requireActual('@/hooks/identity/identityStore');
  return {
    ...actual,
    persistIdentitySyncState: jest.fn(async () => undefined),
    getIdentitySyncStateFromStorage: jest.fn(async () => false),
    persistOnboardingComplete: jest.fn(async () => undefined),
    persistOnboardingFlow: jest.fn(async () => undefined),
  };
});

// eslint-disable-next-line import/first
import { useIdentity } from '@/hooks/useIdentity';

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

async function callCreate(
  create: (opts?: { skipSync?: boolean }) => Promise<unknown>,
  opts?: { skipSync?: boolean },
): Promise<{ result?: unknown; error?: unknown }> {
  let result: unknown;
  let error: unknown;
  await act(async () => {
    try {
      result = await create(opts);
    } catch (e) {
      error = e;
    }
  });
  return { result, error };
}

async function callImportPhrase(
  importFn: (phrase: string, opts?: { skipSync?: boolean }) => Promise<unknown>,
  phrase: string,
  opts?: { skipSync?: boolean },
): Promise<{ result?: unknown; error?: unknown }> {
  let result: unknown;
  let error: unknown;
  await act(async () => {
    try {
      result = await importFn(phrase, opts);
    } catch (e) {
      error = e;
    }
  });
  return { result, error };
}

async function callImportPrivateKey(
  importFn: (privateKeyHex: string, opts?: { skipSync?: boolean }) => Promise<unknown>,
  privateKeyHex: string,
  opts?: { skipSync?: boolean },
): Promise<{ result?: unknown; error?: unknown }> {
  let result: unknown;
  let error: unknown;
  await act(async () => {
    try {
      result = await importFn(privateKeyHex, opts);
    } catch (e) {
      error = e;
    }
  });
  return { result, error };
}

const VALID_PRIVATE_KEY = '1'.repeat(64);
const VALID_PUBLIC_KEY = 'pub-from-key';

describe('useIdentity — auto-create interlock', () => {
  beforeEach(() => {
    __resetOxyState();
    __setOxyState({ oxyServices: { register: jest.fn() }, isAuthenticated: false });
    getIdentityStatusMock.mockReset();
    readIdentityMarkerMock.mockReset().mockResolvedValue(null);
    generateMock.mockReset();
    signInMock.mockReset();
    importKeyPairMock.mockReset();
    derivePublicKeyMock.mockReset();
    derivePublicKeyFromPhraseMock.mockReset();
    restoreFromPhraseMock.mockReset();
    isValidPrivateKeyMock.mockReset();
    deleteRecoveryMnemonicMock.mockReset().mockResolvedValue(undefined);
    isValidPrivateKeyMock.mockReturnValue(true);
    derivePublicKeyMock.mockReturnValue(VALID_PUBLIC_KEY);
    importKeyPairMock.mockResolvedValue(VALID_PUBLIC_KEY);
  });

  it('refuses with IdentityAlreadyExistsError when the verdict is present', async () => {
    getIdentityStatusMock.mockResolvedValue({ state: 'present', publicKey: 'pub-present' });
    const { result } = renderHook(() => useIdentity(), { wrapper: createWrapper() });

    const { error } = await callCreate(result.current.createIdentity);
    expect(error).toBeInstanceOf(IdentityAlreadyExistsError);
    expect(getIdentityStatusMock).toHaveBeenCalledWith({ bypassCache: true });
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('refuses with IdentityUnavailableError when storage is unavailable', async () => {
    getIdentityStatusMock.mockResolvedValue({ state: 'unavailable', cause: new Error('locked') });
    const { result } = renderHook(() => useIdentity(), { wrapper: createWrapper() });

    const { error } = await callCreate(result.current.createIdentity);
    expect(error).toBeInstanceOf(IdentityUnavailableError);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('refuses with IdentityMayExistError when the verdict is lost (marker present, keys gone)', async () => {
    getIdentityStatusMock.mockResolvedValue({
      state: 'lost',
      marker: { v: 1, publicKey: 'pub-lost', createdAt: 1, origin: 'create' },
    });
    const { result } = renderHook(() => useIdentity(), { wrapper: createWrapper() });

    const { error } = await callCreate(result.current.createIdentity);
    expect(error).toBeInstanceOf(IdentityMayExistError);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('refuses with IdentityMayExistError when a marker appears concurrently after an absent read', async () => {
    getIdentityStatusMock.mockResolvedValue({ state: 'absent' });
    readIdentityMarkerMock.mockResolvedValue({ v: 1, publicKey: 'pub-race', createdAt: 1, origin: 'create' });
    const { result } = renderHook(() => useIdentity(), { wrapper: createWrapper() });

    const { error } = await callCreate(result.current.createIdentity);
    expect(error).toBeInstanceOf(IdentityMayExistError);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it('creates on a genuine fresh device (absent verdict + no marker)', async () => {
    getIdentityStatusMock.mockResolvedValue({ state: 'absent' });
    readIdentityMarkerMock.mockResolvedValue(null);
    generateMock.mockResolvedValue({ words: ['a', 'b', 'c'], publicKey: 'pub-new' });
    const { result } = renderHook(() => useIdentity(), { wrapper: createWrapper() });

    // `skipSync` keeps the happy path local (no register/signIn round-trip).
    const { result: created, error } = await callCreate(result.current.createIdentity, {
      skipSync: true,
    });
    expect(error).toBeUndefined();
    expect(created).toEqual({ recoveryPhrase: ['a', 'b', 'c'], synced: false });
    expect(getIdentityStatusMock).toHaveBeenCalledWith({ bypassCache: true });
    expect(generateMock).toHaveBeenCalledTimes(1);
  });
});

describe('useIdentity — importIdentity interlock', () => {
  const VALID_PHRASE = 'word '.repeat(12).trim();

  beforeEach(() => {
    __resetOxyState();
    __setOxyState({ oxyServices: { register: jest.fn() }, isAuthenticated: false });
    getIdentityStatusMock.mockReset();
    readIdentityMarkerMock.mockReset().mockResolvedValue(null);
    signInMock.mockReset();
    derivePublicKeyFromPhraseMock.mockReset().mockResolvedValue(VALID_PUBLIC_KEY);
    restoreFromPhraseMock.mockReset().mockResolvedValue(VALID_PUBLIC_KEY);
  });

  it('refuses with IdentityMayExistError when a marker appears concurrently after an absent read', async () => {
    getIdentityStatusMock.mockResolvedValue({ state: 'absent' });
    readIdentityMarkerMock.mockResolvedValue({ v: 1, publicKey: 'other-pub', createdAt: 1, origin: 'create' });
    const { result } = renderHook(() => useIdentity(), { wrapper: createWrapper() });

    const { error } = await callImportPhrase(result.current.importIdentity, VALID_PHRASE);
    expect(error).toBeInstanceOf(IdentityMayExistError);
    expect(restoreFromPhraseMock).not.toHaveBeenCalled();
  });
});

describe('useIdentity — importIdentityFromPrivateKey interlock', () => {
  beforeEach(() => {
    __resetOxyState();
    __setOxyState({ oxyServices: { register: jest.fn() }, isAuthenticated: false });
    getIdentityStatusMock.mockReset();
    readIdentityMarkerMock.mockReset().mockResolvedValue(null);
    signInMock.mockReset();
    importKeyPairMock.mockReset().mockResolvedValue(VALID_PUBLIC_KEY);
    derivePublicKeyMock.mockReset().mockReturnValue(VALID_PUBLIC_KEY);
    isValidPrivateKeyMock.mockReset().mockReturnValue(true);
    deleteRecoveryMnemonicMock.mockReset().mockResolvedValue(undefined);
  });

  it('refuses with IdentityAlreadyExistsError when a different identity is present', async () => {
    getIdentityStatusMock.mockResolvedValue({ state: 'present', publicKey: 'other-pub' });
    const { result } = renderHook(() => useIdentity(), { wrapper: createWrapper() });

    const { error } = await callImportPrivateKey(result.current.importIdentityFromPrivateKey, VALID_PRIVATE_KEY);
    expect(error).toBeInstanceOf(IdentityAlreadyExistsError);
    expect(importKeyPairMock).not.toHaveBeenCalled();
  });

  it('refuses with IdentityMayExistError when a different lost identity is marked', async () => {
    getIdentityStatusMock.mockResolvedValue({
      state: 'lost',
      marker: { v: 1, publicKey: 'other-pub', createdAt: 1, origin: 'create' },
    });
    const { result } = renderHook(() => useIdentity(), { wrapper: createWrapper() });

    const { error } = await callImportPrivateKey(result.current.importIdentityFromPrivateKey, VALID_PRIVATE_KEY);
    expect(error).toBeInstanceOf(IdentityMayExistError);
    expect(importKeyPairMock).not.toHaveBeenCalled();
  });

  it('refuses with IdentityMayExistError when a marker appears concurrently after an absent read', async () => {
    getIdentityStatusMock.mockResolvedValue({ state: 'absent' });
    readIdentityMarkerMock.mockResolvedValue({ v: 1, publicKey: 'other-pub', createdAt: 1, origin: 'create' });
    const { result } = renderHook(() => useIdentity(), { wrapper: createWrapper() });

    const { error } = await callImportPrivateKey(result.current.importIdentityFromPrivateKey, VALID_PRIVATE_KEY);
    expect(error).toBeInstanceOf(IdentityMayExistError);
    expect(importKeyPairMock).not.toHaveBeenCalled();
  });

  it('imports on a fresh device and clears any stale mnemonic', async () => {
    getIdentityStatusMock.mockResolvedValue({ state: 'absent' });
    const { result } = renderHook(() => useIdentity(), { wrapper: createWrapper() });

    const { result: imported, error } = await callImportPrivateKey(
      result.current.importIdentityFromPrivateKey,
      VALID_PRIVATE_KEY,
      { skipSync: true },
    );
    expect(error).toBeUndefined();
    expect(imported).toEqual({ synced: false });
    expect(importKeyPairMock).toHaveBeenCalledWith(VALID_PRIVATE_KEY, undefined);
    expect(deleteRecoveryMnemonicMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid private key before touching storage or status', async () => {
    isValidPrivateKeyMock.mockReturnValue(false);
    const { result } = renderHook(() => useIdentity(), { wrapper: createWrapper() });

    const { error } = await callImportPrivateKey(result.current.importIdentityFromPrivateKey, 'not-a-key');
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/invalid private key/i);
    expect(getIdentityStatusMock).not.toHaveBeenCalled();
    expect(importKeyPairMock).not.toHaveBeenCalled();
  });

  it('allows re-importing the SAME identity that is already present', async () => {
    getIdentityStatusMock.mockResolvedValue({ state: 'present', publicKey: VALID_PUBLIC_KEY });
    const { result } = renderHook(() => useIdentity(), { wrapper: createWrapper() });

    const { error } = await callImportPrivateKey(
      result.current.importIdentityFromPrivateKey,
      VALID_PRIVATE_KEY,
      { skipSync: true },
    );
    expect(error).toBeUndefined();
    expect(importKeyPairMock).toHaveBeenCalledWith(VALID_PRIVATE_KEY, undefined);
  });

  it('refuses with IdentityUnavailableError when identity storage is unavailable', async () => {
    getIdentityStatusMock.mockResolvedValue({ state: 'unavailable', cause: new Error('locked') });
    const { result } = renderHook(() => useIdentity(), { wrapper: createWrapper() });

    const { error } = await callImportPrivateKey(result.current.importIdentityFromPrivateKey, VALID_PRIVATE_KEY);
    expect(error).toBeInstanceOf(IdentityUnavailableError);
    expect(importKeyPairMock).not.toHaveBeenCalled();
  });
});
