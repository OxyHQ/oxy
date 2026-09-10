/**
 * Cache-poisoning safety: a thrown read must never be cached as "no identity",
 * and the create/import overwrite guards must read storage DIRECTLY (+ the
 * marker), never a stale/poisoned cache — so a transient failure can never let
 * onboarding silently overwrite a real identity.
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

const PRIMARY_SVC = 'oxy_identity';
const V2_PRIV = 'oxy_identity_private_key_v2';
const V2_PUB = 'oxy_identity_public_key_v2';

interface SecureStoreTestHandle {
  __resetStore__: () => void;
  __getRaw__: (key: string, service?: string) => string | null;
  __simulateKeystoreDeath__: (service: string) => void;
  __failPlan__: { failKey?: string; failOp?: 'set' | 'get'; failTimes?: number; failService?: string };
}

describe('KeyManager cache-poisoning safety', () => {
  let KeyManager: typeof import('../keyManager').KeyManager;
  let IdentityAlreadyExistsError: typeof import('../keyManager').IdentityAlreadyExistsError;
  let ss: SecureStoreTestHandle;

  const km = () =>
    KeyManager as unknown as {
      cachedPublicKey: unknown;
      cachedHasIdentity: unknown;
      cachedPublicKeyResolved: unknown;
    };
  const resetCaches = () => {
    km().cachedPublicKey = null;
    km().cachedHasIdentity = null;
    km().cachedPublicKeyResolved = false;
  };

  beforeAll(() => {
    setPlatformOS('ios');
    (globalThis as unknown as { navigator: unknown }).navigator = { product: 'ReactNative' };
  });

  beforeEach(async () => {
    jest.resetModules();
    setPlatformOS('ios');
    ss = (await import('expo-secure-store' as string)) as unknown as SecureStoreTestHandle;
    ss.__resetStore__();
    const mod = await import('../keyManager');
    KeyManager = mod.KeyManager;
    IdentityAlreadyExistsError = mod.IdentityAlreadyExistsError;
    resetCaches();
  });

  it('getPublicKey does NOT cache null when the read throws (a later read still succeeds)', async () => {
    const pub = await KeyManager.createIdentity();
    resetCaches();

    ss.__failPlan__.failOp = 'get';
    ss.__failPlan__.failKey = V2_PUB;
    ss.__failPlan__.failService = PRIMARY_SVC;
    await expect(KeyManager.getPublicKey()).rejects.toMatchObject({ name: 'IdentityUnavailableError' });

    // Cache must NOT hold a null verdict — clearing the fault returns the key.
    ss.__failPlan__.failKey = undefined;
    ss.__failPlan__.failOp = undefined;
    ss.__failPlan__.failService = undefined;
    expect(await KeyManager.getPublicKey()).toBe(pub.toLowerCase());
  });

  it('getPublicKey caches a genuine-absent (successful empty) read as null', async () => {
    // Fresh device: read succeeds empty → null, cacheable.
    expect(await KeyManager.getPublicKey()).toBeNull();
    // The resolved-null flag is set (distinct from a thrown read).
    expect(km().cachedPublicKeyResolved).toBe(true);
  });

  it('createIdentity overwrite guard refuses over a POISONED cache (direct read finds the identity)', async () => {
    await KeyManager.createIdentity();
    // Poison the read cache as if a prior transient failure had "resolved null".
    resetCaches();
    km().cachedPublicKeyResolved = true; // getPublicKey would now claim "no identity"

    await expect(KeyManager.createIdentity()).rejects.toBeInstanceOf(IdentityAlreadyExistsError);
  });

  it('createIdentity overwrite guard refuses (IdentityUnavailableError) when storage throws — never writes blind', async () => {
    const pub = await KeyManager.createIdentity();
    resetCaches();
    ss.__failPlan__.failOp = 'get';
    ss.__failPlan__.failKey = V2_PRIV;
    ss.__failPlan__.failService = PRIMARY_SVC;

    await expect(KeyManager.createIdentity()).rejects.toMatchObject({ name: 'IdentityUnavailableError' });

    // The identity was untouched (no blind overwrite).
    ss.__failPlan__.failKey = undefined;
    ss.__failPlan__.failOp = undefined;
    ss.__failPlan__.failService = undefined;
    resetCaches();
    expect(await KeyManager.getPublicKey()).toBe(pub.toLowerCase());
  });

  it('createIdentity refuses over a LOST identity (marker present, keys gone) — routes to recovery, not create', async () => {
    await KeyManager.createIdentity();
    ss.__simulateKeystoreDeath__(PRIMARY_SVC);
    resetCaches();

    // Even with keys gone, the marker records an identity → refuse a blind create.
    await expect(KeyManager.createIdentity()).rejects.toBeInstanceOf(IdentityAlreadyExistsError);
  });

  it('importKeyPair refuses a DIFFERENT key in the lost state, but ALLOWS re-importing the same (recovery)', async () => {
    const pub = await KeyManager.createIdentity();
    const originalPriv = await KeyManager.getPrivateKey();
    if (!originalPriv) throw new Error('expected private key');
    ss.__simulateKeystoreDeath__(PRIMARY_SVC);
    resetCaches();

    // A different key over a lost identity → refuse.
    const otherPriv = (await KeyManager.generateKeyPair()).privateKey;
    await expect(KeyManager.importKeyPair(otherPriv)).rejects.toBeInstanceOf(IdentityAlreadyExistsError);

    // The SAME key (recovery-by-phrase into the lost state) → allowed.
    resetCaches();
    const restored = await KeyManager.importKeyPair(originalPriv);
    expect(restored).toBe(pub.toLowerCase());
    expect(await KeyManager.getPublicKey()).toBe(pub.toLowerCase());
  });
});
