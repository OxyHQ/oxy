/**
 * Lazy migration of the identity from the legacy shared-`key_v1` slots onto the
 * isolated v2 slots (primary service `oxy_identity`, backup service
 * `oxy_identity_backup`).
 *
 * INVARIANT under test: at every instant ≥1 readable copy of a previously
 * existing identity remains — legacy is deleted ONLY after the v2 copy is
 * verified re-readable; a failed v2 write serves legacy for the session; any
 * read-throw defers everything (zero writes/deletes).
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
const V2_BPRIV = 'oxy_identity_backup_private_key_v2';
const V2_BPUB = 'oxy_identity_backup_public_key_v2';
// Legacy slots (default keychain service).
const L_PRIV = 'oxy_identity_private_key';
const L_PUB = 'oxy_identity_public_key';
const L_BPRIV = 'oxy_identity_backup_private_key';
const L_BPUB = 'oxy_identity_backup_public_key';

interface SecureStoreTestHandle {
  __resetStore__: () => void;
  __getRaw__: (key: string, service?: string) => string | null;
  __setRaw__: (key: string, value: string, service?: string) => void;
  __simulateKeystoreDeath__: (service: string) => void;
  __failPlan__: { failKey?: string; failOp?: 'set' | 'get'; failTimes?: number; failService?: string };
}

interface MigrationCapable {
  _ensureIdentitySlotsMigrated: () => Promise<{ mode: 'v2' | 'legacy' | 'deferred' }>;
}

describe('KeyManager identity slot migration (legacy → v2)', () => {
  let KeyManager: typeof import('../keyManager').KeyManager;
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
    resetCaches();
  });

  /** Seed a valid legacy identity (default keychain service) without migrating. */
  const seedLegacyIdentity = async (): Promise<{ privateKey: string; publicKey: string }> => {
    const kp = await KeyManager.generateKeyPair();
    ss.__setRaw__(L_PRIV, kp.privateKey);
    ss.__setRaw__(L_PUB, kp.publicKey);
    ss.__setRaw__(L_BPRIV, kp.privateKey);
    ss.__setRaw__(L_BPUB, kp.publicKey);
    return kp;
  };

  it('migrates a healthy legacy identity into the v2 slots and deletes the legacy copy', async () => {
    const kp = await seedLegacyIdentity();

    // Trigger migration via any accessor.
    expect(await KeyManager.getPublicKey()).toBe(kp.publicKey.toLowerCase());

    // v2 now owns the identity...
    expect(ss.__getRaw__(V2_PRIV, PRIMARY_SVC)).toBe(kp.privateKey.toLowerCase());
    expect(ss.__getRaw__(V2_PUB, PRIMARY_SVC)).toBe(kp.publicKey.toLowerCase());
    // ...and the legacy copy is gone (only after the v2 copy verified).
    expect(ss.__getRaw__(L_PRIV)).toBeNull();
    expect(ss.__getRaw__(L_PUB)).toBeNull();
    expect(await KeyManager.hasIdentity()).toBe(true);
  });

  it('is idempotent — a second run leaves v2 intact and does not resurrect legacy', async () => {
    const kp = await seedLegacyIdentity();
    await KeyManager.getPublicKey();
    resetCaches();
    // Re-run (fresh caches, same process → migration memoized as v2).
    expect(await KeyManager.getPublicKey()).toBe(kp.publicKey.toLowerCase());
    expect(ss.__getRaw__(V2_PRIV, PRIMARY_SVC)).toBe(kp.privateKey.toLowerCase());
    expect(ss.__getRaw__(L_PRIV)).toBeNull();
  });

  it('interrupted-after-copy (v2 healthy AND legacy still present) → cleans up legacy', async () => {
    // Model a prior run that copied to v2 but crashed before deleting legacy.
    const kp = await KeyManager.generateKeyPair();
    ss.__setRaw__(V2_PRIV, kp.privateKey.toLowerCase(), PRIMARY_SVC);
    ss.__setRaw__(V2_PUB, kp.publicKey.toLowerCase(), PRIMARY_SVC);
    ss.__setRaw__(L_PRIV, kp.privateKey);
    ss.__setRaw__(L_PUB, kp.publicKey);

    expect(await KeyManager.getPublicKey()).toBe(kp.publicKey.toLowerCase());
    // v2 kept, legacy cleaned up.
    expect(ss.__getRaw__(V2_PRIV, PRIMARY_SVC)).toBe(kp.privateKey.toLowerCase());
    expect(ss.__getRaw__(L_PRIV)).toBeNull();
    expect(ss.__getRaw__(L_PUB)).toBeNull();
  });

  it('a failed v2 write serves the identity from legacy this session and never deletes legacy', async () => {
    const kp = await seedLegacyIdentity();
    // Make every v2 primary public write fail → migration cannot verify v2.
    ss.__failPlan__.failOp = 'set';
    ss.__failPlan__.failKey = V2_PUB;
    ss.__failPlan__.failService = PRIMARY_SVC;

    // Reads still succeed — served from the UNTOUCHED legacy slots.
    expect(await KeyManager.getPublicKey()).toBe(kp.publicKey);
    expect(await KeyManager.hasIdentity()).toBe(true);
    // Legacy is intact; v2 primary was not left half-written.
    expect(ss.__getRaw__(L_PRIV)).toBe(kp.privateKey);
    expect(ss.__getRaw__(V2_PRIV, PRIMARY_SVC)).toBeNull();
  });

  it('a legacy read throwing defers everything (unavailable, zero writes)', async () => {
    await seedLegacyIdentity();
    // v2 read succeeds (empty); the legacy private read throws → defer.
    ss.__failPlan__.failOp = 'get';
    ss.__failPlan__.failKey = L_PRIV;
    ss.__failPlan__.failService = 'default';

    const status = await KeyManager.getIdentityStatus();
    expect(status.state).toBe('unavailable');
    await expect(KeyManager.hasIdentity()).rejects.toMatchObject({ name: 'IdentityUnavailableError' });
    // Nothing was written to v2.
    expect(ss.__getRaw__(V2_PRIV, PRIMARY_SVC)).toBeNull();
  });

  it('a keystore death BEFORE migration (loss predates markers) → absent, not a phantom identity', async () => {
    await seedLegacyIdentity();
    // key_v1 death: the legacy (default-service) entries are deleted on read.
    ss.__simulateKeystoreDeath__('default');

    const status = await KeyManager.getIdentityStatus();
    // No marker existed (loss predates markers) → a genuine fresh device.
    expect(status.state).toBe('absent');
    expect(ss.__getRaw__(V2_PRIV, PRIMARY_SVC)).toBeNull();
  });

  it('a fresh device (no legacy, no v2) resolves to the empty v2 layout', async () => {
    const status = await KeyManager.getIdentityStatus();
    expect(status.state).toBe('absent');
    expect(await KeyManager.hasIdentity()).toBe(false);
  });

  it('concurrent callers share ONE migration run', async () => {
    const kp = await seedLegacyIdentity();
    const km = KeyManager as unknown as MigrationCapable;
    const [a, b] = await Promise.all([km._ensureIdentitySlotsMigrated(), km._ensureIdentitySlotsMigrated()]);
    // Same memoized result object → a single shared run.
    expect(a).toBe(b);
    expect(a.mode).toBe('v2');
    expect(ss.__getRaw__(V2_PRIV, PRIMARY_SVC)).toBe(kp.privateKey.toLowerCase());
  });

  it('migrates a healthy legacy backup into the v2 backup slot', async () => {
    const kp = await seedLegacyIdentity();
    await KeyManager.getPublicKey();
    expect(ss.__getRaw__(V2_BPRIV, BACKUP_SVC)).toBe(kp.privateKey.toLowerCase());
    expect(ss.__getRaw__(V2_BPUB, BACKUP_SVC)).toBe(kp.publicKey.toLowerCase());
    expect(ss.__getRaw__(L_BPRIV)).toBeNull();
  });
});
