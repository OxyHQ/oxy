/**
 * Key Manager - ECDSA secp256k1 Key Generation and Storage
 *
 * Handles secure generation, storage, and retrieval of cryptographic keys.
 * Private keys are stored securely using expo-secure-store and never leave the device.
 */

import { ec as EC } from 'elliptic';
import { isWeb, isIOS, isAndroid } from '../utils/platform';
import { type ExpoCryptoLike, type ExpoSecureStoreLike, isReactNative, isNodeJS, loadAsyncStorage, loadExpoCrypto, loadNodeCrypto, loadSecureStore, loadSharedIdentityBridge } from '@oxyhq/protocol';
import { isDev, logger } from '../logger';
import { hkdfSha256 } from './kdf';
import {
  type IdentityMarker,
  clearIdentityMarker,
  readIdentityMarker,
  updateIdentityMarker,
  writeIdentityMarker,
} from './identityMarker';

/**
 * Options for expo-secure-store calls made by KeyManager.
 *
 * Defined as a standalone interface (not extending expo-secure-store's
 * `SecureStoreOptions`) so that server / Node.js consumers of @oxyhq/core
 * do not transitively pull in expo-modules-core's type declarations under
 * NodeNext module resolution (which would cause NodeJS.Timeout / number
 * pollution across all timer APIs). The fields mirror SecureStoreOptions
 * exactly — any object satisfying this interface is safe to pass to the
 * real expo-secure-store methods (which accept `options?: object`).
 */
interface OxySecureStoreOptions {
  /** Keychain service name (Android keystore / iOS keychain tag). */
  keychainService?: string;
  /**
   * Keychain / Keystore item accessibility. Use the constants from the
   * `ExpoSecureStoreLike` handle returned by `initSecureStore()`, e.g.
   * `store.WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
   */
  keychainAccessible?: number;
  /** Prompt shown to the user for biometric/auth-protected items. */
  authenticationPrompt?: string;
  /** Whether Face ID / Touch ID / biometric auth is required to read the item. */
  requireAuthentication?: boolean;
  /**
   * iOS Keychain access group. Required for sharing identity material across
   * apps in the Oxy ecosystem via Keychain Sharing entitlements.
   */
  keychainAccessGroup?: string;
}

/**
 * Thrown when an identity-mutating operation (createIdentity / importKeyPair)
 * is invoked while a valid identity already exists on the device.
 *
 * The local private key IS the user's identity — overwriting it without
 * explicit consent permanently loses access to their account (unless
 * they previously saved their recovery phrase). This error forces callers
 * to make an explicit, audited decision instead of silently clobbering.
 */
export class IdentityAlreadyExistsError extends Error {
  override readonly name = 'IdentityAlreadyExistsError';
  readonly existingPublicKey: string;
  constructor(existingPublicKey: string) {
    super(
      'An identity already exists on this device. Refusing to overwrite without explicit consent. ' +
        'If you really want to replace it, ensure the user has saved their recovery phrase, then call ' +
        'the operation with { overwrite: true }.'
    );
    this.existingPublicKey = existingPublicKey;
  }
}

/**
 * Thrown when a freshly written identity cannot be read back, parsed, or
 * round-tripped through sign/verify. Indicates a storage failure or
 * corruption that would otherwise silently leave the user with an
 * unusable account.
 */
