/**
 * getIdentityStatus tri-state (+ unavailable) verdict, the marker lifecycle, and
 * the honest-typed-throw semantics of hasIdentity — the corruption-vs-fresh
 * disambiguation that routing keys off of.
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
const BACKUP_SVC = 'oxy_identity_backup';
const V2_PRIV = 'oxy_identity_private_key_v2';
const V2_PUB = 'oxy_identity_public_key_v2';

interface SecureStoreTestHandle {
  __resetStore__: () => void;
  __getRaw__: (key: string, service?: string) => string | null;
  __setRaw__: (key: string, value: string, service?: string) => void;
  __simulateKeystoreDeath__: (service: string) => void;
  __failPlan__: { failKey?: string; failOp?: 'set' | 'get'; failTimes?: number; failService?: string };
}

describe('KeyManager.getIdentityStatus + marker lifecycle', () => {
  let KeyManager: typeof import('../keyManager').KeyManager;
  let readIdentityMarker: typeof import('../identityMarker').readIdentityMarker;
  let clearIdentityMarker: typeof import('../identityMarker').clearIdentityMarker;
  let ss: SecureStoreTestHandle;

  const resetCaches = () => {
    const km = KeyManager as unknown as {
      cachedPublicKey: unknown;
      cachedHasIdentity: unknown;
      cachedPublicKeyResolved: unknown;
    };
    km.cachedPublicKey = null;
    km.cachedHasIdentity = null;
    km.cachedPublicKeyResolved = false;
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
    const km = await import('../keyManager');
    KeyManager = km.KeyManager;
    // Dynamically import the marker module AFTER resetModules so it shares the
    // SAME (post-reset) AsyncStorage instance KeyManager writes markers to.
    const marker = await import('../identityMarker');
    readIdentityMarker = marker.readIdentityMarker;
    clearIdentityMarker = marker.clearIdentityMarker;
    resetCaches();
  });

  it('reports absent on a genuinely fresh device (no keys, no marker)', async () => {
    const status = await KeyManager.getIdentityStatus();
    expect(status.state).toBe('absent');
  });

  it('reports present and writes a marker for a healthy identity', async () => {
    const pub = await KeyManager.createIdentity();
    const status = await KeyManager.getIdentityStatus();
    expect(status).toEqual({ state: 'present', publicKey: pub.toLowerCase() });
    const marker = await readIdentityMarker();
    expect(marker?.publicKey.toLowerCase()).toBe(pub.toLowerCase());
  });

  it('backfills a MISSING marker on the first healthy read (origin: backfill)', async () => {
    const pub = await KeyManager.createIdentity();
    // Simulate a device whose loss/creation predated markers: drop the marker.
    await clearIdentityMarker();
    expect(await readIdentityMarker()).toBeNull();

    const status = await KeyManager.getIdentityStatus();
    expect(status.state).toBe('present');
    const marker = await readIdentityMarker();
    expect(marker?.publicKey.toLowerCase()).toBe(pub.toLowerCase());
    expect(marker?.origin).toBe('backfill');
  });

  it('reports LOST when the keys are gone (keystore death) but the marker survives', async () => {
    const pub = await KeyManager.createIdentity();
    // Kill the primary keychain service — the marker in AsyncStorage survives.
    ss.__simulateKeystoreDeath__(PRIMARY_SVC);
    resetCaches();

    const status = await KeyManager.getIdentityStatus();
    expect(status.state).toBe('lost');
    if (status.state === 'lost') {
      expect(status.marker.publicKey.toLowerCase()).toBe(pub.toLowerCase());
    }
  });

  it('reports UNAVAILABLE on a storage throw and NEVER caches that verdict', async () => {
    await KeyManager.createIdentity();
    resetCaches();

    // Make the primary read throw (migration already resolved to v2 above).
    ss.__failPlan__.failOp = 'get';
    ss.__failPlan__.failKey = V2_PUB;
    ss.__failPlan__.failService = PRIMARY_SVC;
    const unavailable = await KeyManager.getIdentityStatus();
    expect(unavailable.state).toBe('unavailable');

    // Clearing the fault yields a fresh, CORRECT verdict — proof it was not cached.
    ss.__failPlan__.failKey = undefined;
    ss.__failPlan__.failOp = undefined;
    ss.__failPlan__.failService = undefined;
    const present = await KeyManager.getIdentityStatus();
    expect(present.state).toBe('present');
  });

  it('hasIdentity throws IdentityUnavailableError (not false) on a storage throw', async () => {
    await KeyManager.createIdentity();
    resetCaches();
    ss.__failPlan__.failOp = 'get';
    ss.__failPlan__.failKey = V2_PRIV;
    ss.__failPlan__.failService = PRIMARY_SVC;
    await expect(KeyManager.hasIdentity()).rejects.toMatchObject({ name: 'IdentityUnavailableError' });
  });

  describe('marker lifecycle', () => {
    it('writes a create-origin marker on createIdentity', async () => {
      const pub = await KeyManager.createIdentity();
      const marker = await readIdentityMarker();
      expect(marker?.publicKey.toLowerCase()).toBe(pub.toLowerCase());
      expect(marker?.origin).toBe('create');
    });

    it('leaves the marker untouched when a persist rolls back', async () => {
      const original = await KeyManager.createIdentity();
      resetCaches();
      // Fail the overwrite's primary write → rollback (marker must not change).
      ss.__failPlan__.failOp = 'set';
      ss.__failPlan__.failKey = V2_PRIV;
      ss.__failPlan__.failService = PRIMARY_SVC;
      await expect(KeyManager.createIdentity({ overwrite: true })).rejects.toBeDefined();

      const marker = await readIdentityMarker();
      expect(marker?.publicKey.toLowerCase()).toBe(original.toLowerCase());
      expect(marker?.origin).toBe('create');
    });

    it('clears the marker on force deleteIdentity', async () => {
      await KeyManager.createIdentity();
      expect(await readIdentityMarker()).not.toBeNull();
      await KeyManager.deleteIdentity(true, true, true);
      expect(await readIdentityMarker()).toBeNull();
    });

    it('preserves onboardingComplete + createdAt across a same-identity re-persist', async () => {
      const pub = await KeyManager.createIdentity();
      const marker = await import('../identityMarker');
      await marker.updateIdentityMarker({ onboardingComplete: true });
      const before = await readIdentityMarker();
      resetCaches();
      // Re-import the same identity (idempotent refresh).
      const priv = await KeyManager.getPrivateKey();
      if (!priv) throw new Error('expected private key');
      await KeyManager.importKeyPair(priv);
      const after = await readIdentityMarker();
      expect(after?.publicKey.toLowerCase()).toBe(pub.toLowerCase());
      expect(after?.onboardingComplete).toBe(true);
      expect(after?.createdAt).toBe(before?.createdAt);
    });
  });
});
