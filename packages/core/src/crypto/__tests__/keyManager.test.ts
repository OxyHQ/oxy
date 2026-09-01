/**
 * Tests for KeyManager safety invariants.
 *
 * These tests pin down the no-clobber guarantees that protect users from
 * permanent account loss. Every scenario below corresponds to a real bug
 * that COULD silently destroy an account's only copy of the private key:
 *
 *   1. createIdentity() must refuse to overwrite an existing identity
 *      unless { overwrite: true } is passed.
 *   2. importKeyPair() must refuse to clobber a DIFFERENT existing identity.
 *   3. importKeyPair() with the SAME phrase should be idempotent.
 *   4. After createIdentity(), hasIdentity() must report true AND
 *      verifyIdentityIntegrity() must succeed AND a backup must exist.
 *   5. RecoveryPhraseService must be a function (same phrase always
 *      produces the same public key).
 *   6. RecoveryPhraseService round-trip: derive phrase → restore phrase
 *      must yield the exact same public key.
 *   7. restoreIdentityFromBackup() must refuse to overwrite a verifying
 *      primary, and must refuse to switch the user to a different
 *      identity when the backup public key doesn't match the (broken)
 *      primary public key.
 */

import { setPlatformOS } from '../../utils/platform';

// Mock expo-secure-store BEFORE importing KeyManager so the lazy import
// inside keyManager picks up our in-memory implementation. The shared mock keys
// entries by `(keychainService ?? 'default') + ' ' + key` so the v2 slot layout
// (primary service `oxy_identity`, backup service `oxy_identity_backup`) is
// modeled faithfully.
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
      // Deterministic-but-distinct random for tests
      const out = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        out[i] = (Math.random() * 256) & 0xff;
      }
      return out;
    },
    digestStringAsync: async () => '0'.repeat(64),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  }),
  { virtual: true },
);