export class IdentityPersistError extends Error {
  override readonly name = 'IdentityPersistError';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

/**
 * Thrown when identity storage cannot be read/written right now — the keychain
 * is locked, the module failed to load, or a read threw — as opposed to the
 * identity being genuinely absent.
 *
 * This is the crux of the corruption-vs-fresh-install fix: a storage THROW must
 * NEVER be flattened into "no identity" (the old behavior, which let onboarding
 * treat a momentarily-locked keystore as a blank device). Callers that used to
 * tolerate a `false`/`null` from `hasIdentity()`/`getPublicKey()` on error must
 * now treat this typed error as "cannot determine" — retry, surface a locked
 * state, or abort a destructive path — never as "safe to create/overwrite".
 */
export class IdentityUnavailableError extends Error {
  override readonly name = 'IdentityUnavailableError';
  constructor(message: string, readonly cause?: unknown) {
    super(message);
  }
}

/**
 * Authoritative tri-state (plus `unavailable`) verdict on the on-device
 * identity, from {@link KeyManager.getIdentityStatus}.
 *
 * - `present`  — a healthy, round-tripping key pair exists.
 * - `absent`   — storage read succeeded and returned nothing, AND no marker
 *                records a prior identity → a genuine fresh device. The ONLY
 *                state that may route to create/onboarding.
 * - `lost`     — storage read succeeded but the keys are empty/unreadable while
 *                the independent {@link IdentityMarker} records that an identity
 *                DID exist here → corruption/keystore death. Route to recovery,
 *                NEVER to create.
 * - `unavailable` — a storage read THREW (keychain locked, module load failure).
 *                Transient by assumption; NEVER cached; callers retry.
 */
export type IdentityStatus =
  | { state: 'present'; publicKey: string }
  | { state: 'absent' }
  | { state: 'lost'; marker: IdentityMarker }
  | { state: 'unavailable'; cause: unknown };

/**
 * Result of {@link KeyManager.attemptIdentityRecovery}. On success it reports
 * which independent, `key_v1`-surviving source restored the identity. On failure
 * `reason` distinguishes "wasn't lost", "no surviving source", "a source held a
 * DIFFERENT account" (never silently switched), and "storage unavailable".
 */
export type IdentityRecoveryResult =
  | { recovered: true; source: 'backup' | 'shared'; publicKey: string }
  | { recovered: false; reason: 'not-lost' | 'no-sources' | 'mismatch' | 'unavailable' };

const ec = new EC('secp256k1');

/**
 * HKDF salt that domain-separates every identity-scoped seed produced by
 * {@link KeyManager.deriveScopedSeed}. Versioned so a future scheme change is a
 * new, non-colliding tag. The per-app domain (e.g. Oxy Pay's FairCoin wallet)
 * is carried by the caller's `info` string, not this salt.
 */
const SCOPED_SEED_KDF_SALT = 'oxy-identity-scoped-seed-v1';

/** UTF-8 encode an ASCII label to bytes (HKDF salt/info). */
function utf8ToBytes(label: string): Uint8Array {
  return new TextEncoder().encode(label);
}

/** Decode a hex string to bytes. Inverse of {@link uint8ArrayToHex}. */
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const STORAGE_KEYS = {
  PRIVATE_KEY: 'oxy_identity_private_key',
  PUBLIC_KEY: 'oxy_identity_public_key',
  BACKUP_PRIVATE_KEY: 'oxy_identity_backup_private_key',
  BACKUP_PUBLIC_KEY: 'oxy_identity_backup_public_key',
  BACKUP_TIMESTAMP: 'oxy_identity_backup_timestamp',
  // Shared keys accessible across all Oxy apps (iOS Keychain Group / Android Account Manager)
  SHARED_PRIVATE_KEY: 'oxy_shared_identity_private_key',
  SHARED_PUBLIC_KEY: 'oxy_shared_identity_public_key',
  SHARED_SESSION_TOKEN: 'oxy_shared_session_token',
  SHARED_SESSION_ID: 'oxy_shared_session_id',
} as const;

/**
 * v2 identity slot layout — blast-radius isolation.
 *
 * The legacy keys above were written WITHOUT a `keychainService`, so on Android
 * they all shared expo-secure-store's single default `key_v1` AndroidKeyStore
 * key — meaning ONE keystore invalidation deleted the primary AND the backup
 * together (the exact loss this hardening closes). The v2 layout gives the
 * primary and the backup DISTINCT keychain services (→ independent AndroidKeyStore
 * keys, independent iOS keychain items), so they can no longer die together, and
 * DISTINCT key names (`_v2`) so the post-copy migration verify can only observe
 * what it actually wrote (old/new locations are non-aliasable).
 *
 * Migration from the legacy layout is lazy + verify-before-delete — see
 * {@link KeyManager._runSlotMigration}.
 */
const V2_PRIMARY_KEYCHAIN_SERVICE = 'oxy_identity';
const V2_BACKUP_KEYCHAIN_SERVICE = 'oxy_identity_backup';

const V2_STORAGE_KEYS = {
  PRIVATE_KEY: 'oxy_identity_private_key_v2',
  PUBLIC_KEY: 'oxy_identity_public_key_v2',
  BACKUP_PRIVATE_KEY: 'oxy_identity_backup_private_key_v2',
  BACKUP_PUBLIC_KEY: 'oxy_identity_backup_public_key_v2',
  BACKUP_TIMESTAMP: 'oxy_identity_backup_timestamp_v2',
} as const;

/**
 * Dedicated keychain slot for the recovery mnemonic (the 12-word phrase).
 *
 * Stored under its OWN keychain service — distinct from the v2 primary, backup,
 * and shared slots — so it shares an AndroidKeyStore key with none of them
 * (blast-radius isolation, same rationale as the v2 primary/backup split).
 * Written `WHEN_UNLOCKED_THIS_DEVICE_ONLY` and NEVER exported off-device: it
 * exists solely so the user can RE-READ their phrase from Settings on the SAME
 * device that generated/imported it.
 *
 * This is convenience persistence, NOT a recovery mechanism — a keystore death
 * wipes it alongside the keys, exactly like the private key itself. The user's
 * written-down phrase remains the sole out-of-band recovery path. The mnemonic
 * lives ONLY in this slot: it is never mirrored into the identity marker,
 * {@link KeyManager.getIdentityStatus}, logs, or any exported bundle.
 */
const RECOVERY_MNEMONIC_KEYCHAIN_SERVICE = 'oxy_identity_mnemonic';
const RECOVERY_MNEMONIC_STORAGE_KEY = 'oxy_identity_mnemonic_v1';

/**
 * Advisory AsyncStorage fast-path flag: set once the v2 slots own the identity.
 * Re-derivable (its loss just re-runs the cheap slot check), so it lives in
 * plain AsyncStorage rather than the keychain. It only SKIPS re-reading the
 * legacy slots on an already-migrated device; it is never trusted over an actual
 * v2 read (a set flag with an unhealthy v2 pair falls through to full migration).
 */
const SLOTS_MIGRATED_FLAG_KEY = 'oxy_identity_slots_migrated_v2';

/**
 * The resolved set of storage key names + keychain services a session reads and
 * writes. Normally {@link V2_SLOT_LAYOUT}; degrades to {@link LEGACY_SLOT_LAYOUT}
 * for the current session only when a v2 migration write could not be verified
 * (so the user is never locked out of a still-readable legacy identity).
 */
interface ResolvedSlotLayout {
  primaryService?: string;
  primaryPrivateKeyName: string;
  primaryPublicKeyName: string;
  backupService?: string;
  backupPrivateKeyName: string;
  backupPublicKeyName: string;
  backupTimestampName: string;
}

const V2_SLOT_LAYOUT: ResolvedSlotLayout = {
  primaryService: V2_PRIMARY_KEYCHAIN_SERVICE,
  primaryPrivateKeyName: V2_STORAGE_KEYS.PRIVATE_KEY,
  primaryPublicKeyName: V2_STORAGE_KEYS.PUBLIC_KEY,
  backupService: V2_BACKUP_KEYCHAIN_SERVICE,
  backupPrivateKeyName: V2_STORAGE_KEYS.BACKUP_PRIVATE_KEY,
  backupPublicKeyName: V2_STORAGE_KEYS.BACKUP_PUBLIC_KEY,
  backupTimestampName: V2_STORAGE_KEYS.BACKUP_TIMESTAMP,
};

const LEGACY_SLOT_LAYOUT: ResolvedSlotLayout = {
  primaryService: undefined,
  primaryPrivateKeyName: STORAGE_KEYS.PRIVATE_KEY,
  primaryPublicKeyName: STORAGE_KEYS.PUBLIC_KEY,
  backupService: undefined,
  backupPrivateKeyName: STORAGE_KEYS.BACKUP_PRIVATE_KEY,
  backupPublicKeyName: STORAGE_KEYS.BACKUP_PUBLIC_KEY,
  backupTimestampName: STORAGE_KEYS.BACKUP_TIMESTAMP,
};

/**
 * Outcome of the one-time-per-process slot migration. `deferred` means a read
 * threw (keychain locked) — nothing was written or deleted, and every accessor
 * treats it as `unavailable` (surfaced, never cached) so a later call retries.
 */
type SlotMigrationResult =
  | { mode: 'v2'; layout: ResolvedSlotLayout }
  | { mode: 'legacy'; layout: ResolvedSlotLayout }
  | { mode: 'deferred'; cause: unknown };

/**
 * iOS Keychain Access Group for sharing identities across Oxy apps
 * All Oxy apps must have this access group enabled in their entitlements
 * Format: [Team ID].so.oxy.shared or group.so.oxy.shared
 */
const IOS_KEYCHAIN_GROUP = 'group.so.oxy.shared';

/**
 * Android Account Manager type for shared authentication
 * Used with sharedUserId to share sessions across apps
 */
const ANDROID_ACCOUNT_TYPE = 'com.oxy.account';

/**
 * Initialize React Native specific modules
 *
 * Delegates to `@oxyhq/protocol`'s `platform/crypto`, a per-platform module
 * (`crypto.ts` vs `crypto.native.ts`) selected by the
 * consumer's bundler. On RN it returns a statically-imported handle to
 * `expo-secure-store`; off RN it throws (and is never called because every
 * caller is gated by `isWebPlatform()` / native-only paths).
 */
async function initSecureStore(): Promise<ExpoSecureStoreLike> {
  try {
    return await loadSecureStore();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load expo-secure-store: ${errorMessage}. ` +
        'Make sure expo-secure-store is installed and properly configured.',
    );
  }
}

/**
 * Check if we're on web platform
 * Identity storage is only available on native platforms (iOS/Android)
 */
function isWebPlatform(): boolean {
  return isWeb();
}

async function initExpoCrypto(): Promise<ExpoCryptoLike> {
  // Same per-platform delegation as initSecureStore — see comment there.
  return loadExpoCrypto();
}

/**
 * Convert Uint8Array to hexadecimal string
 * Works in both Node.js and React Native
 */
function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate cryptographically secure random bytes
 */
async function getSecureRandomBytes(length: number): Promise<Uint8Array> {
  // In React Native, always use expo-crypto
  if (isReactNative() || !isNodeJS()) {
    const Crypto = await initExpoCrypto();
    return Crypto.getRandomBytes(length);
  }
  
  // In Node.js, use Node's crypto module.
  //
  // `loadNodeCrypto` is per-platform: the default variant performs
  // `await import('crypto')`, the RN variant throws (and we'd never reach
  // here on RN because the early-return above caught it).
  try {
    const nodeCrypto = await loadNodeCrypto();
    return new Uint8Array(nodeCrypto.randomBytes(length));
  } catch (error) {
    // Fallback to expo-crypto if Node crypto fails (defensive — should not
    // happen on real Node, but the platform-detection edge cases are
    // surprisingly varied).
    const Crypto = await initExpoCrypto();
    return Crypto.getRandomBytes(length);
  }
}

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

export class KeyManager {
  // In-memory cache for identity state (invalidated on identity changes)
  private static cachedPublicKey: string | null = null;
  private static cachedHasIdentity: boolean | null = null;
  private static cachedSharedPublicKey: string | null = null;
  private static cachedHasSharedIdentity: boolean | null = null;
  /**
   * Distinguishes "public key genuinely absent (a successful empty read, safe to
   * cache)" from "never resolved / storage threw (must NOT be cached)". A `null`
   * {@link cachedPublicKey} alone is ambiguous — this flag makes the genuine
   * absence cacheable WITHOUT ever caching a null produced by a thrown read.
   */
  private static cachedPublicKeyResolved = false;

  /** Listeners notified synchronously whenever the identity verdict may have changed. */
  private static readonly identityChangeListeners = new Set<() => void>();

  /**
   * Memoized one-run-per-process slot migration. `slotMigrationResult` caches a
   * STABLE outcome (`v2`/`legacy`); a `deferred` outcome is intentionally not
   * cached (the in-flight promise is cleared) so a later call retries once the
   * keychain unlocks.
   */
  private static slotMigrationPromise: Promise<SlotMigrationResult> | null = null;
  private static slotMigrationResult: SlotMigrationResult | null = null;

  /**
   * Invalidate cached identity state
   * Called internally when identity is created/deleted/imported
   */
  private static invalidateCache(): void {
    KeyManager.cachedPublicKey = null;
    KeyManager.cachedHasIdentity = null;
    KeyManager.cachedPublicKeyResolved = false;
    KeyManager.notifyIdentityChanged();
  }

  /**
   * Subscribe to identity-verdict changes (create / import / delete / restore /
   * cache invalidation). Fires synchronously; the returned function unsubscribes.
   * Consumed via `useOxyEvent`-style hooks in commons to invalidate the routing
   * queries the instant the identity state moves, without polling.
   */
  static subscribeIdentityChanged(listener: () => void): () => void {
    KeyManager.identityChangeListeners.add(listener);
    return () => {
      KeyManager.identityChangeListeners.delete(listener);
    };
  }

  /** Synchronous fan-out with per-listener isolation (one throwing listener never blocks the rest). */
  private static notifyIdentityChanged(): void {
    // Snapshot first — a listener may unsubscribe (mutate the Set) during fan-out.
    for (const listener of Array.from(KeyManager.identityChangeListeners)) {
      try {
        listener();
      } catch (error) {
        logger.warn('Identity-change listener threw', { component: 'KeyManager' }, error);
      }
    }
  }

  /** Build `getItemAsync`/`deleteItemAsync` options for a given keychain service (read/delete). */
  private static _slotOpts(service?: string): OxySecureStoreOptions {
    return service ? { keychainService: service } : {};
  }

  /** Build private-key write options (device-only accessibility) for a given keychain service. */
  private static _privateWriteOpts(
    store: Awaited<ReturnType<typeof initSecureStore>>,
    service?: string,
  ): OxySecureStoreOptions {
    const opts: OxySecureStoreOptions = { keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
    if (service) {
      opts.keychainService = service;
    }
    return opts;
  }

  /** True only when both keys are present, well-formed, AND the public derives from the private. */
  private static _isHealthyPair(privateKey: string | null, publicKey: string | null): boolean {
    if (!privateKey || !publicKey) {
      return false;
    }
    if (!KeyManager.isValidPrivateKey(privateKey) || !KeyManager.isValidPublicKey(publicKey)) {
      return false;
    }
    try {
      return KeyManager.derivePublicKey(privateKey).toLowerCase() === publicKey.toLowerCase();
    } catch {
      return false;
    }
  }

  /**
   * Resolve the AsyncStorage-backed KV store for the advisory migration flag, or
   * `null` off-RN / when unavailable. Independent of the keychain, so the flag
   * cannot be taken down by the keystore event this whole subsystem defends
   * against.
   */
  private static async _advisoryStorage(): Promise<{
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
  } | null> {
    if (!isReactNative()) {
      return null;
    }
    try {
      const mod = await loadAsyncStorage();
      return mod.default;
    } catch {
      // Advisory only — absence just means the slot check runs in full.
      return null;
    }
  }

  private static async _readSlotsMigratedFlag(): Promise<boolean> {
    const storage = await KeyManager._advisoryStorage();
    if (!storage) {
      return false;
    }
    try {
      return (await storage.getItem(SLOTS_MIGRATED_FLAG_KEY)) === 'true';
    } catch {
      // Advisory only — treat an unreadable flag as "not yet migrated".
      return false;
    }
  }

  private static async _setSlotsMigratedFlag(): Promise<void> {
    const storage = await KeyManager._advisoryStorage();
    if (!storage) {
      return;
    }
    try {
      await storage.setItem(SLOTS_MIGRATED_FLAG_KEY, 'true');
    } catch (error) {
      // Advisory only — a failed write just re-runs the cheap slot check next launch.
      if (isDev()) {
        logger.debug('Failed to set slots-migrated flag (advisory)', { component: 'KeyManager' }, error);
      }
    }
  }

  /**
   * Ensure the identity has been migrated onto the isolated v2 slots (or that we
   * know we must read legacy this session). Memoized so concurrent callers share
   * ONE run; a `deferred` (read-threw) outcome is not cached so a later call
   * retries after the keychain unlocks. Every identity-slot accessor awaits this
   * before touching storage.
   */
  private static async _ensureIdentitySlotsMigrated(): Promise<SlotMigrationResult> {
    if (KeyManager.slotMigrationResult && KeyManager.slotMigrationResult.mode !== 'deferred') {
      return KeyManager.slotMigrationResult;
    }
    if (!KeyManager.slotMigrationPromise) {
      const run = (async () => {
        const result = await KeyManager._runSlotMigration();
        KeyManager.slotMigrationResult = result;
        return result;
      })();
      KeyManager.slotMigrationPromise = run;
      // Clear the in-flight handle once settled so a deferred outcome retries.
      run
        .then((result) => {
          if (result.mode === 'deferred') {
            KeyManager.slotMigrationPromise = null;
          }
        })
        .catch(() => {
          KeyManager.slotMigrationPromise = null;
        });
    }
    return KeyManager.slotMigrationPromise;
  }

  /**
   * One-shot slot migration state machine. All reads are DIRECT and a thrown
   * read defers everything (zero writes/deletes) so a locked keychain is never
   * mistaken for an empty one. INVARIANT: at every instant ≥1 readable copy of a
   * previously-existing identity remains — legacy is deleted ONLY after the v2
   * copy is verified re-readable in its new (non-aliasable) location.
   */
  private static async _runSlotMigration(): Promise<SlotMigrationResult> {
    let store: Awaited<ReturnType<typeof initSecureStore>>;
    try {
      store = await initSecureStore();
    } catch (error) {
      return { mode: 'deferred', cause: error };
    }

    const migratedFlag = await KeyManager._readSlotsMigratedFlag();

    // Read the v2 primary (dedicated keychain service).
    let v2Private: string | null;
    let v2Public: string | null;
    try {
      v2Private = await store.getItemAsync(
        V2_STORAGE_KEYS.PRIVATE_KEY,
        KeyManager._slotOpts(V2_PRIMARY_KEYCHAIN_SERVICE),
      );
      v2Public = await store.getItemAsync(
        V2_STORAGE_KEYS.PUBLIC_KEY,
        KeyManager._slotOpts(V2_PRIMARY_KEYCHAIN_SERVICE),
      );
    } catch (error) {
      return { mode: 'deferred', cause: error };
    }

    if (KeyManager._isHealthyPair(v2Private, v2Public)) {
      // v2 already owns the identity. On the first observation, clean up any
      // stale legacy copy and record the fast-path flag.
      if (!migratedFlag) {
        await KeyManager._bestEffortDeleteLegacyPrimaryAndBackup(store);
        await KeyManager._setSlotsMigratedFlag();
      }
      return { mode: 'v2', layout: V2_SLOT_LAYOUT };
    }

    // v2 primary absent/partial but the flag says migration finished → v2 is
    // simply empty (identity deleted / never created). No legacy to rescue.
    if (migratedFlag) {
      return { mode: 'v2', layout: V2_SLOT_LAYOUT };
    }

    // Read the legacy primary (default keychain service = the old `key_v1`).
    let legacyPrivate: string | null;
    let legacyPublic: string | null;
    try {
      legacyPrivate = await store.getItemAsync(STORAGE_KEYS.PRIVATE_KEY);
      legacyPublic = await store.getItemAsync(STORAGE_KEYS.PUBLIC_KEY);
    } catch (error) {
      return { mode: 'deferred', cause: error };
    }

    if (!KeyManager._isHealthyPair(legacyPrivate, legacyPublic)) {
      // Nothing readable in either generation → v2 is the canonical (empty) home.
      // The marker (not this migration) decides fresh-vs-lost.
      return { mode: 'v2', layout: V2_SLOT_LAYOUT };
    }

    // legacy healthy, v2 absent → migrate: copy → read-back verify → only then delete legacy.
    const canonicalPrivate = KeyManager.canonicalPrivateKey(legacyPrivate as string);
    const canonicalPublic = (legacyPublic as string).toLowerCase();
    try {
      await store.setItemAsync(
        V2_STORAGE_KEYS.PUBLIC_KEY,
        canonicalPublic,
        KeyManager._slotOpts(V2_PRIMARY_KEYCHAIN_SERVICE),
      );
      await store.setItemAsync(
        V2_STORAGE_KEYS.PRIVATE_KEY,
        canonicalPrivate,
        KeyManager._privateWriteOpts(store, V2_PRIMARY_KEYCHAIN_SERVICE),
      );
      const readBackPrivate = await store.getItemAsync(
        V2_STORAGE_KEYS.PRIVATE_KEY,
        KeyManager._slotOpts(V2_PRIMARY_KEYCHAIN_SERVICE),
      );
      const readBackPublic = await store.getItemAsync(
        V2_STORAGE_KEYS.PUBLIC_KEY,
        KeyManager._slotOpts(V2_PRIMARY_KEYCHAIN_SERVICE),
      );
      const verified =
        readBackPrivate?.toLowerCase() === canonicalPrivate &&
        readBackPublic?.toLowerCase() === canonicalPublic &&
        KeyManager._isHealthyPair(readBackPrivate, readBackPublic);
      if (!verified) {
        // v2 write did not durably land — remove the partial v2 and serve reads
        // from legacy this session (legacy is UNTOUCHED). Retry next launch.
        await KeyManager._bestEffortDeleteV2Primary(store);
        logger.warn(
          'Identity slot migration verify failed; serving identity from legacy slots this session',
          { component: 'KeyManager' },
        );
        return { mode: 'legacy', layout: LEGACY_SLOT_LAYOUT };
      }
    } catch (error) {
      await KeyManager._bestEffortDeleteV2Primary(store);
      logger.warn(
        'Identity slot migration write threw; serving identity from legacy slots this session',
        { component: 'KeyManager' },
        error,
      );
      return { mode: 'legacy', layout: LEGACY_SLOT_LAYOUT };
    }

    // v2 primary is verified re-readable. Migrate the backup slot (best-effort),
    // then it is finally safe to delete the legacy generation.
    await KeyManager._migrateBackupSlotToV2(store, canonicalPrivate, canonicalPublic);
    await KeyManager._bestEffortDeleteLegacyPrimaryAndBackup(store);
    await KeyManager._setSlotsMigratedFlag();
    return { mode: 'v2', layout: V2_SLOT_LAYOUT };
  }

  /**
   * Seed the v2 backup slot during migration. Prefers a healthy legacy backup;
   * otherwise mirrors the (already-verified) v2 primary material so a v2 backup
   * always exists on an independent keychain key. Best-effort — a failure just
   * defers backup population to the next {@link _persistIdentityAtomic}.
   */
  private static async _migrateBackupSlotToV2(
    store: Awaited<ReturnType<typeof initSecureStore>>,
    primaryPrivate: string,
    primaryPublic: string,
  ): Promise<void> {
    try {
      let backupPrivate: string | null = null;
      let backupPublic: string | null = null;
      try {
        backupPrivate = await store.getItemAsync(STORAGE_KEYS.BACKUP_PRIVATE_KEY);
        backupPublic = await store.getItemAsync(STORAGE_KEYS.BACKUP_PUBLIC_KEY);
      } catch (error) {
        if (isDev()) {
          logger.debug('Legacy backup unreadable during migration (non-fatal)', { component: 'KeyManager' }, error);
        }
        backupPrivate = null;
        backupPublic = null;
      }

      let seedPrivate: string;
      let seedPublic: string;
      if (KeyManager._isHealthyPair(backupPrivate, backupPublic)) {
        seedPrivate = KeyManager.canonicalPrivateKey(backupPrivate as string);
        seedPublic = (backupPublic as string).toLowerCase();
      } else {
        seedPrivate = primaryPrivate;
        seedPublic = primaryPublic;
      }

      await store.setItemAsync(
        V2_STORAGE_KEYS.BACKUP_PUBLIC_KEY,
        seedPublic,
        KeyManager._slotOpts(V2_BACKUP_KEYCHAIN_SERVICE),
      );
      await store.setItemAsync(
        V2_STORAGE_KEYS.BACKUP_PRIVATE_KEY,
        seedPrivate,
        KeyManager._privateWriteOpts(store, V2_BACKUP_KEYCHAIN_SERVICE),
      );
      await store.setItemAsync(
        V2_STORAGE_KEYS.BACKUP_TIMESTAMP,
        Date.now().toString(),
        KeyManager._slotOpts(V2_BACKUP_KEYCHAIN_SERVICE),
      );
    } catch (error) {
      logger.warn('Failed to migrate identity backup slot to v2 (non-fatal)', { component: 'KeyManager' }, error);
    }
  }

  /** Best-effort single delete under an optional keychain service. Cleanup only — never surfaces. */
  private static async _bestEffortDelete(
    store: Awaited<ReturnType<typeof initSecureStore>>,
    key: string,
    service?: string,
  ): Promise<void> {
    try {
      await store.deleteItemAsync(key, KeyManager._slotOpts(service));
    } catch (error) {
      if (isDev()) {
        logger.debug('Best-effort identity delete failed', { component: 'KeyManager' }, error);
      }
    }
  }

  private static async _bestEffortDeleteV2Primary(
    store: Awaited<ReturnType<typeof initSecureStore>>,
  ): Promise<void> {
    await KeyManager._bestEffortDelete(store, V2_STORAGE_KEYS.PRIVATE_KEY, V2_PRIMARY_KEYCHAIN_SERVICE);
    await KeyManager._bestEffortDelete(store, V2_STORAGE_KEYS.PUBLIC_KEY, V2_PRIMARY_KEYCHAIN_SERVICE);
  }

  private static async _bestEffortDeleteLegacyPrimaryAndBackup(
    store: Awaited<ReturnType<typeof initSecureStore>>,
  ): Promise<void> {
    await KeyManager._bestEffortDelete(store, STORAGE_KEYS.PRIVATE_KEY);
    await KeyManager._bestEffortDelete(store, STORAGE_KEYS.PUBLIC_KEY);
    await KeyManager._bestEffortDelete(store, STORAGE_KEYS.BACKUP_PRIVATE_KEY);
    await KeyManager._bestEffortDelete(store, STORAGE_KEYS.BACKUP_PUBLIC_KEY);
    await KeyManager._bestEffortDelete(store, STORAGE_KEYS.BACKUP_TIMESTAMP);
  }

  private static async _bestEffortDeleteBackupsAllGenerations(
    store: Awaited<ReturnType<typeof initSecureStore>>,
  ): Promise<void> {
    await KeyManager._bestEffortDelete(store, V2_STORAGE_KEYS.BACKUP_PRIVATE_KEY, V2_BACKUP_KEYCHAIN_SERVICE);
    await KeyManager._bestEffortDelete(store, V2_STORAGE_KEYS.BACKUP_PUBLIC_KEY, V2_BACKUP_KEYCHAIN_SERVICE);
    await KeyManager._bestEffortDelete(store, V2_STORAGE_KEYS.BACKUP_TIMESTAMP, V2_BACKUP_KEYCHAIN_SERVICE);
    await KeyManager._bestEffortDelete(store, STORAGE_KEYS.BACKUP_PRIVATE_KEY);
    await KeyManager._bestEffortDelete(store, STORAGE_KEYS.BACKUP_PUBLIC_KEY);
    await KeyManager._bestEffortDelete(store, STORAGE_KEYS.BACKUP_TIMESTAMP);
  }

  /**
   * Clear the cross-app shared identity slot (force-delete only) so a deleted
   * identity cannot be resurrected via the recovery ladder's shared rung.
   * Best-effort — the shared slot is a redundant convenience copy.
   */
  private static async _clearSharedSlot(
    store: Awaited<ReturnType<typeof initSecureStore>>,
  ): Promise<void> {
    try {
      if (isIOS()) {
        const opts: OxySecureStoreOptions = { keychainAccessGroup: IOS_KEYCHAIN_GROUP };
        await store.deleteItemAsync(STORAGE_KEYS.SHARED_PRIVATE_KEY, opts);
        await store.deleteItemAsync(STORAGE_KEYS.SHARED_PUBLIC_KEY, opts);
      } else if (isAndroid()) {
        const bridge = await loadSharedIdentityBridge();
        if (bridge) {
          await bridge.clearShared();
        } else {
          await store.deleteItemAsync(STORAGE_KEYS.SHARED_PRIVATE_KEY);
          await store.deleteItemAsync(STORAGE_KEYS.SHARED_PUBLIC_KEY);
        }
      }
      KeyManager.invalidateSharedCache();
    } catch (error) {
      logger.warn('Failed to clear shared identity slot during force delete', { component: 'KeyManager' }, error);
    }
  }

  /**
   * Invalidate cached shared identity state
   * Called internally when shared identity is created/deleted/imported
   */
  private static invalidateSharedCache(): void {
    KeyManager.cachedSharedPublicKey = null;
    KeyManager.cachedHasSharedIdentity = null;
  }

  /**
   * Lowercase and pad to canonical 64-hex-char form.
   *
   * Tolerates the 1-in-256 leading-zero-strip that elliptic's
   * `getPrivate('hex')` produces, and the externally-imported uppercase-hex
   * legacy keys. EVERY `ec.keyFromPrivate(...)` call site in this file must
   * canonicalize first so that derivation is stable regardless of storage
   * representation.
   *
   * Private (used only inside KeyManager) — public consumers should not need
   * to think about hex representation.
   */
  private static canonicalPrivateKey(key: string): string {
    return key.toLowerCase().padStart(64, '0');
  }

  /**
   * Generate a new ECDSA secp256k1 key pair
   * Returns the keys in hexadecimal format
   */
  static generateKeyPairSync(): KeyPair {
    const keyPair = ec.genKeyPair();
    // Pad to canonical 64 hex chars. `elliptic`'s `getPrivate('hex')` strips
    // leading zero bytes which would otherwise corrupt strict-length checks
    // and signature derivation on the read path.
    return {
      privateKey: keyPair.getPrivate('hex').padStart(64, '0'),
      publicKey: keyPair.getPublic('hex'),
    };
  }

  /**
   * Generate a new key pair using secure random bytes
   */
  static async generateKeyPair(): Promise<KeyPair> {
    const randomBytes = await getSecureRandomBytes(32);
    const privateKeyHex = uint8ArrayToHex(randomBytes);
    const keyPair = ec.keyFromPrivate(KeyManager.canonicalPrivateKey(privateKeyHex));

    return {
      privateKey: keyPair.getPrivate('hex').padStart(64, '0'),
      publicKey: keyPair.getPublic('hex'),
    };
  }

  // ==================== SHARED IDENTITY METHODS ====================
  // These methods enable cross-app session sharing (like Google)
  // iOS: Uses Keychain Access Groups
  // Android: Uses Account Manager with shared user ID
  // =================================================================

  /**
   * Create a shared identity accessible across all Oxy apps
   *
   * iOS: Stores in shared keychain group (requires entitlement configuration)
   * Android: Stores in Account Manager (requires sharedUserId in manifest)
   *
   * This enables true cross-app SSO - when user signs in to one Oxy app,
   * they're automatically signed in to all other Oxy apps.
   *
   * @returns Public key of the shared identity
   * @throws Error if not on native platform or if sharing is not configured
   */
  static async createSharedIdentity(): Promise<string> {
    if (isWebPlatform()) {
      throw new Error('Shared identity is only available on native platforms (iOS/Android).');
    }

    const store = await initSecureStore();
    const { privateKey, publicKey } = await KeyManager.generateKeyPair();

    if (isIOS()) {
      // iOS: Store in shared keychain group
      // Note: keychainAccessGroup requires Keychain Sharing capability in Xcode
      try {
        const privateOpts: OxySecureStoreOptions = {
          keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          keychainAccessGroup: IOS_KEYCHAIN_GROUP, // Enables sharing across apps
        };
        await store.setItemAsync(STORAGE_KEYS.SHARED_PRIVATE_KEY, privateKey, privateOpts);

        const publicOpts: OxySecureStoreOptions = {
          keychainAccessGroup: IOS_KEYCHAIN_GROUP,
        };
        await store.setItemAsync(STORAGE_KEYS.SHARED_PUBLIC_KEY, publicKey, publicOpts);
      } catch (error) {
        throw new Error(
          `Failed to create shared identity on iOS. Ensure your app has the Keychain Sharing capability enabled with access group "${IOS_KEYCHAIN_GROUP}". Error: ${error}`
        );
      }
    } else if (isAndroid()) {
      // Android: write through the cross-app bridge (`@oxyhq/expo-oxy-identity`)
      // when present — it persists into Commons's hardware-backed
      // EncryptedSharedPreferences behind a signature-protected ContentProvider,
      // so same-key Oxy apps can read it. When the bridge is not linked, fall
      // back to the package-private secure store (no cross-app sharing).
      const bridge = await loadSharedIdentityBridge();
      if (bridge) {
        await bridge.putShared(privateKey, publicKey);
      } else {
        await store.setItemAsync(STORAGE_KEYS.SHARED_PRIVATE_KEY, privateKey, {
          keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
        await store.setItemAsync(STORAGE_KEYS.SHARED_PUBLIC_KEY, publicKey);
      }
    }

    // Update cache
    KeyManager.cachedSharedPublicKey = publicKey;
    KeyManager.cachedHasSharedIdentity = true;

    if (isDev()) {
      logger.debug('Shared identity created successfully', { component: 'KeyManager' });
    }

    return publicKey;
  }

  /**
   * Get the shared public key (accessible across all Oxy apps)
   *
   * @returns Shared public key or null if no shared identity exists
   */
  static async getSharedPublicKey(): Promise<string | null> {
    if (isWebPlatform()) {
      return null;
    }

    // Return cached value if available
    if (KeyManager.cachedSharedPublicKey !== null) {
      return KeyManager.cachedSharedPublicKey;
    }

    try {
      const store = await initSecureStore();
      let publicKey: string | null = null;

      if (isIOS()) {
        const opts: OxySecureStoreOptions = { keychainAccessGroup: IOS_KEYCHAIN_GROUP };
        publicKey = await store.getItemAsync(STORAGE_KEYS.SHARED_PUBLIC_KEY, opts);
      } else if (isAndroid()) {
        // Android reads through the cross-app bridge; when it is not linked, fall
        // back to the package-private store the fallback write path used.
        const bridge = await loadSharedIdentityBridge();
        if (bridge) {
          publicKey = (await bridge.getShared())?.publicKey ?? null;
        } else {
          publicKey = await store.getItemAsync(STORAGE_KEYS.SHARED_PUBLIC_KEY);
        }
      }

      // Cache result
      KeyManager.cachedSharedPublicKey = publicKey;

      return publicKey;
    } catch (error) {
      if (isDev()) {
        logger.warn('Failed to get shared public key', { component: 'KeyManager' }, error);
      }
      KeyManager.cachedSharedPublicKey = null;
      return null;
    }
  }

  /**
   * Get the shared private key (for signing operations)
   *
   * WARNING: Only use this for signing operations within the app.
   * The private key should NEVER be transmitted or exposed.
   *
   * @returns Shared private key or null if no shared identity exists
   */
  static async getSharedPrivateKey(): Promise<string | null> {
    if (isWebPlatform()) {
      return null;
    }

    try {
      const store = await initSecureStore();
      let privateKey: string | null = null;

      if (isIOS()) {
        const opts: OxySecureStoreOptions = { keychainAccessGroup: IOS_KEYCHAIN_GROUP };
        privateKey = await store.getItemAsync(STORAGE_KEYS.SHARED_PRIVATE_KEY, opts);
      } else if (isAndroid()) {
        // Android reads through the cross-app bridge; when it is not linked, fall
        // back to the package-private store the fallback write path used.
        const bridge = await loadSharedIdentityBridge();
        if (bridge) {
          privateKey = (await bridge.getShared())?.privateKey ?? null;
        } else {
          privateKey = await store.getItemAsync(STORAGE_KEYS.SHARED_PRIVATE_KEY);
        }
      }

      return privateKey;
    } catch (error) {
      if (isDev()) {
        logger.warn('Failed to get shared private key', { component: 'KeyManager' }, error);
      }
      return null;
    }
  }

  /**
   * Check if a shared identity exists (accessible across all Oxy apps)
   *
   * @returns True if shared identity exists, false otherwise
   */
  static async hasSharedIdentity(): Promise<boolean> {
    if (isWebPlatform()) {
      return false;
    }

    // Return cached value if available
    if (KeyManager.cachedHasSharedIdentity !== null) {
      return KeyManager.cachedHasSharedIdentity;
    }

    try {
      const privateKey = await KeyManager.getSharedPrivateKey();
      const hasShared = privateKey !== null;

      // Cache result
      KeyManager.cachedHasSharedIdentity = hasShared;

      return hasShared;
    } catch (error) {
      if (isDev()) {
        logger.warn('Failed to check shared identity', { component: 'KeyManager' }, error);
      }
      KeyManager.cachedHasSharedIdentity = false;
      return false;
    }
  }

  /**
   * Import an existing key pair as shared identity
   *
   * This is used when:
   * 1. User signs in to a new Oxy app for the first time
   * 2. User has existing identity on another Oxy app
   * 3. We want to sync the identity across apps
   *
   * @param privateKey - Private key in hex format
   * @returns Public key
   */
  static async importSharedIdentity(privateKey: string): Promise<string> {
    if (isWebPlatform()) {
      throw new Error('Shared identity import is only available on native platforms.');
    }

    const store = await initSecureStore();
    // Canonicalize incoming key BEFORE storage so the stored value is always
    // in canonical 64-hex-char lowercase form going forward. Without this,
    // legacy short keys would derive a different public key on the read path.
    const canonicalPrivate = KeyManager.canonicalPrivateKey(privateKey);
    const keyPair = ec.keyFromPrivate(canonicalPrivate);
    const publicKey = keyPair.getPublic('hex');

    if (isIOS()) {
      const privateOpts: OxySecureStoreOptions = {
        keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        keychainAccessGroup: IOS_KEYCHAIN_GROUP,
      };
      await store.setItemAsync(STORAGE_KEYS.SHARED_PRIVATE_KEY, canonicalPrivate, privateOpts);

      const publicOpts: OxySecureStoreOptions = {
        keychainAccessGroup: IOS_KEYCHAIN_GROUP,
      };
      await store.setItemAsync(STORAGE_KEYS.SHARED_PUBLIC_KEY, publicKey, publicOpts);
    } else if (isAndroid()) {
      // Android: write through the cross-app bridge when present; otherwise the
      // package-private store (kept consistent with the read fallback).
      const bridge = await loadSharedIdentityBridge();
      if (bridge) {
        await bridge.putShared(canonicalPrivate, publicKey);
      } else {
        await store.setItemAsync(STORAGE_KEYS.SHARED_PRIVATE_KEY, canonicalPrivate, {
          keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
        await store.setItemAsync(STORAGE_KEYS.SHARED_PUBLIC_KEY, publicKey);
      }
    }

    // Update cache
    KeyManager.cachedSharedPublicKey = publicKey;
    KeyManager.cachedHasSharedIdentity = true;

    if (isDev()) {
      logger.debug('Shared identity imported successfully', { component: 'KeyManager' });
    }

    return publicKey;
  }

  /**
   * Store session information in shared storage
   *
   * This allows all Oxy apps to access the same session without
   * re-authenticating. When user signs in to one app, all apps
   * get the session automatically.
   *
   * @param sessionId - Session ID from authentication
   * @param accessToken - Access token for API calls
   */
  static async storeSharedSession(sessionId: string, accessToken: string): Promise<void> {
    if (isWebPlatform()) {
      return; // Not supported on web
    }

    try {
      const store = await initSecureStore();

      if (isIOS()) {
        const sessionIdOpts: OxySecureStoreOptions = {
          keychainAccessGroup: IOS_KEYCHAIN_GROUP,
        };
        await store.setItemAsync(STORAGE_KEYS.SHARED_SESSION_ID, sessionId, sessionIdOpts);

        const tokenOpts: OxySecureStoreOptions = {
          keychainAccessible: store.WHEN_UNLOCKED,
          keychainAccessGroup: IOS_KEYCHAIN_GROUP,
        };
        await store.setItemAsync(STORAGE_KEYS.SHARED_SESSION_TOKEN, accessToken, tokenOpts);
      } else if (isAndroid()) {
        await store.setItemAsync(STORAGE_KEYS.SHARED_SESSION_ID, sessionId);
        await store.setItemAsync(STORAGE_KEYS.SHARED_SESSION_TOKEN, accessToken);
      }

      if (isDev()) {
        logger.debug('Shared session stored successfully', { component: 'KeyManager' });
      }
    } catch (error) {
      if (isDev()) {
        logger.error('Failed to store shared session', error, { component: 'KeyManager' });
      }
      throw error;
    }
  }

  /**
   * Get shared session information
   *
   * This allows any Oxy app to check if user is already signed in
   * via another Oxy app. Enables instant cross-app SSO.
   *
   * @returns Session data or null if no shared session exists
   */
  static async getSharedSession(): Promise<{ sessionId: string; accessToken: string } | null> {
    if (isWebPlatform()) {
      return null;
    }

    try {
      const store = await initSecureStore();
      let sessionId: string | null = null;
      let accessToken: string | null = null;

      if (isIOS()) {
        const opts: OxySecureStoreOptions = { keychainAccessGroup: IOS_KEYCHAIN_GROUP };
        sessionId = await store.getItemAsync(STORAGE_KEYS.SHARED_SESSION_ID, opts);
        accessToken = await store.getItemAsync(STORAGE_KEYS.SHARED_SESSION_TOKEN, opts);
      } else if (isAndroid()) {
        sessionId = await store.getItemAsync(STORAGE_KEYS.SHARED_SESSION_ID);
        accessToken = await store.getItemAsync(STORAGE_KEYS.SHARED_SESSION_TOKEN);
      }

      if (!sessionId || !accessToken) {
        return null;
      }

      return { sessionId, accessToken };
    } catch (error) {
      if (isDev()) {
        logger.warn('Failed to get shared session', { component: 'KeyManager' }, error);
      }
      return null;
    }
  }

  /**
   * Clear shared session (on logout)
   *
   * This signs out the user from ALL Oxy apps simultaneously.
   * Call this when user explicitly logs out.
   */
  static async clearSharedSession(): Promise<void> {
    if (isWebPlatform()) {
      return;
    }

    try {
      const store = await initSecureStore();

      if (isIOS()) {
        const opts: OxySecureStoreOptions = { keychainAccessGroup: IOS_KEYCHAIN_GROUP };
        await store.deleteItemAsync(STORAGE_KEYS.SHARED_SESSION_ID, opts);
        await store.deleteItemAsync(STORAGE_KEYS.SHARED_SESSION_TOKEN, opts);
      } else if (isAndroid()) {
        await store.deleteItemAsync(STORAGE_KEYS.SHARED_SESSION_ID);
        await store.deleteItemAsync(STORAGE_KEYS.SHARED_SESSION_TOKEN);
      }

      if (isDev()) {
        logger.debug('Shared session cleared successfully', { component: 'KeyManager' });
      }
    } catch (error) {
      if (isDev()) {
        logger.error('Failed to clear shared session', error, { component: 'KeyManager' });
      }
    }
  }

  /**
   * Migrate local identity to shared identity
   *
   * Call this when upgrading existing apps to use shared identities.
   * Copies the device-specific identity to shared storage so it can
   * be accessed by other Oxy apps.
   *
   * @returns True if migration was successful, false if no local identity exists
   */
  static async migrateToSharedIdentity(): Promise<boolean> {
    if (isWebPlatform()) {
      return false;
    }

    try {
      // Check if we already have a shared identity
      const hasShared = await KeyManager.hasSharedIdentity();
      if (hasShared) {
        if (isDev()) {
          logger.debug('Shared identity already exists, skipping migration', { component: 'KeyManager' });
        }
        return true;
      }

      // Get local identity
      const privateKey = await KeyManager.getPrivateKey();
      if (!privateKey) {
        if (isDev()) {
          logger.debug('No local identity to migrate', { component: 'KeyManager' });
        }
        return false;
      }

      // Import to shared storage
      await KeyManager.importSharedIdentity(privateKey);

      if (isDev()) {
        logger.debug('Successfully migrated local identity to shared identity', { component: 'KeyManager' });
      }

      return true;
    } catch (error) {
      if (isDev()) {
        logger.error('Failed to migrate to shared identity', error, { component: 'KeyManager' });
      }
      return false;
    }
  }

  // ==================== END SHARED IDENTITY METHODS ====================

  /**
   * Atomically persist a key pair to secure storage with verification + backup.
   *
   * INVARIANT (the reason this method exists): at no instant during the write
   * may the device be left holding ZERO recoverable copies of a healthy
   * identity. This matters most on the OVERWRITE / account-switch path: if we
   * are replacing identity A with B and the write fails halfway, we MUST end
   * up back on A — never on a half-written B, and never on nothing.
   *
   * Algorithm (recoverability-preserving):
   *   0. Snapshot the existing primary (privA, pubA) so we can roll back to
   *      EXACTLY what was there.
   *   1. Write the new primary: public first, then private.
   *   2. Read back + sign/verify the new primary.
   *   3. ONLY after the new primary is proven durable, refresh the backup to
   *      the new key. The backup is NEVER touched before this point, so any
   *      prior identity's backup remains intact and `restoreIdentityFromBackup`
   *      can always recover it.
   *   4. On ANY failure in steps 1–2, restore the snapshotted primary verbatim
   *      (or delete it if there was none), then surface the error.
   *
   * Earlier versions wrote the *incoming* key to the backup FIRST, which
   * destroyed the previous identity's backup, and rolled back by blindly
   * deleting the primary — so a failed overwrite silently switched the user
   * to (or lost them into) the half-written new identity. That is fixed here.
   *
   * @internal
   */
  private static async _persistIdentityAtomic(
    privateKey: string,
    publicKey: string,
    origin: IdentityMarker['origin'],
  ): Promise<void> {
    const store = await initSecureStore();

    // Resolve the active slot layout (normally v2; legacy only in the rare
    // migration-fallback session). Reading and writing the SAME layout keeps the
    // snapshot/rollback machinery below internally consistent. A deferred
    // migration (keychain locked) must never write blind.
    const migration = await KeyManager._ensureIdentitySlotsMigrated();
    if (migration.mode === 'deferred') {
      throw new IdentityUnavailableError(
        'Identity storage is temporarily unavailable; refusing to persist an identity.',
        migration.cause,
      );
    }
    const layout = migration.layout;
    const primaryReadOpts = KeyManager._slotOpts(layout.primaryService);
    const primaryPrivWriteOpts = KeyManager._privateWriteOpts(store, layout.primaryService);
    const primaryPubWriteOpts = KeyManager._slotOpts(layout.primaryService);
    const backupReadOpts = KeyManager._slotOpts(layout.backupService);
    const backupPrivWriteOpts = KeyManager._privateWriteOpts(store, layout.backupService);
    const backupPubWriteOpts = KeyManager._slotOpts(layout.backupService);

    // Canonicalize BEFORE persistence so the stored value is always in
    // canonical 64-hex-char lowercase form going forward. This is the single
    // place all primary writes flow through, so once a value lands here all
    // subsequent reads see a stable representation.
    const canonicalPrivate = KeyManager.canonicalPrivateKey(privateKey);
    const canonicalPublic = publicKey.toLowerCase();

    // Step 0: Snapshot the existing primary so a failed write can be rolled
    // back to EXACTLY the prior state. If the read itself fails we treat the
    // prior primary as unknown and refuse to proceed — overwriting blind
    // would risk clobbering an identity we just couldn't see (e.g. a
    // transient keychain lock).
    let priorPrivate: string | null;
    let priorPublic: string | null;
    try {
      priorPrivate = await store.getItemAsync(layout.primaryPrivateKeyName, primaryReadOpts);
      priorPublic = await store.getItemAsync(layout.primaryPublicKeyName, primaryReadOpts);
    } catch (error) {
      logger.error('Failed to read existing primary before persist', error, { component: 'KeyManager' });
      throw new IdentityPersistError(
        'Could not read existing identity before writing a new one; refusing to overwrite blind.',
        error,
      );
    }

    // If we are replacing a DIFFERENT, currently-healthy identity, make sure
    // it is recoverable from the backup slot BEFORE we overwrite the primary.
    // We only do this when the existing backup does not already hold that
    // identity — otherwise we would needlessly churn the keychain. This keeps
    // the "always at least one recoverable copy" invariant intact across the
    // window where the primary briefly holds the new key but the new backup
    // has not been written yet.
    const priorIsHealthyDifferent =
      !!priorPrivate &&
      !!priorPublic &&
      priorPublic.toLowerCase() !== canonicalPublic &&
      KeyManager.isValidPrivateKey(priorPrivate) &&
      KeyManager.isValidPublicKey(priorPublic) &&
      KeyManager.derivePublicKey(priorPrivate).toLowerCase() === priorPublic.toLowerCase();

    if (priorIsHealthyDifferent && priorPrivate && priorPublic) {
      let existingBackupPublic: string | null = null;
      try {
        existingBackupPublic = await store.getItemAsync(layout.backupPublicKeyName, backupReadOpts);
      } catch {
        existingBackupPublic = null;
      }
      if (existingBackupPublic?.toLowerCase() !== priorPublic.toLowerCase()) {
        try {
          await store.setItemAsync(
            layout.backupPrivateKeyName,
            KeyManager.canonicalPrivateKey(priorPrivate),
            backupPrivWriteOpts,
          );
          await store.setItemAsync(layout.backupPublicKeyName, priorPublic.toLowerCase(), backupPubWriteOpts);
          await store.setItemAsync(layout.backupTimestampName, Date.now().toString(), backupPubWriteOpts);
        } catch (error) {
          logger.error('Failed to back up existing identity before overwrite', error, { component: 'KeyManager' });
          throw new IdentityPersistError('Failed to back up existing identity before overwrite', error);
        }
      }
    }

    // Step 1: Write the new primary. Public first so that if the private write
    // fails we are missing the most critical bit. The backup is intentionally
    // NOT touched here — it still holds the previous good identity until the
    // new primary is proven durable.
    try {
      await store.setItemAsync(layout.primaryPublicKeyName, canonicalPublic, primaryPubWriteOpts);
      await store.setItemAsync(layout.primaryPrivateKeyName, canonicalPrivate, primaryPrivWriteOpts);
    } catch (error) {
      logger.error('Failed to write primary identity to secure store', error, { component: 'KeyManager' });
      await KeyManager._rollbackPrimary(store, layout, priorPrivate, priorPublic);
      throw new IdentityPersistError('Failed to write identity to secure store', error);
    }

    // Step 2: Verify round-trip. If the store silently drops our writes
    // (e.g., a misconfigured keychain access group), we MUST surface it
    // before declaring success — otherwise the caller will think the
    // identity was saved and discard the in-memory copy.
    let readBackPrivate: string | null;
    let readBackPublic: string | null;
    try {
      readBackPrivate = await store.getItemAsync(layout.primaryPrivateKeyName, primaryReadOpts);
      readBackPublic = await store.getItemAsync(layout.primaryPublicKeyName, primaryReadOpts);
    } catch (error) {
      logger.error('Failed to read identity back after write', error, { component: 'KeyManager' });
      await KeyManager._rollbackPrimary(store, layout, priorPrivate, priorPublic);
      throw new IdentityPersistError('Failed to verify identity after write', error);
    }

    // Hex comparisons are case-insensitive — normalize on both sides so a
    // store that uppercases on round-trip (some keychain backends) doesn't
    // trigger a spurious mismatch.
    if (
      readBackPrivate?.toLowerCase() !== canonicalPrivate ||
      readBackPublic?.toLowerCase() !== canonicalPublic
    ) {
      logger.error('Identity round-trip mismatch after write', undefined, { component: 'KeyManager' });
      await KeyManager._rollbackPrimary(store, layout, priorPrivate, priorPublic);
      throw new IdentityPersistError('Identity write was not persisted correctly (round-trip mismatch).');
    }

    // Final sanity: derive public from the stored private and confirm the
    // pair signs/verifies cleanly. Catches a (theoretical) elliptic library
    // corruption immediately rather than the next time the user tries to
    // sign in.
    try {
      const keyPair = ec.keyFromPrivate(KeyManager.canonicalPrivateKey(readBackPrivate));
      const derived = keyPair.getPublic('hex');
      if (derived.toLowerCase() !== readBackPublic.toLowerCase()) {
        throw new IdentityPersistError('Stored public key does not match derived public key.');
      }
      // Sign/verify roundtrip using a known test vector
      const probeHash = '0'.repeat(64);
      const signature = keyPair.sign(probeHash);
      if (!keyPair.verify(probeHash, signature)) {
        throw new IdentityPersistError('Sign/verify roundtrip failed for newly stored identity.');
      }
    } catch (error) {
      await KeyManager._rollbackPrimary(store, layout, priorPrivate, priorPublic);
      if (error instanceof IdentityPersistError) throw error;
      logger.error('Identity sign/verify probe failed', error, { component: 'KeyManager' });
      throw new IdentityPersistError('Stored identity failed crypto self-test', error);
    }

    // Step 3: The new primary is durable and functional. NOW it is safe to
    // refresh the backup to the new key. This is part of the successful write
    // contract: returning success while the backup still belongs to the
    // previous identity would allow a later restore with an absent primary to
    // silently switch the device back to the previous account. Snapshot the
    // backup first so a partial backup refresh can be rolled back along with
    // the primary before surfacing the failure.
    let priorBackupPrivate: string | null;
    let priorBackupPublic: string | null;
    let priorBackupTimestamp: string | null;
    try {
      priorBackupPrivate = await store.getItemAsync(layout.backupPrivateKeyName, backupReadOpts);
      priorBackupPublic = await store.getItemAsync(layout.backupPublicKeyName, backupReadOpts);
      priorBackupTimestamp = await store.getItemAsync(layout.backupTimestampName, backupReadOpts);
    } catch (error) {
      logger.error('Failed to snapshot identity backup before refresh', error, { component: 'KeyManager' });
      await KeyManager._rollbackPrimary(store, layout, priorPrivate, priorPublic);
      throw new IdentityPersistError('Failed to snapshot identity backup before refresh', error);
    }

    try {
      await store.setItemAsync(layout.backupPrivateKeyName, canonicalPrivate, backupPrivWriteOpts);
      await store.setItemAsync(layout.backupPublicKeyName, canonicalPublic, backupPubWriteOpts);
      await store.setItemAsync(layout.backupTimestampName, Date.now().toString(), backupPubWriteOpts);
    } catch (error) {
      logger.error('Failed to refresh identity backup after primary write', error, { component: 'KeyManager' });
      await KeyManager._rollbackBackup(store, layout, priorBackupPrivate, priorBackupPublic, priorBackupTimestamp);
      await KeyManager._rollbackPrimary(store, layout, priorPrivate, priorPublic);
      throw new IdentityPersistError('Failed to refresh identity backup after primary write', error);
    }

    // Update cache only after we are certain the identity is durable, then fan
    // out to identity-change subscribers.
    KeyManager.cachedPublicKey = canonicalPublic;
    KeyManager.cachedHasIdentity = true;
    KeyManager.cachedPublicKeyResolved = false;
    KeyManager.notifyIdentityChanged();

    // LAST step: mirror the identity into the AndroidKeyStore-independent marker
    // so a later keystore death can be told apart from a fresh install. This is
    // best-effort — a marker write failure must NEVER fail an otherwise-durable
    // persist (a subsequent healthy read re-backfills it). Rollback paths above
    // return before reaching here, so they never touch the marker.
    await KeyManager._syncMarkerAfterPersist(canonicalPublic, origin);
  }

  /**
   * Write/refresh the identity marker after a successful persist. A same-identity
   * re-persist (e.g. backup refresh, idempotent re-import) preserves `createdAt`
   * and the `onboardingComplete` milestone by only updating `origin`; a NEW or
   * switched identity writes a fresh marker. Best-effort — never throws.
   *
   * @internal
   */
  private static async _syncMarkerAfterPersist(
    publicKey: string,
    origin: IdentityMarker['origin'],
  ): Promise<void> {
    try {
      const existing = await readIdentityMarker();
      if (existing && existing.publicKey.toLowerCase() === publicKey.toLowerCase()) {
        await updateIdentityMarker({ origin });
      } else {
        await writeIdentityMarker({ publicKey, origin });
      }
    } catch (error) {
      logger.warn('Failed to sync identity marker after persist (non-fatal)', { component: 'KeyManager' }, error);
    }
  }

  /**
   * Restore the backup slot to a previously-snapshotted state. Best-effort so
   * the original persistence error remains the one surfaced to the caller.
   *
   * @internal
   */
  private static async _rollbackBackup(
    store: Awaited<ReturnType<typeof initSecureStore>>,
    layout: ResolvedSlotLayout,
    priorBackupPrivate: string | null,
    priorBackupPublic: string | null,
    priorBackupTimestamp: string | null,
  ): Promise<void> {
    const backupPrivWriteOpts = KeyManager._privateWriteOpts(store, layout.backupService);
    const backupPubWriteOpts = KeyManager._slotOpts(layout.backupService);
    const backupReadOpts = KeyManager._slotOpts(layout.backupService);
    try {
      if (priorBackupPrivate) {
        await store.setItemAsync(layout.backupPrivateKeyName, priorBackupPrivate, backupPrivWriteOpts);
      } else {
        try { await store.deleteItemAsync(layout.backupPrivateKeyName, backupReadOpts); } catch { /* best effort */ }
      }

      if (priorBackupPublic) {
        await store.setItemAsync(layout.backupPublicKeyName, priorBackupPublic, backupPubWriteOpts);
      } else {
        try { await store.deleteItemAsync(layout.backupPublicKeyName, backupReadOpts); } catch { /* best effort */ }
      }

      if (priorBackupTimestamp) {
        await store.setItemAsync(layout.backupTimestampName, priorBackupTimestamp, backupPubWriteOpts);
      } else {
        try { await store.deleteItemAsync(layout.backupTimestampName, backupReadOpts); } catch { /* best effort */ }
      }
    } catch (rollbackError) {
      logger.error('Failed to roll back identity backup after a failed refresh', rollbackError, { component: 'KeyManager' });
    }
  }

  /**
   * Restore the primary slot to a previously-snapshotted (privA, pubA) pair,
   * or delete it entirely if there was no prior identity. Best-effort: every
   * step is wrapped so a rollback failure never masks the original error the
   * caller is about to throw. Invalidates the in-memory cache so the next read
   * reflects whatever actually landed on disk.
   *
   * @internal
   */
  private static async _rollbackPrimary(
    store: Awaited<ReturnType<typeof initSecureStore>>,
    layout: ResolvedSlotLayout,
    priorPrivate: string | null,
    priorPublic: string | null,
  ): Promise<void> {
    const primaryPrivWriteOpts = KeyManager._privateWriteOpts(store, layout.primaryService);
    const primaryPubWriteOpts = KeyManager._slotOpts(layout.primaryService);
    const primaryReadOpts = KeyManager._slotOpts(layout.primaryService);
    try {
      if (priorPrivate && priorPublic) {
        // Restore exactly what was there before the failed write.
        await store.setItemAsync(layout.primaryPublicKeyName, priorPublic, primaryPubWriteOpts);
        await store.setItemAsync(layout.primaryPrivateKeyName, priorPrivate, primaryPrivWriteOpts);
      } else {
        // There was no prior identity — leave the device empty rather than
        // half-written so hasIdentity() does not lie.
        try { await store.deleteItemAsync(layout.primaryPublicKeyName, primaryReadOpts); } catch { /* best effort */ }
        try { await store.deleteItemAsync(layout.primaryPrivateKeyName, primaryReadOpts); } catch { /* best effort */ }
      }
    } catch (rollbackError) {
      logger.error('Failed to roll back primary identity after a failed write', rollbackError, { component: 'KeyManager' });
    } finally {
      // Whatever happened, the cached verdict is no longer trustworthy.
      KeyManager.invalidateCache();
    }
  }

  /**
   * Generate and securely store a new key pair on the device.
   *
   * Refuses to overwrite an existing identity unless `options.overwrite === true`.
   * Returns the public key. The private key never leaves secure storage.
   *
   * @throws IdentityAlreadyExistsError if an identity already exists and overwrite is not set
   * @throws IdentityPersistError if the key cannot be durably written
   */
  static async createIdentity(options?: { overwrite?: boolean }): Promise<string> {
    if (isWebPlatform()) {
      throw new Error('Identity creation is only available on native platforms (iOS/Android). Please use the native app to create your identity.');
    }

    // CRITICAL SAFEGUARD: never silently overwrite an existing identity.
    // The local key IS the account — clobbering it without consent is
    // catastrophic. Callers must opt in explicitly when they have already
    // confirmed (via UI) that the user has saved their recovery phrase.
    //
    // The guard reads storage DIRECTLY (cache-bypassing) AND consults the
    // AndroidKeyStore-independent marker: either a stored key OR a marker means
    // an identity exists here → refuse. A storage THROW surfaces as
    // IdentityUnavailableError (never a blind write over a locked keystore).
    if (!options?.overwrite) {
      const marker = await readIdentityMarker();
      const direct = await KeyManager._readPrimaryDirect();
      if (direct.publicKey) {
        throw new IdentityAlreadyExistsError(direct.publicKey);
      }
      if (marker) {
        throw new IdentityAlreadyExistsError(marker.publicKey);
      }
    }

    const { privateKey, publicKey } = await KeyManager.generateKeyPair();
    await KeyManager._persistIdentityAtomic(privateKey, publicKey, 'create');
    return publicKey;
  }

  /**
   * Read the primary key pair DIRECTLY from storage, bypassing the in-memory
   * cache (which a prior transient failure could have poisoned). Awaits slot
   * migration first. Throws {@link IdentityUnavailableError} if storage is
   * deferred/locked or a read throws — so overwrite guards never write blind.
   *
   * @internal
   */
  private static async _readPrimaryDirect(): Promise<{ privateKey: string | null; publicKey: string | null }> {
    const migration = await KeyManager._ensureIdentitySlotsMigrated();
    if (migration.mode === 'deferred') {
      throw new IdentityUnavailableError(
        'Identity storage is temporarily unavailable; refusing to write blind.',
        migration.cause,
      );
    }
    const layout = migration.layout;
    const readOpts = KeyManager._slotOpts(layout.primaryService);
    try {
      const store = await initSecureStore();
      const privateKey = await store.getItemAsync(layout.primaryPrivateKeyName, readOpts);
      const publicKey = await store.getItemAsync(layout.primaryPublicKeyName, readOpts);
      return { privateKey, publicKey };
    } catch (error) {
      throw new IdentityUnavailableError('Could not read existing identity; refusing to write blind.', error);
    }
  }

  /**
   * Import an existing key pair (e.g., from recovery phrase).
   *
   * Refuses to overwrite an existing identity unless `options.overwrite === true`.
   *
   * @throws IdentityAlreadyExistsError if an identity already exists and overwrite is not set
   * @throws IdentityPersistError if the key cannot be durably written
   */
  static async importKeyPair(
    privateKey: string,
    options?: { overwrite?: boolean },
  ): Promise<string> {
    if (isWebPlatform()) {
      throw new Error('Identity import is only available on native platforms (iOS/Android). Please use the native app to import your identity.');
    }

    if (!KeyManager.isValidPrivateKey(privateKey)) {
      throw new Error('Invalid private key supplied to importKeyPair.');
    }

    // Canonicalize the incoming private key so the stored value (and the
    // derived public key) are always in canonical form. Without this, an
    // externally-imported short or uppercase key would derive one public
    // key here and a different one when later read back unpadded.
    const canonicalPrivate = KeyManager.canonicalPrivateKey(privateKey);
    const keyPair = ec.keyFromPrivate(canonicalPrivate);
    const publicKey = keyPair.getPublic('hex');

    // Refuse silent overwrite — see createIdentity() for rationale. The guard
    // reads storage DIRECTLY (cache-bypassing) AND the marker, and treats
    // storage as authoritative:
    //   - stored key === this import  → safe idempotent refresh (fall through)
    //   - stored key differs          → a DIFFERENT identity is present → refuse
    //   - storage empty + marker for a DIFFERENT identity (lost state) → refuse
    //   - storage empty + marker matches this import (recovery) / no marker → allow
    // A storage throw surfaces as IdentityUnavailableError (never a blind write).
    if (!options?.overwrite) {
      const marker = await readIdentityMarker();
      const direct = await KeyManager._readPrimaryDirect();
      const importedPub = publicKey.toLowerCase();
      const existingPub = direct.publicKey?.toLowerCase() ?? null;
      const markerPub = marker?.publicKey.toLowerCase() ?? null;

      if (existingPub && existingPub !== importedPub) {
        throw new IdentityAlreadyExistsError(direct.publicKey as string);
      }
      if (!existingPub && markerPub && markerPub !== importedPub) {
        throw new IdentityAlreadyExistsError(marker?.publicKey as string);
      }
      // Otherwise: existing === import (idempotent refresh), or storage empty
      // with a matching/absent marker (fresh import or lost-identity recovery)
      // → fall through and (re-)persist to refresh the backup + marker.
    }

    await KeyManager._persistIdentityAtomic(canonicalPrivate, publicKey, 'import');
    return publicKey;
  }

  /**
   * Get the stored private key
   * WARNING: Only use this for signing operations within the app
   *
   * Preserves the "return null on any storage failure" contract signing paths
   * rely on (a locked keychain simply means "cannot sign now"); unlike
   * {@link getPublicKey}, it does NOT throw {@link IdentityUnavailableError}.
   */
  static async getPrivateKey(): Promise<string | null> {
    if (isWebPlatform()) {
      return null; // Identity storage is only available on native platforms
    }
    try {
      const migration = await KeyManager._ensureIdentitySlotsMigrated();
      if (migration.mode === 'deferred') {
        // Storage unreadable right now — preserve the null contract.
        return null;
      }
      const store = await initSecureStore();
      return await store.getItemAsync(
        migration.layout.primaryPrivateKeyName,
        KeyManager._slotOpts(migration.layout.primaryService),
      );
    } catch (error) {
      // If secure store is not available, return null (no identity)
      // This allows the app to continue functioning even if secure store fails to load
      if (isDev()) {
        logger.warn('Failed to access secure store', { component: 'KeyManager' }, error);
      }
      return null;
    }
  }

  /**
   * Get the stored public key (cached for performance).
   *
   * Returns the public key, or `null` when a read SUCCEEDS and finds none.
   * THROWS {@link IdentityUnavailableError} when storage is unreadable (keychain
   * locked / module load failure) — a thrown read is NEVER flattened to `null`
   * and NEVER cached, so a poisoned "no identity" verdict can no longer stick.
   */
  static async getPublicKey(): Promise<string | null> {
    if (isWebPlatform()) {
      return null; // Identity storage is only available on native platforms
    }
    if (KeyManager.cachedPublicKey !== null) {
      return KeyManager.cachedPublicKey;
    }
    // A genuine-absent result (read succeeded, empty) is cacheable distinctly
    // from a thrown read — only the former sets this flag.
    if (KeyManager.cachedPublicKeyResolved) {
      return null;
    }

    const migration = await KeyManager._ensureIdentitySlotsMigrated();
    if (migration.mode === 'deferred') {
      throw new IdentityUnavailableError(
        'Identity storage is temporarily unavailable (keychain locked or unreadable).',
        migration.cause,
      );
    }

    try {
      const store = await initSecureStore();
      const publicKey = await store.getItemAsync(
        migration.layout.primaryPublicKeyName,
        KeyManager._slotOpts(migration.layout.primaryService),
      );
      if (publicKey !== null) {
        KeyManager.cachedPublicKey = publicKey;
      } else {
        // Genuine-absent (successful empty read) IS safe to cache.
        KeyManager.cachedPublicKeyResolved = true;
      }
      return publicKey;
    } catch (error) {
      // Storage threw AFTER migration resolved — transient/unavailable. Do NOT
      // cache; surface a typed error so callers never misread it as "no identity".
      if (isDev()) {
        logger.warn('Failed to access secure store', { component: 'KeyManager' }, error);
      }
      throw new IdentityUnavailableError('Failed to read identity from secure storage.', error);
    }
  }

  /**
   * Persist the recovery mnemonic (the 12-word phrase) into its dedicated,
   * device-only keychain slot so the user can re-reveal it from Settings after
   * onboarding.
   *
   * Called best-effort at identity creation/import, where the phrase is already
   * in memory: a failure to persist it must NEVER fail the identity itself, so
   * callers deliberately swallow the thrown error (logging it). Storage errors
   * throw {@link IdentityUnavailableError} — same "cannot determine" semantics as
   * the other getters — so a caller MAY observe/log the failure.
   *
   * The mnemonic is stored ONLY here — never in the marker, `getIdentityStatus`,
   * logs, or any exported bundle.
   */
  static async storeRecoveryMnemonic(mnemonic: string): Promise<void> {
    if (isWebPlatform()) {
      return; // Identity storage is only available on native platforms
    }
    try {
      const store = await initSecureStore();
      await store.setItemAsync(
        RECOVERY_MNEMONIC_STORAGE_KEY,
        mnemonic,
        KeyManager._privateWriteOpts(store, RECOVERY_MNEMONIC_KEYCHAIN_SERVICE),
      );
    } catch (error) {
      if (isDev()) {
        logger.warn('Failed to persist recovery mnemonic', { component: 'KeyManager' }, error);
      }
      throw new IdentityUnavailableError('Failed to persist recovery mnemonic.', error);
    }
  }

  /**
   * Read the stored recovery mnemonic for re-reveal in Settings.
   *
   * Returns the phrase, or `null` when a read SUCCEEDS and finds none — the
   * expected result for any identity created/imported before this feature
   * existed, since the phrase was never captured for those. THROWS
   * {@link IdentityUnavailableError} when storage is unreadable (keychain locked
   * / module load failure), matching {@link getPublicKey}'s contract — a thrown
   * read is never flattened to `null`, so a caller distinguishes "phrase was
   * never stored" from "keychain temporarily locked, retry".
   */
  static async getRecoveryMnemonic(): Promise<string | null> {
    if (isWebPlatform()) {
      return null; // Identity storage is only available on native platforms
    }
    try {
      const store = await initSecureStore();
      return await store.getItemAsync(
        RECOVERY_MNEMONIC_STORAGE_KEY,
        KeyManager._slotOpts(RECOVERY_MNEMONIC_KEYCHAIN_SERVICE),
      );
    } catch (error) {
      if (isDev()) {
        logger.warn('Failed to read recovery mnemonic', { component: 'KeyManager' }, error);
      }
      throw new IdentityUnavailableError('Failed to read recovery mnemonic from secure storage.', error);
    }
  }

  /**
   * Delete the stored recovery mnemonic. Best-effort: a delete failure is logged
   * and swallowed, never thrown — it runs inside the identity-deletion path where
   * an unreadable keychain must not abort the wider teardown.
   */
  static async deleteRecoveryMnemonic(): Promise<void> {
    if (isWebPlatform()) {
      return; // Identity storage is only available on native platforms
    }
    const store = await initSecureStore();
    await KeyManager._bestEffortDelete(store, RECOVERY_MNEMONIC_STORAGE_KEY, RECOVERY_MNEMONIC_KEYCHAIN_SERVICE);
  }

  /**
   * Check if a complete, parseable identity exists on this device.
   *
   * Returns `true` only when BOTH the private and public keys are present,
   * both are well-formed, AND the public key derives from the private key.
   * A partially-written or corrupted identity (read succeeded, bytes empty/bad)
   * returns `false` so that downstream code can resume the create / restore flow.
   * THROWS {@link IdentityUnavailableError} when storage is unreadable — a locked
   * keychain must never be mistaken for "no identity" (the old behavior that let
   * onboarding treat a transient lock as a blank device).
   *
   * Note: this does NOT perform the full sign/verify roundtrip — call
   * `verifyIdentityIntegrity()` for that.
   */
  static async hasIdentity(): Promise<boolean> {
    if (isWebPlatform()) {
      return false; // Identity storage is only available on native platforms
    }
    if (KeyManager.cachedHasIdentity !== null) {
      return KeyManager.cachedHasIdentity;
    }

    const migration = await KeyManager._ensureIdentitySlotsMigrated();
    if (migration.mode === 'deferred') {
      throw new IdentityUnavailableError('Identity storage is temporarily unavailable.', migration.cause);
    }

    let privateKey: string | null;
    let publicKey: string | null;
    try {
      const store = await initSecureStore();
      [privateKey, publicKey] = await Promise.all([
        store.getItemAsync(migration.layout.primaryPrivateKeyName, KeyManager._slotOpts(migration.layout.primaryService)),
        store.getItemAsync(migration.layout.primaryPublicKeyName, KeyManager._slotOpts(migration.layout.primaryService)),
      ]);
    } catch (error) {
      // Storage threw — could be a transient keychain lock (e.g., background
      // fetch before the device is unlocked). Do NOT cache; throw a TYPED error
      // so callers distinguish "temporarily unavailable" from "genuinely absent"
      // instead of silently treating a locked keystore as a blank device.
      logger.error('Failed to read identity from secure storage', error, { component: 'KeyManager' });
      throw new IdentityUnavailableError('Failed to read identity from secure storage.', error);
    }

    // Storage succeeded. Now classify the result. From here onward, any
    // outcome is stable and safe to cache (the bytes won't change between
    // calls).
    let hasIdentity = false;
    if (privateKey && publicKey) {
      // Require BOTH bytes-present AND parseable AND matching. Any weaker
      // check would let a half-written identity (private without public)
      // pretend to be a real one, which then fails opaquely later in the
      // sign-in flow when SignatureService.sign() can't find the keypair.
      if (KeyManager.isValidPrivateKey(privateKey) && KeyManager.isValidPublicKey(publicKey)) {
        try {
          const derived = ec
            .keyFromPrivate(KeyManager.canonicalPrivateKey(privateKey))
            .getPublic('hex');
          // Hex equality is case-insensitive; normalize on both sides to
          // tolerate legacy uppercase-stored public keys.
          hasIdentity = derived.toLowerCase() === publicKey.toLowerCase();
          if (!hasIdentity) {
            logger.warn(
              'KeyManager.hasIdentity: stored public key does not match derived public key',
              { component: 'KeyManager' },
            );
          }
        } catch (error) {
          logger.warn(
            'KeyManager.hasIdentity: failed to derive public key from stored private key',
            { component: 'KeyManager' },
            error,
          );
        }
      } else {
        logger.warn(
          'KeyManager.hasIdentity: stored key material is malformed',
          { component: 'KeyManager' },
        );
      }
    }

    // Cache result. Storage succeeded, so this verdict is stable:
    //   - true  → identity exists and round-trips cleanly
    //   - false → storage is empty / partial / malformed (a stable result;
    //             callers should run integrity-recovery / restore from
    //             backup explicitly)
    KeyManager.cachedHasIdentity = hasIdentity;
    if (hasIdentity && publicKey) {
      KeyManager.cachedPublicKey = publicKey;
    }
    // Diagnostic breadcrumb (dev only). Logs lengths + validity flags so we
    // can tell from `adb logcat` exactly WHY hasIdentity returned what it
    // did. Never log the key material itself.
    if (isDev()) {
      logger.debug(
        'KeyManager.hasIdentity result',
        { component: 'KeyManager' },
        {
          privateLen: privateKey?.length ?? 0,
          publicLen: publicKey?.length ?? 0,
          privateValid: privateKey ? KeyManager.isValidPrivateKey(privateKey) : null,
          publicValid: publicKey ? KeyManager.isValidPublicKey(publicKey) : null,
          derived: hasIdentity,
        },
      );
    }
    return hasIdentity;
  }

  /**
   * Authoritative identity verdict — the corruption-vs-fresh-install
   * disambiguator that routing (commons) keys off of.
   *
   * - Healthy pair → `present` (and the marker is backfilled if missing or
   *   pointing at a different key, `origin: 'backfill'`).
   * - Read succeeded but no healthy pair, WITH a marker → `lost` (keystore death
   *   / corruption; route to recovery, NEVER to create).
   * - Read succeeded, no pair, NO marker → `absent` (a genuine fresh device; the
   *   only state that may route to onboarding/create).
   * - A read THREW → `unavailable` (keychain locked); this verdict is NEVER
   *   cached, so a later call re-reads.
   *
   * @param opts.bypassCache When true, never reads OR writes the in-memory cache
   *   — a pure, fresh storage verdict for the auto-create interlock preflight.
   */
  static async getIdentityStatus(opts?: { bypassCache?: boolean }): Promise<IdentityStatus> {
    if (isWebPlatform()) {
      return { state: 'absent' }; // Identity storage is only available on native platforms
    }
    const bypassCache = opts?.bypassCache === true;

    // Read the marker FIRST (fail-open null) — it is the AndroidKeyStore-independent
    // signal that survives a keystore death.
    const marker = await readIdentityMarker();

    const migration = await KeyManager._ensureIdentitySlotsMigrated();
    if (migration.mode === 'deferred') {
      return { state: 'unavailable', cause: migration.cause };
    }

    let privateKey: string | null;
    let publicKey: string | null;
    try {
      const store = await initSecureStore();
      const readOpts = KeyManager._slotOpts(migration.layout.primaryService);
      privateKey = await store.getItemAsync(migration.layout.primaryPrivateKeyName, readOpts);
      publicKey = await store.getItemAsync(migration.layout.primaryPublicKeyName, readOpts);
    } catch (error) {
      // Storage threw — NEVER cache this verdict; callers retry.
      return { state: 'unavailable', cause: error };
    }

    if (KeyManager._isHealthyPair(privateKey, publicKey) && publicKey) {
      const canonicalPublic = publicKey.toLowerCase();
      // Backfill the marker when missing or pointing at a DIFFERENT identity —
      // e.g. a loss that predates markers, healed on first healthy read.
      if (!marker || marker.publicKey.toLowerCase() !== canonicalPublic) {
        try {
          await writeIdentityMarker({ publicKey: canonicalPublic, origin: 'backfill' });
        } catch (error) {
          logger.warn('Failed to backfill identity marker', { component: 'KeyManager' }, error);
        }
      }
      if (!bypassCache) {
        KeyManager.cachedPublicKey = canonicalPublic;
        KeyManager.cachedHasIdentity = true;
        KeyManager.cachedPublicKeyResolved = false;
      }
      return { state: 'present', publicKey: canonicalPublic };
    }

    // Read succeeded but no healthy pair present.
    if (!bypassCache) {
      KeyManager.cachedHasIdentity = false;
      KeyManager.cachedPublicKeyResolved = true;
    }
    if (marker) {
      return { state: 'lost', marker };
    }
    return { state: 'absent' };
  }

  /**
   * Delete the stored identity (both keys)
   * Use with EXTREME caution - this is irreversible without a recovery phrase
   * This should ONLY be called when explicitly requested by the user
   * @param skipBackup - If true, skip backup before deletion (default: false)
   * @param force - If true, skip confirmation checks (default: false)
   * @param userConfirmed - If true, user has explicitly confirmed deletion (default: false)
   */
  static async deleteIdentity(
    skipBackup = false, 
    force = false,
    userConfirmed = false
  ): Promise<void> {
    if (isWebPlatform()) {
      return; // Identity storage is only available on native platforms, nothing to delete
    }
    // CRITICAL SAFEGUARD: Require explicit user confirmation unless force is true
    if (!force && !userConfirmed) {
      throw new Error('Identity deletion requires explicit user confirmation. This is a safety measure to prevent accidental data loss.');
    }

    if (!force) {
      // May throw IdentityUnavailableError if storage is locked — correct: a
      // non-force delete must abort rather than run against an unreadable store.
      const hasIdentity = await KeyManager.hasIdentity();
      if (!hasIdentity) {
        return; // Nothing to delete
      }
    }

    const store = await initSecureStore();

    // ALWAYS create backup before deletion unless explicitly skipped
    if (!skipBackup) {
      try {
        const backupSuccess = await KeyManager.backupIdentity();
        if (!backupSuccess && isDev()) {
          logger.warn('Failed to backup identity before deletion - proceeding anyway', { component: 'KeyManager' });
        }
      } catch (backupError) {
        if (isDev()) {
          logger.warn('Failed to backup identity before deletion', { component: 'KeyManager' }, backupError);
        }
      }
    }

    // Delete the primary from the active layout (authoritative), then best-effort
    // delete BOTH generations so a stale legacy copy can never resurrect the
    // identity after deletion.
    const migration = await KeyManager._ensureIdentitySlotsMigrated();
    if (migration.mode !== 'deferred') {
      const layout = migration.layout;
      const readOpts = KeyManager._slotOpts(layout.primaryService);
      await store.deleteItemAsync(layout.primaryPrivateKeyName, readOpts);
      await store.deleteItemAsync(layout.primaryPublicKeyName, readOpts);
    }
    await KeyManager._bestEffortDeleteV2Primary(store);
    await KeyManager._bestEffortDelete(store, STORAGE_KEYS.PRIVATE_KEY);
    await KeyManager._bestEffortDelete(store, STORAGE_KEYS.PUBLIC_KEY);

    // Always drop the stored recovery mnemonic — it is scoped to the identity
    // being deleted, so a leftover would let Settings reveal a stale phrase for
    // an identity that no longer exists (or a DIFFERENT one after re-onboarding).
    await KeyManager.deleteRecoveryMnemonic();

    // Also clear backups + the shared slot on force deletion, so a deleted
    // identity cannot be resurrected from any recovery source.
    if (force) {
      await KeyManager._bestEffortDeleteBackupsAllGenerations(store);
      await KeyManager._clearSharedSlot(store);
    }

    // Clear the marker AFTER key deletion succeeds — a marker must never outlive
    // its identity (a leftover marker would route a truly-absent device to
    // `recovery` instead of `welcome`).
    try {
      await clearIdentityMarker();
    } catch (error) {
      logger.warn('Failed to clear identity marker during delete', { component: 'KeyManager' }, error);
    }

    // Invalidate cache LAST — its subscriber fan-out fires only after both the
    // keys AND the marker are gone, so a routing subscriber that re-reads on the
    // notification observes `absent`, never a transient `lost`.
    KeyManager.invalidateCache();
  }

  /**
   * Backup identity to SecureStore (separate backup storage)
   * This provides a recovery mechanism if primary storage fails
   */
  static async backupIdentity(): Promise<boolean> {
    if (isWebPlatform()) {
      return false; // Identity storage is only available on native platforms
    }
    try {
      const store = await initSecureStore();
      const migration = await KeyManager._ensureIdentitySlotsMigrated();
      if (migration.mode === 'deferred') {
        return false; // Cannot read the primary safely → nothing to back up
      }
      const layout = migration.layout;
      // Read the primary DIRECTLY (raw) rather than via getPublicKey (which now
      // throws) — a locked keychain here should simply mean "nothing to back up".
      const primaryReadOpts = KeyManager._slotOpts(layout.primaryService);
      const privateKey = await store.getItemAsync(layout.primaryPrivateKeyName, primaryReadOpts);
      const publicKey = await store.getItemAsync(layout.primaryPublicKeyName, primaryReadOpts);

      if (!privateKey || !publicKey) {
        return false; // Nothing to backup
      }

      // Store backup in SecureStore (still secure, but separate from primary storage)
      await store.setItemAsync(
        layout.backupPrivateKeyName,
        privateKey,
        KeyManager._privateWriteOpts(store, layout.backupService),
      );
      await store.setItemAsync(layout.backupPublicKeyName, publicKey, KeyManager._slotOpts(layout.backupService));
      await store.setItemAsync(layout.backupTimestampName, Date.now().toString(), KeyManager._slotOpts(layout.backupService));

      return true;
    } catch (error) {
      if (isDev()) {
        logger.error('Failed to backup identity', error, { component: 'KeyManager' });
      }
      return false;
    }
  }

  /**
   * Verify identity integrity — checks keys are valid, accessible, derive
   * consistently, AND can sign + verify a probe message.
   *
   * Returns true only when the full sign/verify roundtrip succeeds. Use
   * this on app start to detect silent corruption before the user finds
   * out by failing to sign in.
   */
  static async verifyIdentityIntegrity(): Promise<boolean> {
    if (isWebPlatform()) {
      return false; // Identity storage is only available on native platforms
    }
    try {
      const privateKey = await KeyManager.getPrivateKey();
      const publicKey = await KeyManager.getPublicKey();

      if (!privateKey || !publicKey) {
        return false;
      }

      // Validate formats
      if (!KeyManager.isValidPrivateKey(privateKey)) {
        return false;
      }
      if (!KeyManager.isValidPublicKey(publicKey)) {
        return false;
      }

      // Verify public key derives from private key (case-insensitive
      // because hex is case-insensitive — legacy uppercase stored values
      // must still validate).
      const derivedPublicKey = KeyManager.derivePublicKey(privateKey);
      if (derivedPublicKey.toLowerCase() !== publicKey.toLowerCase()) {
        return false; // Keys don't match
      }

      // Full sign/verify probe — proves the keypair is functional, not just
      // bytewise parseable. A previous version of this method would return
      // true even when the underlying elliptic curve state was wedged.
      const keyPair = ec.keyFromPrivate(KeyManager.canonicalPrivateKey(privateKey));
      const probeHash = '0'.repeat(64);
      const signature = keyPair.sign(probeHash);
      if (!keyPair.verify(probeHash, signature)) {
        logger.error('Identity sign/verify probe failed during integrity check', undefined, { component: 'KeyManager' });
        return false;
      }

      return true;
    } catch (error) {
      logger.error('Identity integrity check failed', error, { component: 'KeyManager' });
      return false;
    }
  }

  /**
   * Restore identity from backup if primary storage is genuinely missing or
   * corrupt.
   *
   * SAFETY (three independent guards against silently switching accounts):
   *   1. If the primary passes a full sign/verify probe, do nothing.
   *   2. If the primary keys CANNOT BE READ (storage threw — e.g. a transient
   *      keychain lock during a background launch), do nothing. We must NOT
   *      treat "couldn't read" as "corrupted" and restore a possibly-stale
   *      backup over an identity that is actually fine but momentarily
   *      inaccessible.
   *   3. If a primary private/public key IS present but does not match the
   *      backup, the backup may belong to a different identity — refuse, so we
   *      never silently switch the user to another account.
   *
   * Only when the primary is provably absent (read succeeded, returned
   * null/empty) or provably corrupt (read succeeded, bytes malformed AND no
   * conflicting key material is present) do we rebuild it from the backup.
   */
  static async restoreIdentityFromBackup(): Promise<boolean> {
    if (isWebPlatform()) {
      return false; // Identity storage is only available on native platforms
    }
    try {
      const store = await initSecureStore();
      const migration = await KeyManager._ensureIdentitySlotsMigrated();
      if (migration.mode === 'deferred') {
        // Storage locked — refuse to restore (guard 2). Retry a later call.
        logger.warn(
          'restoreIdentityFromBackup: identity storage unavailable. Refusing to restore.',
          { component: 'KeyManager' },
        );
        return false;
      }
      const layout = migration.layout;
      const primaryReadOpts = KeyManager._slotOpts(layout.primaryService);
      const backupReadOpts = KeyManager._slotOpts(layout.backupService);

      // Read the primary DIRECTLY (not via the error-swallowing getters) so
      // we can distinguish a transient read failure from a genuinely absent
      // key. A thrown read here means the keychain is locked/unavailable —
      // bail out and let a later call retry rather than risk restoring over a
      // healthy-but-locked identity.
      let primaryPrivate: string | null;
      let primaryPublic: string | null;
      try {
        primaryPrivate = await store.getItemAsync(layout.primaryPrivateKeyName, primaryReadOpts);
        primaryPublic = await store.getItemAsync(layout.primaryPublicKeyName, primaryReadOpts);
      } catch (error) {
        logger.warn(
          'restoreIdentityFromBackup: could not read primary (transient?). Refusing to restore.',
          { component: 'KeyManager' },
          error,
        );
        return false;
      }

      // If the primary reads back as a complete, self-consistent identity, it
      // is healthy — nothing to restore. (Guard 1.)
      if (primaryPrivate && primaryPublic) {
        if (
          KeyManager.isValidPrivateKey(primaryPrivate) &&
          KeyManager.isValidPublicKey(primaryPublic) &&
          KeyManager.derivePublicKey(primaryPrivate).toLowerCase() === primaryPublic.toLowerCase()
        ) {
          return false;
        }
      }

      // Load + validate the backup.
      const backupPrivateKey = await store.getItemAsync(layout.backupPrivateKeyName, backupReadOpts);
      const backupPublicKey = await store.getItemAsync(layout.backupPublicKeyName, backupReadOpts);

      if (!backupPrivateKey || !backupPublicKey) {
        return false; // No backup available
      }

      if (!KeyManager.isValidPrivateKey(backupPrivateKey) || !KeyManager.isValidPublicKey(backupPublicKey)) {
        logger.warn('Backup identity is malformed; refusing to restore', { component: 'KeyManager' });
        return false;
      }

      // Verify backup keys derive consistently. Hex is case-insensitive so
      // normalize both sides — a legacy uppercase-stored backup must still
      // be considered valid.
      const derivedPublicKey = KeyManager.derivePublicKey(backupPrivateKey);
      if (derivedPublicKey.toLowerCase() !== backupPublicKey.toLowerCase()) {
        logger.warn('Backup public key does not match derived; refusing to restore', { component: 'KeyManager' });
        return false;
      }

      // Guard 3: if ANY primary key material is still present and identifies a
      // DIFFERENT identity than the backup, refuse — the backup may be from a
      // completely different account and restoring it would silently switch
      // the user. We check the private key too (not just the public): a
      // present private key that derives to a non-backup public means a real,
      // different identity is sitting in the primary slot.
      if (
        primaryPublic &&
        primaryPublic.toLowerCase() !== backupPublicKey.toLowerCase()
      ) {
        logger.error(
          'Primary public key is present, corrupt-or-mismatched, AND differs from the backup. Refusing to restore to avoid switching accounts.',
          undefined,
          { component: 'KeyManager' },
        );
        return false;
      }
      if (
        primaryPrivate &&
        KeyManager.isValidPrivateKey(primaryPrivate) &&
        KeyManager.derivePublicKey(primaryPrivate).toLowerCase() !== backupPublicKey.toLowerCase()
      ) {
        logger.error(
          'Primary private key identifies a DIFFERENT identity than the backup. Refusing to restore to avoid switching accounts.',
          undefined,
          { component: 'KeyManager' },
        );
        return false;
      }

      // Safe to restore: rebuild the primary using the same atomic write
      // path createIdentity uses, including verification.
      try {
        await KeyManager._persistIdentityAtomic(backupPrivateKey, backupPublicKey, 'restore');
      } catch (error) {
        logger.error('Failed to persist identity restored from backup', error, { component: 'KeyManager' });
        return false;
      }

      await store.setItemAsync(layout.backupTimestampName, Date.now().toString(), backupReadOpts);
      return true;
    } catch (error) {
      logger.error('Failed to restore identity from backup', error, { component: 'KeyManager' });
      return false;
    }
  }

  /**
   * Recovery ladder — restore a `lost` identity from an independent,
   * `key_v1`-surviving source WITHOUT the user re-entering their recovery phrase.
   *
   * Gated on {@link getIdentityStatus} being `lost` (marker present, keys empty):
   *   - `present` / `absent` → `not-lost` (nothing to recover / nothing lost)
   *   - `unavailable`        → `unavailable` (keychain locked; retry later)
   *
   * Rungs, tried in order, each fully validated (well-formed + derive-match +
   * `publicKey === marker.publicKey`, so a source holding a DIFFERENT account is
   * SKIPPED, never restored):
   *   1. the v2 backup slot (independent keychain key from the primary), then
   *   2. the cross-app shared slot (Android bridge `getShared` / iOS keychain
   *      group) — the copy that survives a primary+backup `key_v1` death.
   *
   * On success it re-persists via {@link _persistIdentityAtomic} (origin
   * `'restore'`) and invalidates the cache so routing re-reads `present`. When no
   * rung matches, the UI proceeds to recovery-phrase entry.
   */
  static async attemptIdentityRecovery(): Promise<IdentityRecoveryResult> {
    if (isWebPlatform()) {
      return { recovered: false, reason: 'not-lost' };
    }

    const status = await KeyManager.getIdentityStatus({ bypassCache: true });
    if (status.state === 'present' || status.state === 'absent') {
      return { recovered: false, reason: 'not-lost' };
    }
    if (status.state === 'unavailable') {
      return { recovered: false, reason: 'unavailable' };
    }

    // status.state === 'lost'
    const expectedPublic = status.marker.publicKey.toLowerCase();
    let sawMismatch = false;

    // Rung 1: backup slot.
    const backupCandidate = await KeyManager._readBackupCandidate();
    if (backupCandidate) {
      if (backupCandidate.publicKey.toLowerCase() === expectedPublic) {
        if (await KeyManager._commitRecovery(backupCandidate.privateKey, backupCandidate.publicKey)) {
          return { recovered: true, source: 'backup', publicKey: backupCandidate.publicKey };
        }
      } else {
        sawMismatch = true;
      }
    }

    // Rung 2: cross-app shared slot.
    const sharedCandidate = await KeyManager._readSharedCandidate();
    if (sharedCandidate) {
      if (sharedCandidate.publicKey.toLowerCase() === expectedPublic) {
        if (await KeyManager._commitRecovery(sharedCandidate.privateKey, sharedCandidate.publicKey)) {
          return { recovered: true, source: 'shared', publicKey: sharedCandidate.publicKey };
        }
      } else {
        sawMismatch = true;
      }
    }

    // A source existed but identified a DIFFERENT account — never silently
    // switched. Report `mismatch` so the UI can require explicit confirmation.
    return { recovered: false, reason: sawMismatch ? 'mismatch' : 'no-sources' };
  }

  /** Read the active-layout backup slot as a healthy candidate, or null. @internal */
  private static async _readBackupCandidate(): Promise<{ privateKey: string; publicKey: string } | null> {
    try {
      const migration = await KeyManager._ensureIdentitySlotsMigrated();
      if (migration.mode === 'deferred') {
        return null;
      }
      const layout = migration.layout;
      const backupReadOpts = KeyManager._slotOpts(layout.backupService);
      const store = await initSecureStore();
      const privateKey = await store.getItemAsync(layout.backupPrivateKeyName, backupReadOpts);
      const publicKey = await store.getItemAsync(layout.backupPublicKeyName, backupReadOpts);
      if (KeyManager._isHealthyPair(privateKey, publicKey) && privateKey && publicKey) {
        return { privateKey, publicKey };
      }
      return null;
    } catch (error) {
      logger.warn('Recovery: failed to read backup slot', { component: 'KeyManager' }, error);
      return null;
    }
  }

  /** Read the cross-app shared slot as a healthy candidate, or null. @internal */
  private static async _readSharedCandidate(): Promise<{ privateKey: string; publicKey: string } | null> {
    try {
      const privateKey = await KeyManager.getSharedPrivateKey();
      const publicKey = await KeyManager.getSharedPublicKey();
      if (KeyManager._isHealthyPair(privateKey, publicKey) && privateKey && publicKey) {
        return { privateKey, publicKey };
      }
      return null;
    } catch (error) {
      logger.warn('Recovery: failed to read shared slot', { component: 'KeyManager' }, error);
      return null;
    }
  }

  /** Persist a validated recovery candidate + refresh caches/subscribers. @internal */
  private static async _commitRecovery(privateKey: string, publicKey: string): Promise<boolean> {
    try {
      await KeyManager._persistIdentityAtomic(privateKey, publicKey, 'restore');
      KeyManager.invalidateCache();
      return true;
    } catch (error) {
      logger.error('Recovery: failed to persist recovered identity', error, { component: 'KeyManager' });
      return false;
    }
  }

  /**
   * Get the elliptic curve key object from the stored private key
   * Used internally for signing operations
   */
  static async getKeyPairObject(): Promise<EC.KeyPair | null> {
    if (isWebPlatform()) {
      return null; // Identity storage is only available on native platforms
    }
    const privateKey = await KeyManager.getPrivateKey();
    if (!privateKey) return null;
    return ec.keyFromPrivate(KeyManager.canonicalPrivateKey(privateKey));
  }

  /**
   * Derive public key from a private key (without storing)
   */
  static derivePublicKey(privateKey: string): string {
    const keyPair = ec.keyFromPrivate(KeyManager.canonicalPrivateKey(privateKey));
    return keyPair.getPublic('hex');
  }

  /**
   * Normalize a public key to uncompressed, lowercased hex. Used when building
   * signed rotation payloads so legacy compressed/cased encodings still verify.
   */
  static canonicalPublicKey(publicKey: string): string {
    return ec.keyFromPublic(publicKey, 'hex').getPublic(false, 'hex').toLowerCase();
  }

  /**
   * Validate that a string is a valid public key
   *
   * Returns false on parse errors (invalid input is the expected fail mode here).
   * Errors are logged at debug level so they're available when troubleshooting
   * but don't pollute production logs.
   */
  static isValidPublicKey(publicKey: string): boolean {
    if (typeof publicKey !== 'string' || publicKey.length === 0) {
      return false;
    }
    // secp256k1 public keys are either uncompressed (130 hex chars, starts with 04)
    // or compressed (66 hex chars, starts with 02 or 03). Anything else is
    // clearly bogus; reject up front so we never silently widen the trust
    // boundary by accepting whatever BN(...) parses out of junk input.
    if (!/^[0-9a-fA-F]+$/.test(publicKey)) {
      return false;
    }
    if (publicKey.length !== 130 && publicKey.length !== 66) {
      return false;
    }
    try {
      ec.keyFromPublic(publicKey, 'hex');
      return true;
    } catch (error) {
      if (isDev()) {
        logger.debug('[oxy.crypto] isValidPublicKey rejected input', { component: 'KeyManager' }, error);
      }
      return false;
    }
  }

  /**
   * Validate that a string is a valid private key.
   *
   * secp256k1 private keys are 256-bit, so 64 hex chars. We require strict
   * hex-only input because `elliptic`'s underlying `BN(input, 16)` happily
   * accepts non-hex characters (treating them as zero), which would let
   * "not-hex" pass through as a valid (but compromised, near-zero) key.
   */
  static isValidPrivateKey(privateKey: string): boolean {
    if (typeof privateKey !== 'string' || privateKey.length === 0) {
      return false;
    }
    if (!/^[0-9a-fA-F]+$/.test(privateKey)) {
      return false;
    }
    // secp256k1 private keys are 32 bytes (64 hex chars). `elliptic`'s
    // `getPrivate('hex')` strips leading zero bytes, so a valid key whose
    // leading byte is 0 ends up as 62 hex chars in storage. Accept any
    // length from 1..64 here — we re-pad before deriving below — and
    // reject longer than 64.
    if (privateKey.length > 64) {
      return false;
    }
    const padded = privateKey.padStart(64, '0').toLowerCase();
    // After padding, require minimum entropy: reject obvious low-scalar
    // keys. A scalar that fits in 8 hex chars (~32 bits of entropy) is a
    // degenerate / accidental key, not a real one. The existing isZero()
    // check below covers literal 0; this also rejects trivially small
    // scalars like '1', '2', etc. that would otherwise pad to a valid but
    // weak key whose public point is trivially derivable.
    if (/^0{56}/.test(padded)) {
      return false;
    }
    try {
      const keyPair = ec.keyFromPrivate(padded);
      const priv = keyPair.getPrivate();
      // Private key must be > 0 and < curve order n. elliptic doesn't
      // enforce this on keyFromPrivate, so we do it here.
      if (priv.isZero() || priv.cmp(ec.curve.n) >= 0) {
        return false;
      }
      // Verify it can derive a public key
      const pub = keyPair.getPublic('hex');
      if (!pub || pub.length === 0) {
        return false;
      }
      return true;
    } catch (error) {
      if (isDev()) {
        logger.debug('[oxy.crypto] isValidPrivateKey rejected input', { component: 'KeyManager' }, error);
      }
      return false;
    }
  }

  /**
   * Derive a 32-byte, domain-separated seed from the on-device Oxy identity
   * private key via HKDF-SHA256, WITHOUT ever exposing the raw private key.
   *
   * The domain separation is carried by `info` (e.g. `"oxypay/faircoin/v1"`),
   * so distinct apps/purposes get independent seeds from the same identity.
   * The output is HKDF keying material, never the private key itself — a
   * consumer (e.g. Oxy Pay's FairCoin HD wallet) can feed it straight into
   * `HDKey.fromMasterSeed` and never touches the identity key.
   *
   * Key source (native only): prefers the shared ecosystem identity written to
   * `group.so.oxy.shared` (what a Relying Party like Oxy Pay reads), then falls
   * back to this device's primary identity (Commons/Accounts). Both reproduce
   * from the user's Oxy recovery phrase, so the derived seed is recoverable.
   *
   * @param info Context/domain-binding label (distinct labels → independent seeds).
   * @returns 32 bytes of derived keying material, or `null` on web / when no
   *          identity key is available on this device.
   */
  static async deriveScopedSeed(info: string): Promise<Uint8Array | null> {
    if (isWebPlatform()) {
      return null;
    }
    const privateKey =
      (await KeyManager.getSharedPrivateKey()) ?? (await KeyManager.getPrivateKey());
    if (!privateKey) {
      return null;
    }
    const ikm = hexToBytes(KeyManager.canonicalPrivateKey(privateKey));
    return hkdfSha256(ikm, utf8ToBytes(SCOPED_SEED_KDF_SALT), utf8ToBytes(info), 32);
  }

  /**
   * Get a shortened version of the public key for display
   * Format: first 8 chars...last 8 chars
   */
  static shortenPublicKey(publicKey: string): string {
    if (publicKey.length <= 20) return publicKey;
    return `${publicKey.slice(0, 8)}...${publicKey.slice(-8)}`;
  }
}

export default KeyManager;


