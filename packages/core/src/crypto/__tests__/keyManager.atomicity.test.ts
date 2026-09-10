/**
 * Tests for KeyManager atomic-write & backup-restore safety under FLAKY storage.
 *
 * These pin the "never leave the device with zero recoverable copies of a
 * healthy identity" invariant. Each scenario corresponds to a real
 * account-loss / account-switch bug that a half-failed SecureStore write could
 * otherwise cause:
 *
 *   1. A failed OVERWRITE must roll the primary back to the ORIGINAL identity
 *      and must keep a recoverable backup of it — never switch to the
 *      half-written new identity.
 *   2. A transient read failure must not cause restoreIdentityFromBackup() to
 *      clobber a healthy-but-momentarily-locked primary with a stale backup.
 *   3. restoreIdentityFromBackup() must refuse when the backup identifies a
 *      different account than a private key still present in the primary slot.
 *   4. A first-time create still writes a backup (no regression).
 *
 * The identity now lives in the isolated v2 slots (primary service `oxy_identity`,
 * backup service `oxy_identity_backup`), so assertions read/write via the
 * service-scoped mock helpers.
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

// v2 slot key names + keychain services (must match keyManager.ts).
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
  __deleteRaw__: (key: string, service?: string) => void;
  __failPlan__: { failKey?: string; failOp?: 'set' | 'get'; failTimes?: number; failService?: string };
}

describe('KeyManager atomicity & recoverability under flaky storage', () => {
  let KeyManager: typeof import('../keyManager').KeyManager;

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
    const ss = (await import('expo-secure-store' as string)) as unknown as SecureStoreTestHandle;
    ss.__resetStore__();
    const km = await import('../keyManager');
    KeyManager = km.KeyManager;
    resetCaches();
  });

  it('a failed OVERWRITE leaves the ORIGINAL identity intact and recoverable (no silent switch)', async () => {
    const originalPublic = await KeyManager.createIdentity();
    const ss = (await import('expo-secure-store' as string)) as unknown as SecureStoreTestHandle;
    const originalPriv = ss.__getRaw__(V2_PRIV, PRIMARY_SVC);
    resetCaches();

    // The new primary private write fails mid-overwrite.
    ss.__failPlan__.failOp = 'set';
    ss.__failPlan__.failKey = V2_PRIV;
    ss.__failPlan__.failService = PRIMARY_SVC;
    await expect(KeyManager.createIdentity({ overwrite: true })).rejects.toBeDefined();

    // Recover from the simulated fault.
    ss.__failPlan__.failKey = undefined;
    ss.__failPlan__.failOp = undefined;
    ss.__failPlan__.failService = undefined;
    resetCaches();

    // Primary must still be the original identity (rolled back).
    expect(await KeyManager.hasIdentity()).toBe(true);
    expect(await KeyManager.getPublicKey()).toBe(originalPublic);
    expect(ss.__getRaw__(V2_PRIV, PRIMARY_SVC)).toBe(originalPriv);

    // And the backup must still hold the ORIGINAL identity, never the new one.
    expect(ss.__getRaw__(V2_BPRIV, BACKUP_SVC)).toBe(originalPriv);
    expect(ss.__getRaw__(V2_BPUB, BACKUP_SVC)).toBe(originalPublic);
  });

  it('a failed final backup refresh rejects and rolls back instead of succeeding with a stale backup', async () => {
    const originalPublic = await KeyManager.createIdentity();
    const ss = (await import('expo-secure-store' as string)) as unknown as SecureStoreTestHandle;
    const originalPriv = ss.__getRaw__(V2_PRIV, PRIMARY_SVC);
    resetCaches();

    // Let the new primary write and verify, then fail exactly once while
    // refreshing the backup to the new identity. This used to return success
    // with primary=B and backup=A, enabling a later absent-primary restore to
    // silently switch back to A.
    ss.__failPlan__.failOp = 'set';
    ss.__failPlan__.failKey = V2_BPUB;
    ss.__failPlan__.failService = BACKUP_SVC;
    ss.__failPlan__.failTimes = 1;
    await expect(KeyManager.createIdentity({ overwrite: true })).rejects.toBeDefined();

    resetCaches();

    // The operation failed atomically: primary and backup both still identify
    // the original account, so callers cannot observe success with a stale
    // cross-account backup.
    expect(await KeyManager.hasIdentity()).toBe(true);
    expect(await KeyManager.getPublicKey()).toBe(originalPublic);
    expect(ss.__getRaw__(V2_PRIV, PRIMARY_SVC)).toBe(originalPriv);
    expect(ss.__getRaw__(V2_PUB, PRIMARY_SVC)).toBe(originalPublic);
    expect(ss.__getRaw__(V2_BPRIV, BACKUP_SVC)).toBe(originalPriv);
    expect(ss.__getRaw__(V2_BPUB, BACKUP_SVC)).toBe(originalPublic);
  });

  it('restoreIdentityFromBackup does NOT clobber a healthy primary that is only transiently unreadable', async () => {
    const original = await KeyManager.createIdentity();
    const ss = (await import('expo-secure-store' as string)) as unknown as SecureStoreTestHandle;

    // Put a DIFFERENT identity in the backup slot (simulates a stale backup
    // from a previous account that a failed backup-refresh left behind).
    const other = await KeyManager.generateKeyPair();
    ss.__setRaw__(V2_BPRIV, other.privateKey, BACKUP_SVC);
    ss.__setRaw__(V2_BPUB, other.publicKey, BACKUP_SVC);
    resetCaches();

    // Make the primary PRIVATE read throw (transient keychain lock).
    ss.__failPlan__.failOp = 'get';
    ss.__failPlan__.failKey = V2_PRIV;
    ss.__failPlan__.failService = PRIMARY_SVC;

    const restored = await KeyManager.restoreIdentityFromBackup();
    expect(restored).toBe(false); // refused — transient read must not trigger a restore

    // Clear the fault; the original primary must be intact and unchanged.
    ss.__failPlan__.failKey = undefined;
    ss.__failPlan__.failOp = undefined;
    ss.__failPlan__.failService = undefined;
    resetCaches();
    expect(await KeyManager.getPublicKey()).toBe(original);
    expect(ss.__getRaw__(V2_PUB, PRIMARY_SVC)).toBe(original);
  });

  it('restoreIdentityFromBackup refuses when a present primary private key identifies a different account than the backup', async () => {
    // Primary holds identity A (valid). Corrupt ONLY the public key so the
    // primary fails its consistency check but the private key still derives a
    // real, different identity than the backup.
    const a = await KeyManager.createIdentity();
    const ss = (await import('expo-secure-store' as string)) as unknown as SecureStoreTestHandle;

    // Backup holds a DIFFERENT identity B.
    const b = await KeyManager.generateKeyPair();
    ss.__setRaw__(V2_BPRIV, b.privateKey, BACKUP_SVC);
    ss.__setRaw__(V2_BPUB, b.publicKey, BACKUP_SVC);
    // Corrupt A's stored public key (private key A still present & valid).
    ss.__setRaw__(V2_PUB, `04${'e'.repeat(128)}`, PRIMARY_SVC);
    resetCaches();

    const restored = await KeyManager.restoreIdentityFromBackup();
    expect(restored).toBe(false);
    // Must NOT have switched the primary to B.
    expect(ss.__getRaw__(V2_PUB, PRIMARY_SVC)).not.toBe(b.publicKey);
    expect(ss.__getRaw__(V2_PRIV, PRIMARY_SVC)).not.toBe(b.privateKey);
    // The original A private key is still in place (untouched).
    expect(KeyManager.derivePublicKey(ss.__getRaw__(V2_PRIV, PRIMARY_SVC) as string)).toBe(a);
  });

  it('a failed primary write during the post-rotation importKeyPair leaves the OLD key recoverable from backup', async () => {
    // b3 key rotation: the server has already swapped to the NEW key; the device
    // now commits it via importKeyPair({overwrite:true}). If that write fails
    // mid-overwrite, the OLD key MUST remain intact and recoverable — never a
    // half-written new identity that can't be decrypted or backed up.
    const oldPublic = await KeyManager.createIdentity();
    const ss = (await import('expo-secure-store' as string)) as unknown as SecureStoreTestHandle;
    const oldPriv = ss.__getRaw__(V2_PRIV, PRIMARY_SVC);
    resetCaches();

    // The NEW rotated key material (generateKeyPair does NOT persist).
    const rotated = await KeyManager.generateKeyPair();

    // The new primary private write fails mid-commit.
    ss.__failPlan__.failOp = 'set';
    ss.__failPlan__.failKey = V2_PRIV;
    ss.__failPlan__.failService = PRIMARY_SVC;
    await expect(KeyManager.importKeyPair(rotated.privateKey, { overwrite: true })).rejects.toBeDefined();

    // Recover from the simulated fault.
    ss.__failPlan__.failKey = undefined;
    ss.__failPlan__.failOp = undefined;
    ss.__failPlan__.failService = undefined;
    resetCaches();

    // Primary is STILL the old identity (rolled back — never the new one).
    expect(await KeyManager.hasIdentity()).toBe(true);
    expect(await KeyManager.getPublicKey()).toBe(oldPublic);
    expect(ss.__getRaw__(V2_PRIV, PRIMARY_SVC)).toBe(oldPriv);
    // And the backup still holds the OLD identity, so the user can recover it.
    expect(ss.__getRaw__(V2_BPRIV, BACKUP_SVC)).toBe(oldPriv);
    expect(ss.__getRaw__(V2_BPUB, BACKUP_SVC)).toBe(oldPublic);
  });

  it('restores a provably-absent primary from a valid backup', async () => {
    const original = await KeyManager.createIdentity();
    const ss = (await import('expo-secure-store' as string)) as unknown as SecureStoreTestHandle;
    // Wipe the primary entirely (backup remains).
    ss.__deleteRaw__(V2_PRIV, PRIMARY_SVC);
    ss.__deleteRaw__(V2_PUB, PRIMARY_SVC);
    resetCaches();

    const restored = await KeyManager.restoreIdentityFromBackup();
    expect(restored).toBe(true);
    expect(await KeyManager.getPublicKey()).toBe(original);
    expect(await KeyManager.verifyIdentityIntegrity()).toBe(true);
  });
});