// Production code routes platform-specific module loads through
// `@oxyhq/protocol`'s `platform/crypto`, which ships in two physical variants
// on disk (`crypto.ts` / `crypto.native.ts`) selected by the consumer's
// bundler. Jest runs on Node — it picks the default variant, which references
// Node's built-in `crypto`, not `expo-*`. For the test suite to exercise the
// RN code paths, we override only the platform loaders to delegate to the
// virtual `expo-*` modules registered above, keeping every other protocol
// export (canonical bytes, signing, the platform predicates) real. AsyncStorage
// is a real in-memory map so the identity marker + advisory migration flag work.
jest.mock('@oxyhq/protocol', () => {
  const actual = jest.requireActual('@oxyhq/protocol');
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

// v2 slot key names + keychain services (must match keyManager.ts).
const PRIMARY_SVC = 'oxy_identity';
const BACKUP_SVC = 'oxy_identity_backup';
const V2_PRIV = 'oxy_identity_private_key_v2';
const V2_PUB = 'oxy_identity_public_key_v2';
const V2_BPRIV = 'oxy_identity_backup_private_key_v2';
const V2_BPUB = 'oxy_identity_backup_public_key_v2';
const V2_BTS = 'oxy_identity_backup_timestamp_v2';

interface SecureStoreTestHandle {
  __resetStore__: () => void;
  __getRaw__: (key: string, service?: string) => string | null;
  __setRaw__: (key: string, value: string, service?: string) => void;
  __deleteRaw__: (key: string, service?: string) => void;
}

describe('KeyManager safety invariants', () => {
  let KeyManager: typeof import('../keyManager').KeyManager;
  let IdentityAlreadyExistsError: typeof import('../keyManager').IdentityAlreadyExistsError;
  let RecoveryPhraseService: typeof import('../recoveryPhrase').RecoveryPhraseService;

  beforeAll(() => {
    // KeyManager refuses to operate on 'web'; pretend we're on iOS for tests.
    setPlatformOS('ios');
    // navigator.product is checked by some helpers; set it for RN-detection.
    (globalThis as any).navigator = { product: 'ReactNative' };
  });

  beforeEach(async () => {
    jest.resetModules();
    setPlatformOS('ios');
    const secureStore = (await import('expo-secure-store' as string)) as unknown as {
      __resetStore__: () => void;
    };
    secureStore.__resetStore__();

    const km = await import('../keyManager');
    KeyManager = km.KeyManager;
    IdentityAlreadyExistsError = km.IdentityAlreadyExistsError;
    resetCaches();

    const rp = await import('../recoveryPhrase');
    RecoveryPhraseService = rp.RecoveryPhraseService;
  });

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

  describe('createIdentity', () => {
    it('persists a complete identity with backup on first call', async () => {
      const publicKey = await KeyManager.createIdentity();
      expect(publicKey).toMatch(/^[0-9a-f]+$/i);

      expect(await KeyManager.hasIdentity()).toBe(true);
      expect(await KeyManager.verifyIdentityIntegrity()).toBe(true);
      // Backup was written to the isolated v2 backup slot as part of the atomic persist
      const store = (await import('expo-secure-store' as string)) as unknown as SecureStoreTestHandle;
      expect(store.__getRaw__(V2_BPRIV, BACKUP_SVC)).toBeTruthy();
      expect(store.__getRaw__(V2_BPUB, BACKUP_SVC)).toBeTruthy();
      expect(store.__getRaw__(V2_BTS, BACKUP_SVC)).toBeTruthy();
    });

    it('refuses to overwrite an existing identity without explicit consent', async () => {
      const firstPublicKey = await KeyManager.createIdentity();
      await expect(KeyManager.createIdentity()).rejects.toBeInstanceOf(IdentityAlreadyExistsError);
      // Original identity is unchanged
      expect(await KeyManager.getPublicKey()).toBe(firstPublicKey);
    });

    it('allows overwrite when explicitly requested', async () => {
      const firstPublicKey = await KeyManager.createIdentity();
      const secondPublicKey = await KeyManager.createIdentity({ overwrite: true });
      expect(secondPublicKey).not.toBe(firstPublicKey);
      expect(await KeyManager.getPublicKey()).toBe(secondPublicKey);
    });
  });

  describe('importKeyPair', () => {
    it('refuses to clobber a DIFFERENT existing identity', async () => {
      await KeyManager.createIdentity();
      // Generate a separate identity to attempt importing
      const otherPrivate = (await KeyManager.generateKeyPair()).privateKey;
      await expect(KeyManager.importKeyPair(otherPrivate)).rejects.toBeInstanceOf(
        IdentityAlreadyExistsError,
      );
    });

    it('is a no-op refresh when importing the SAME identity', async () => {
      const firstPublic = await KeyManager.createIdentity();
      const currentPrivate = await KeyManager.getPrivateKey();
      if (!currentPrivate) throw new Error('expected private key');
      const reimported = await KeyManager.importKeyPair(currentPrivate);
      expect(reimported).toBe(firstPublic);
      expect(await KeyManager.getPublicKey()).toBe(firstPublic);
    });

    it('rejects invalid private keys', async () => {
      await expect(KeyManager.importKeyPair('not-hex')).rejects.toThrow(/Invalid private key/);
    });
  });

  describe('hasIdentity', () => {
    it('returns false when no identity is stored', async () => {
      expect(await KeyManager.hasIdentity()).toBe(false);
    });

    it('returns false when only the private key was written (partial state)', async () => {
      const store = (await import('expo-secure-store' as string)) as unknown as SecureStoreTestHandle;
      // Simulate a half-written identity: private without public
      store.__setRaw__(V2_PRIV, 'a'.repeat(64), PRIMARY_SVC);
      // Invalidate cache so the next call re-reads
      resetCaches();
      expect(await KeyManager.hasIdentity()).toBe(false);
    });

    it('returns false when the stored public key does not derive from the private key', async () => {
      await KeyManager.createIdentity();
      const store = (await import('expo-secure-store' as string)) as unknown as SecureStoreTestHandle;
      // Tamper with the stored public key
      store.__setRaw__(V2_PUB, '04' + 'b'.repeat(128), PRIMARY_SVC);
      resetCaches();
      expect(await KeyManager.hasIdentity()).toBe(false);
    });
  });

  describe('verifyIdentityIntegrity', () => {
    it('returns true for a fresh identity', async () => {
      await KeyManager.createIdentity();
      expect(await KeyManager.verifyIdentityIntegrity()).toBe(true);
    });

    it('returns false when the stored keys do not match', async () => {
      await KeyManager.createIdentity();
      const store = (await import('expo-secure-store' as string)) as unknown as SecureStoreTestHandle;
      store.__setRaw__(V2_PUB, '04' + 'c'.repeat(128), PRIMARY_SVC);
      resetCaches();
      expect(await KeyManager.verifyIdentityIntegrity()).toBe(false);
    });
  });

  describe('restoreIdentityFromBackup', () => {
    it('does NOT overwrite a verifying primary', async () => {
      const firstPublic = await KeyManager.createIdentity();
      const restored = await KeyManager.restoreIdentityFromBackup();
      expect(restored).toBe(false);
      // Primary unchanged
      expect(await KeyManager.getPublicKey()).toBe(firstPublic);
    });

    it('refuses to restore if the backup public key does not match a still-present (broken) primary', async () => {
      await KeyManager.createIdentity();
      const store = (await import('expo-secure-store' as string)) as unknown as SecureStoreTestHandle;
      // Corrupt the primary public key (so integrity fails), but leave the
      // broken primary in place. The backup will not match.
      store.__setRaw__(V2_PUB, '04' + 'd'.repeat(128), PRIMARY_SVC);
      // Tamper with the backup too — write a backup from a completely
      // different identity.
      const otherPair = await KeyManager.generateKeyPair();
      store.__setRaw__(V2_BPRIV, otherPair.privateKey, BACKUP_SVC);
      store.__setRaw__(V2_BPUB, otherPair.publicKey, BACKUP_SVC);
      resetCaches();

      const restored = await KeyManager.restoreIdentityFromBackup();
      expect(restored).toBe(false);
      // The (corrupted) primary public key should be unchanged, not the
      // attacker-backup public key.
      expect(store.__getRaw__(V2_PUB, PRIMARY_SVC)).not.toBe(otherPair.publicKey);
    });

    it('restores a missing primary from a valid backup', async () => {
      const original = await KeyManager.createIdentity();
      const store = (await import('expo-secure-store' as string)) as unknown as SecureStoreTestHandle;
      // Wipe primary only
      store.__deleteRaw__(V2_PRIV, PRIMARY_SVC);
      store.__deleteRaw__(V2_PUB, PRIMARY_SVC);
      resetCaches();

      const restored = await KeyManager.restoreIdentityFromBackup();
      expect(restored).toBe(true);
      expect(await KeyManager.getPublicKey()).toBe(original);
      expect(await KeyManager.verifyIdentityIntegrity()).toBe(true);
    });
  });

  describe('RecoveryPhraseService round-trip determinism', () => {
    it('always derives the SAME public key from the same phrase', async () => {
      const result = await RecoveryPhraseService.generateIdentityWithRecovery();
      const phrase = result.phrase;
      const firstPublicKey = result.publicKey;

      // Restore on a "clean device" — wipe and re-import via phrase
      const store = (await import('expo-secure-store' as string)) as unknown as {
        __resetStore__: () => void;
      };
      store.__resetStore__();
      (KeyManager as unknown as { cachedPublicKey: unknown; cachedHasIdentity: unknown }).cachedPublicKey = null;
      (KeyManager as unknown as { cachedPublicKey: unknown; cachedHasIdentity: unknown }).cachedHasIdentity = null;

      const restoredPublicKey = await RecoveryPhraseService.restoreFromPhrase(phrase);
      expect(restoredPublicKey).toBe(firstPublicKey);
    });

    it('derivePublicKeyFromPhrase matches the result of restoreFromPhrase', async () => {
      const { phrase, publicKey } = await RecoveryPhraseService.generateIdentityWithRecovery();
      const derived = await RecoveryPhraseService.derivePublicKeyFromPhrase(phrase);
      expect(derived).toBe(publicKey);
    });

    it('refuses to overwrite an existing different identity during restore', async () => {
      const a = await RecoveryPhraseService.generateIdentityWithRecovery();
      // Reset cache but keep the on-device identity
      (KeyManager as unknown as { cachedPublicKey: unknown; cachedHasIdentity: unknown }).cachedPublicKey = null;
      (KeyManager as unknown as { cachedPublicKey: unknown; cachedHasIdentity: unknown }).cachedHasIdentity = null;

      // Manually generate a different phrase
      const { generateMnemonic } = await import('@scure/bip39');
      const { wordlist } = await import('@scure/bip39/wordlists/english');
      const otherPhrase = generateMnemonic(wordlist, 128);
      // Sanity check phrases are different
      expect(otherPhrase).not.toBe(a.phrase);

      await expect(RecoveryPhraseService.restoreFromPhrase(otherPhrase)).rejects.toBeInstanceOf(
        IdentityAlreadyExistsError,
      );
    });

    it('rejects invalid phrases', async () => {
      await expect(
        RecoveryPhraseService.restoreFromPhrase('not a real phrase at all'),
      ).rejects.toThrow(/Invalid recovery phrase/);
    });
  });
});
