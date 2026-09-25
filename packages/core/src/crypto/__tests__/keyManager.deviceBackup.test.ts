/**
 * The device backup (oxy#1388): a copy of the identity held OUTSIDE the app's
 * keystore, so a wipe of the whole shared-UID Android Keystore — which takes the
 * primary, the backup slot, the phrase slot and the shared slot together — is
 * undone silently instead of asking for the recovery phrase.
 *
 * The store is an in-memory fake of what Commons registers (Android Block
 * Store); the keystore wipe is the secure-store mock's keystore death applied to
 * every keychain service the SDK uses.
 */

import { setPlatformOS } from '../../utils/platform';
import type { IdentityDeviceBackupStore } from '../deviceBackup';

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
    loadNodeCrypto: async () => require('node:crypto'),
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    getRandomBytesRN: (n: number) => require('expo-crypto').getRandomBytes(n),
  };
});

/** Every keychain service the SDK writes under: what one UID keystore wipe kills. */
const ALL_SERVICES = ['oxy_identity', 'oxy_identity_backup', 'oxy_identity_mnemonic', 'default'];
const PRIMARY_SVC = 'oxy_identity';
const V2_PRIV = 'oxy_identity_private_key_v2';

interface SecureStoreTestHandle {
  __resetStore__: () => void;
  __getRaw__: (key: string, service?: string) => string | null;
  __simulateKeystoreDeath__: (service: string) => void;
}

interface FakeStore extends IdentityDeviceBackupStore {
  value: string | null;
  writes: number;
  failReads: boolean;
  failWrites: boolean;
}

function createFakeStore(): FakeStore {
  const fake: FakeStore = {
    name: 'fake',
    value: null,
    writes: 0,
    failReads: false,
    failWrites: false,
    read: async () => {
      if (fake.failReads) throw new Error('store unreachable');
      return fake.value;
    },
    write: async (value: string) => {
      if (fake.failWrites) throw new Error('store write failed');
      fake.writes += 1;
      fake.value = value;
    },
    clear: async () => {
      fake.value = null;
    },
  };
  return fake;
}

