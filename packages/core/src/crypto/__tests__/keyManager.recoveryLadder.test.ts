/**
 * attemptIdentityRecovery — the ladder that restores a `lost` identity from an
 * independent, key_v1-surviving source (backup slot, then cross-app shared slot)
 * WITHOUT the recovery phrase. Every rung validates well-formed + derive-match +
 * `publicKey === marker.publicKey`, so a source holding a DIFFERENT account is
 * skipped (never a silent switch).
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

interface SecureStoreTestHandle {
  __resetStore__: () => void;
  __getRaw__: (key: string, service?: string) => string | null;
  __setRaw__: (key: string, value: string, service?: string) => void;
  __simulateKeystoreDeath__: (service: string) => void;
}

describe('KeyManager.attemptIdentityRecovery (recovery ladder)', () => {
  let KeyManager: typeof import('../keyManager').KeyManager;
  let ss: SecureStoreTestHandle;

  const resetCaches = () => {
    const km = KeyManager as unknown as {
      cachedPublicKey: unknown;
      cachedHasIdentity: unknown;
      cachedPublicKeyResolved: unknown;
      cachedSharedPublicKey: unknown;
      cachedHasSharedIdentity: unknown;
    };
    km.cachedPublicKey = null;
    km.cachedHasIdentity = null;
    km.cachedPublicKeyResolved = false;
    km.cachedSharedPublicKey = null;
    km.cachedHasSharedIdentity = null;
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
    resetCaches();
  });

  it('recovers from the BACKUP slot when the primary keychain key dies', async () => {
    const pub = await KeyManager.createIdentity();
    // Kill ONLY the primary service — the backup slot (independent key) survives.
    ss.__simulateKeystoreDeath__(PRIMARY_SVC);
    resetCaches();

    expect((await KeyManager.getIdentityStatus()).state).toBe('lost');
    resetCaches();

    const result = await KeyManager.attemptIdentityRecovery();
    expect(result).toEqual({ recovered: true, source: 'backup', publicKey: pub.toLowerCase() });
    expect((await KeyManager.getIdentityStatus()).state).toBe('present');
    expect(ss.__getRaw__(V2_PRIV, PRIMARY_SVC)).toBe((await KeyManager.getPrivateKey()));
  });

  it('recovers from the SHARED slot when both primary and backup keys die', async () => {
    await KeyManager.createIdentity();
    const priv = await KeyManager.getPrivateKey();
    if (!priv) throw new Error('expected private key');
    const pub = KeyManager.derivePublicKey(priv);
    // Mirror the identity into the cross-app shared slot (survives key_v1 death).
    await KeyManager.importSharedIdentity(priv);

    ss.__simulateKeystoreDeath__(PRIMARY_SVC);
    ss.__simulateKeystoreDeath__(BACKUP_SVC);
    resetCaches();

    expect((await KeyManager.getIdentityStatus()).state).toBe('lost');
    resetCaches();

    const result = await KeyManager.attemptIdentityRecovery();
    expect(result).toEqual({ recovered: true, source: 'shared', publicKey: pub.toLowerCase() });
    expect((await KeyManager.getIdentityStatus()).state).toBe('present');
  });

  it('SKIPS a source that holds a DIFFERENT account (never silently switches)', async () => {
    await KeyManager.createIdentity();
    // Plant a DIFFERENT identity B in both the backup and shared slots.
    const b = await KeyManager.generateKeyPair();
    ss.__setRaw__(V2_BPRIV, b.privateKey, BACKUP_SVC);
    ss.__setRaw__(V2_BPUB, b.publicKey, BACKUP_SVC);
    await KeyManager.importSharedIdentity(b.privateKey);

    ss.__simulateKeystoreDeath__(PRIMARY_SVC);
    resetCaches();

    const result = await KeyManager.attemptIdentityRecovery();
    expect(result).toEqual({ recovered: false, reason: 'mismatch' });
    // The primary was NOT switched to B.
    expect(ss.__getRaw__(V2_PRIV, PRIMARY_SVC)).not.toBe(b.privateKey);
  });

  it('is a no-op when the identity is NOT lost (present)', async () => {
    await KeyManager.createIdentity();
    const result = await KeyManager.attemptIdentityRecovery();
    expect(result).toEqual({ recovered: false, reason: 'not-lost' });
  });

  it('is a no-op on a genuinely absent (fresh) device', async () => {
    const result = await KeyManager.attemptIdentityRecovery();
    expect(result).toEqual({ recovered: false, reason: 'not-lost' });
  });

  it('reports no-sources when every recovery slot is empty or malformed', async () => {
    await KeyManager.createIdentity();
    // Corrupt the backup so it is not a valid candidate.
    ss.__setRaw__(V2_BPRIV, 'zz-not-hex', BACKUP_SVC);
    ss.__setRaw__(V2_BPUB, 'garbage', BACKUP_SVC);
    ss.__simulateKeystoreDeath__(PRIMARY_SVC);
    resetCaches();

    const result = await KeyManager.attemptIdentityRecovery();
    expect(result).toEqual({ recovered: false, reason: 'no-sources' });
  });
});
