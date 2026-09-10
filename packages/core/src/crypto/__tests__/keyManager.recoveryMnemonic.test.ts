/**
 * Recovery-mnemonic storage: a dedicated, device-only keychain slot that lets a
 * user re-reveal their 12-word phrase from Settings. Isolated from the identity
 * primary/backup slots (its own keychain service), null-on-absent, typed-throw
 * on a locked keychain, and wiped when the identity is deleted.
 */

import { setPlatformOS } from '../../utils/platform';

jest.mock(
  'expo-secure-store',
  () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createSecureStoreMock } = require('./identityMocks');
    return createSecureStoreMock();
  },
  { virtual: true },
);

jest.mock(
  'expo-crypto',
  () => ({
    __esModule: true,
    getRandomBytes: (length: number) => {
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) out[i] = (Math.random() * 256) & 0xff;
      return out;
    },
    digestStringAsync: async () => '0'.repeat(64),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  }),
  { virtual: true },
);

jest.mock('@oxy.so/protocol', () => {
  const actual = jest.requireActual('@oxy.so/protocol');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createAsyncStorageMock } = require('./identityMocks');
  const asyncStorage = createAsyncStorageMock();
  return {
    __esModule: true,
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loadExpoCrypto: async () => require('expo-crypto'),
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loadSecureStore: async () => require('expo-secure-store'),
    loadAsyncStorage: async () => ({ default: asyncStorage }),
    loadSharedIdentityBridge: async () => null,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loadNodeCrypto: async () => require('crypto'),
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    getRandomBytesRN: (n: number) => require('expo-crypto').getRandomBytes(n),
  };
});

const MNEMONIC_SVC = 'oxy_identity_mnemonic';
const MNEMONIC_KEY = 'oxy_identity_mnemonic_v1';
const PRIMARY_SVC = 'oxy_identity';
const PHRASE = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

interface SecureStoreTestHandle {
  __resetStore__: () => void;
  __getRaw__: (key: string, service?: string) => string | null;
  __simulateKeystoreDeath__: (service: string) => void;
  __failPlan__: { failKey?: string; failOp?: 'set' | 'get'; failTimes?: number; failService?: string };
}

describe('KeyManager recovery mnemonic storage', () => {
  let KeyManager: typeof import('../keyManager').KeyManager;
  let IdentityUnavailableError: typeof import('../keyManager').IdentityUnavailableError;
  let ss: SecureStoreTestHandle;

  beforeAll(() => {
    setPlatformOS('ios');
    (globalThis as unknown as { navigator: unknown }).navigator = { product: 'ReactNative' };
  });

  beforeEach(async () => {
    jest.resetModules();
    setPlatformOS('ios');
    ss = (await import('expo-secure-store' as string)) as unknown as SecureStoreTestHandle;
    ss.__resetStore__();
    const km = await import('../keyManager');
    KeyManager = km.KeyManager;
    IdentityUnavailableError = km.IdentityUnavailableError;
  });

  it('round-trips a stored mnemonic', async () => {
    await KeyManager.storeRecoveryMnemonic(PHRASE);
    expect(await KeyManager.getRecoveryMnemonic()).toBe(PHRASE);
  });

  it('persists under its OWN keychain service, isolated from the identity slots', async () => {
    await KeyManager.storeRecoveryMnemonic(PHRASE);
    // Present under the mnemonic service, invisible under the primary service.
    expect(ss.__getRaw__(MNEMONIC_KEY, MNEMONIC_SVC)).toBe(PHRASE);
    expect(ss.__getRaw__(MNEMONIC_KEY, PRIMARY_SVC)).toBeNull();
  });

  it('returns null when no mnemonic was ever stored (pre-feature identity)', async () => {
    expect(await KeyManager.getRecoveryMnemonic()).toBeNull();
  });

  it('survives a keystore death of the identity primary service', async () => {
    await KeyManager.storeRecoveryMnemonic(PHRASE);
    // The identity primary slot dies; the mnemonic lives in a distinct service.
    ss.__simulateKeystoreDeath__(PRIMARY_SVC);
    expect(await KeyManager.getRecoveryMnemonic()).toBe(PHRASE);
  });

  it('throws IdentityUnavailableError (never null) when the read throws', async () => {
    await KeyManager.storeRecoveryMnemonic(PHRASE);
    ss.__failPlan__.failOp = 'get';
    ss.__failPlan__.failKey = MNEMONIC_KEY;
    ss.__failPlan__.failService = MNEMONIC_SVC;
    await expect(KeyManager.getRecoveryMnemonic()).rejects.toBeInstanceOf(IdentityUnavailableError);
  });

  it('throws IdentityUnavailableError when the write throws', async () => {
    ss.__failPlan__.failOp = 'set';
    ss.__failPlan__.failKey = MNEMONIC_KEY;
    ss.__failPlan__.failService = MNEMONIC_SVC;
    await expect(KeyManager.storeRecoveryMnemonic(PHRASE)).rejects.toBeInstanceOf(IdentityUnavailableError);
  });

  it('deleteRecoveryMnemonic removes the stored phrase', async () => {
    await KeyManager.storeRecoveryMnemonic(PHRASE);
    await KeyManager.deleteRecoveryMnemonic();
    expect(await KeyManager.getRecoveryMnemonic()).toBeNull();
  });

  it('deleteIdentity(force) wipes the stored mnemonic', async () => {
    await KeyManager.createIdentity();
    await KeyManager.storeRecoveryMnemonic(PHRASE);
    await KeyManager.deleteIdentity(true, true, true);
    expect(await KeyManager.getRecoveryMnemonic()).toBeNull();
  });
});