describe('KeyManager device backup', () => {
  let KeyManager: typeof import('../keyManager').KeyManager;
  let RecoveryPhraseService: typeof import('../recoveryPhrase').RecoveryPhraseService;
  let clearIdentityMarker: typeof import('../identityMarker').clearIdentityMarker;
  let ss: SecureStoreTestHandle;
  let store: FakeStore;

  const resetCaches = () => {
    const km = KeyManager as unknown as Record<string, unknown>;
    km.cachedPublicKey = null;
    km.cachedHasIdentity = null;
    km.cachedPublicKeyResolved = false;
    km.cachedSharedPublicKey = null;
    km.cachedHasSharedIdentity = null;
  };

  /** What a sibling's `pm clear` does to this app: every keystore-wrapped copy dies. */
  const wipeUidKeystore = () => {
    for (const service of ALL_SERVICES) {
      ss.__simulateKeystoreDeath__(service);
    }
    resetCaches();
  };

  const record = () => (store.value ? JSON.parse(store.value) : null);

  beforeAll(() => {
    (globalThis as unknown as { navigator: unknown }).navigator = { product: 'ReactNative' };
  });

  beforeEach(async () => {
    jest.resetModules();
    setPlatformOS('android');
    ss = (await import('expo-secure-store' as string)) as unknown as SecureStoreTestHandle;
    ss.__resetStore__();
    KeyManager = (await import('../keyManager')).KeyManager;
    RecoveryPhraseService = (await import('../recoveryPhrase')).RecoveryPhraseService;
    clearIdentityMarker = (await import('../identityMarker')).clearIdentityMarker;
    store = createFakeStore();
    KeyManager.setDeviceBackupStore(store);
    resetCaches();
  });

  describe('backup', () => {
    it('writes the identity on creation', async () => {
      const pub = await KeyManager.createIdentity();
      const priv = await KeyManager.getPrivateKey();
      expect(record()).toMatchObject({ version: 1, publicKey: pub.toLowerCase(), privateKey: priv });
      expect(record().mnemonic).toBeUndefined();
    });

    it('carries the phrase only when it derives the identity', async () => {
      const pending = await RecoveryPhraseService.derivePendingIdentity();
      await KeyManager.importKeyPair(pending.privateKey);
      await KeyManager.storeRecoveryMnemonic(pending.phrase);
      expect(record().mnemonic).toBe(pending.phrase);

      const other = await RecoveryPhraseService.derivePendingIdentity();
      await KeyManager.storeRecoveryMnemonic(other.phrase);
      // A phrase for another identity never reaches the backup.
      expect(record().mnemonic).toBe(pending.phrase);
    });

    it('follows a key rotation and drops the old phrase', async () => {
      const oldId = await RecoveryPhraseService.derivePendingIdentity();
      await KeyManager.importKeyPair(oldId.privateKey);
      await KeyManager.storeRecoveryMnemonic(oldId.phrase);

      const newId = await RecoveryPhraseService.derivePendingIdentity();
      await KeyManager.importKeyPair(newId.privateKey, { overwrite: true });
      expect(record()).toMatchObject({ publicKey: newId.publicKey.toLowerCase(), privateKey: newId.privateKey });
      expect(record().mnemonic).toBeUndefined();

      await KeyManager.storeRecoveryMnemonic(newId.phrase);
      expect(record().mnemonic).toBe(newId.phrase);
    });

    it('never fails an identity write when the store fails', async () => {
      store.failWrites = true;
      const pub = await KeyManager.createIdentity();
      expect((await KeyManager.getIdentityStatus()).state).toBe('present');
      expect(pub).toBeTruthy();
      expect(store.value).toBeNull();
    });

    it('ensureDeviceBackup backfills a missing backup and repairs a stale one', async () => {
      store.failWrites = true;
      const pending = await RecoveryPhraseService.derivePendingIdentity();
      await KeyManager.importKeyPair(pending.privateKey);
      await KeyManager.storeRecoveryMnemonic(pending.phrase);
      expect(store.value).toBeNull();

      store.failWrites = false;
      expect(await KeyManager.ensureDeviceBackup()).toBe(true);
      expect(record()).toMatchObject({ publicKey: pending.publicKey.toLowerCase(), mnemonic: pending.phrase });

      // Current already: one read, no write.
      const writes = store.writes;
      expect(await KeyManager.ensureDeviceBackup()).toBe(true);
      expect(store.writes).toBe(writes);

      // Stale (e.g. a rotation whose backup write failed): rewritten.
      const stale = await KeyManager.generateKeyPair();
      store.value = JSON.stringify({ ...record(), privateKey: stale.privateKey, publicKey: stale.publicKey });
      expect(await KeyManager.ensureDeviceBackup()).toBe(true);
      expect(record().publicKey).toBe(pending.publicKey.toLowerCase());
    });

    it('ensureDeviceBackup is a no-op without a store or an identity', async () => {
      expect(await KeyManager.ensureDeviceBackup()).toBe(false);
      KeyManager.setDeviceBackupStore(null);
      await KeyManager.createIdentity();
      expect(await KeyManager.ensureDeviceBackup()).toBe(false);
    });
  });

  describe('restore', () => {
    it('restores silently after a wipe of the whole UID keystore, phrase included', async () => {
      const pending = await RecoveryPhraseService.derivePendingIdentity();
      await KeyManager.importKeyPair(pending.privateKey);
      await KeyManager.storeRecoveryMnemonic(pending.phrase);

      wipeUidKeystore();
      expect((await KeyManager.getIdentityStatus({ bypassCache: true })).state).toBe('lost');

      const result = await KeyManager.attemptIdentityRecovery();
      expect(result).toEqual({
        recovered: true,
        source: 'device-backup',
        publicKey: pending.publicKey.toLowerCase(),
      });
      resetCaches();
      expect(await KeyManager.getIdentityStatus()).toEqual({
        state: 'present',
        publicKey: pending.publicKey.toLowerCase(),
      });
      expect(ss.__getRaw__(V2_PRIV, PRIMARY_SVC)).toBe(pending.privateKey);
      expect(await KeyManager.getRecoveryMnemonic()).toBe(pending.phrase);
    });

    it('without a device backup the same wipe still ends at the phrase', async () => {
      KeyManager.setDeviceBackupStore(null);
      await KeyManager.createIdentity();
      wipeUidKeystore();
      expect(await KeyManager.attemptIdentityRecovery()).toEqual({ recovered: false, reason: 'no-sources' });
    });

    it('restores when this app lost its own data too (absent: no keys, no marker)', async () => {
      const pub = await KeyManager.createIdentity();
      wipeUidKeystore();
      await clearIdentityMarker();
      expect((await KeyManager.getIdentityStatus({ bypassCache: true })).state).toBe('absent');

      const result = await KeyManager.attemptIdentityRecovery();
      expect(result).toEqual({ recovered: true, source: 'device-backup', publicKey: pub.toLowerCase() });
      resetCaches();
      expect((await KeyManager.getIdentityStatus()).state).toBe('present');
    });

    it('never switches to a backup that holds a different account than the marker', async () => {
      await KeyManager.createIdentity();
      const other = await KeyManager.generateKeyPair();
      store.value = JSON.stringify({
        version: 1,
        privateKey: other.privateKey,
        publicKey: other.publicKey,
        updatedAt: new Date().toISOString(),
      });
      wipeUidKeystore();

      expect(await KeyManager.attemptIdentityRecovery()).toEqual({ recovered: false, reason: 'mismatch' });
      expect(ss.__getRaw__(V2_PRIV, PRIMARY_SVC)).toBeNull();
    });

    it('ignores a malformed or unhealthy record and an unreachable store', async () => {
      await KeyManager.createIdentity();
      wipeUidKeystore();

      store.value = '{"version":1,"privateKey":"zz","publicKey":"00","updatedAt":"x"}';
      expect(await KeyManager.attemptIdentityRecovery()).toEqual({ recovered: false, reason: 'no-sources' });

      store.value = 'not json';
      expect(await KeyManager.attemptIdentityRecovery()).toEqual({ recovered: false, reason: 'no-sources' });

      store.failReads = true;
      expect(await KeyManager.attemptIdentityRecovery()).toEqual({ recovered: false, reason: 'no-sources' });
    });

    it('a fresh device with no backup stays absent', async () => {
      expect(await KeyManager.attemptIdentityRecovery()).toEqual({ recovered: false, reason: 'not-lost' });
    });
  });

  describe('delete', () => {
    it('every delete clears the backup, so a deleted identity never comes back', async () => {
      await KeyManager.createIdentity();
      expect(store.value).not.toBeNull();
      await KeyManager.deleteIdentity(true, true, true);
      expect(store.value).toBeNull();
      expect(await KeyManager.attemptIdentityRecovery()).toEqual({ recovered: false, reason: 'not-lost' });
    });

    it('a user-confirmed, non-forced delete clears it too', async () => {
      await KeyManager.createIdentity();
      await KeyManager.deleteIdentity(false, false, true);
      expect(store.value).toBeNull();
    });
  });
});
