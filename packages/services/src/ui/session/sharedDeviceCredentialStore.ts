/**
 * The platform half of the shared native DeviceSession credential.
 *
 * `@oxyhq/core` owns the rules (`sharedDeviceCredential.ts`: when to adopt, when
 * to publish, and above all that an unreadable slot is never an empty one). This
 * module owns only where the bytes live, which is genuinely different per
 * platform:
 *
 *  - **iOS** — one `expo-secure-store` item in the approved Keychain Access Group
 *    `group.so.oxy.shared`, under its OWN `keychainService`
 *    ({@link IOS_DEVICE_SESSION_KEYCHAIN_SERVICE}). Every identity slot uses a
 *    different service (`oxy_identity`, `oxy_identity_backup`,
 *    `oxy_identity_mnemonic`) and the legacy cross-app identity keypair uses the
 *    same group with NO service at all — so this item cannot alias any of them.
 *    That separation is the point of the whole phase: the group-shared identity
 *    key and the group-shared device-session credential are different secrets
 *    with different blast radii and must not be conflated.
 *  - **Android** — the signature-protected `OxyDeviceSession` broker (its own
 *    EncryptedSharedPreferences file, its own ContentProvider, its own
 *    `signature`-level permission). It carries a session credential; it can NOT
 *    reach the identity keypair, which lives in a different file behind a
 *    different provider.
 *  - **web / anything else** — no shared slot. Each origin is its own device by
 *    design, so the factory returns `null` and the cold boot simply omits the
 *    lane.
 *
 * ## What is written here, and what is not
 *
 * Only `{deviceId, deviceSecret}`. No access token, no account id, no user id,
 * and never any identity key material.
 *
 * ## Accessibility
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: a device credential must not travel to
 * another handset in an iCloud/encrypted backup restore — the restored device is
 * a different device and has to establish its own session. It also keeps the item
 * out of reach while the phone is locked, which is why a read can legitimately
 * fail and why the `unavailable` verdict exists at all.
 */
import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';
import {
  normalizeSharedDeviceSessionRead,
  type SharedDeviceCredential,
  type SharedDeviceCredentialRead,
  type SharedDeviceCredentialStore,
} from '@oxyhq/core';

/**
 * The iOS Keychain Access Group every official Oxy app declares in its
 * entitlements. Shared with the identity slots — the group is the app-group
 * boundary, not the secret's identity.
 */
export const IOS_KEYCHAIN_ACCESS_GROUP = 'group.so.oxy.shared';

/**
 * The iOS `keychainService` for the DEVICE SESSION credential. Deliberately
 * distinct from every identity and recovery service; do not reuse one of those
 * here, and do not drop it (an item written with no service shares the legacy
 * identity slot's namespace inside the group).
 */
export const IOS_DEVICE_SESSION_KEYCHAIN_SERVICE = 'oxy_device_session';

/** The single key holding the JSON-encoded `{deviceId, deviceSecret}` pair. */
export const SHARED_DEVICE_SESSION_STORAGE_KEY = 'oxy_shared_device_session_v1';

// Variable indirection so Metro's static analyzer never traces expo-secure-store
// into the web bundle; the module is native-only and optional.
const SECURE_STORE_MODULE = 'expo-secure-store';

/**
 * The subset of `expo-secure-store` this module needs. Unlike the adapter in
 * `nativeSecureStorage.ts` it must pass OPTIONS — the access group and the
 * dedicated service are the entire mechanism here, so an options-less wrapper
 * would silently write a package-private item that no sibling app can see.
 */
interface KeychainGroupStore {
  getItemAsync(key: string, options?: object): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: object): Promise<void>;
  deleteItemAsync(key: string, options?: object): Promise<void>;
  readonly WHEN_UNLOCKED_THIS_DEVICE_ONLY: number;
}

let keychainStorePromise: Promise<KeychainGroupStore | null> | null = null;

function loadKeychainGroupStore(): Promise<KeychainGroupStore | null> {
  if (!keychainStorePromise) {
    const moduleName = SECURE_STORE_MODULE;
    keychainStorePromise = import(moduleName)
      .then((mod: Partial<KeychainGroupStore>) => {
        if (
          typeof mod.getItemAsync === 'function' &&
          typeof mod.setItemAsync === 'function' &&
          typeof mod.deleteItemAsync === 'function' &&
          typeof mod.WHEN_UNLOCKED_THIS_DEVICE_ONLY === 'number'
        ) {
          return {
            getItemAsync: mod.getItemAsync.bind(mod),
            setItemAsync: mod.setItemAsync.bind(mod),
            deleteItemAsync: mod.deleteItemAsync.bind(mod),
            WHEN_UNLOCKED_THIS_DEVICE_ONLY: mod.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          } satisfies KeychainGroupStore;
        }
        return null;
      })
      .catch(() => null);
  }
  return keychainStorePromise;
}

/** Parse the stored JSON into a credential, or `null` for anything malformed. */
function parseStoredCredential(raw: string | null): SharedDeviceCredential | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.deviceId !== 'string' ||
    candidate.deviceId.length === 0 ||
    typeof candidate.deviceSecret !== 'string' ||
    candidate.deviceSecret.length === 0
  ) {
    return null;
  }
  return { deviceId: candidate.deviceId, deviceSecret: candidate.deviceSecret };
}

/**
 * The iOS store: one keychain item in the shared access group.
 *
 * A THROWN read is `unavailable`, a `null` read is `absent`. That mapping is the
 * whole safety contract — `expo-secure-store` returns `null` for a genuinely
 * missing item and throws when the keychain itself refuses, and collapsing the
 * two is what would let a locked phone look like a device that never had a
 * session.
 */
function createKeychainGroupCredentialStore(): SharedDeviceCredentialStore {
  const readOptions = {
    keychainService: IOS_DEVICE_SESSION_KEYCHAIN_SERVICE,
    keychainAccessGroup: IOS_KEYCHAIN_ACCESS_GROUP,
  };

  return {
    read: async (): Promise<SharedDeviceCredentialRead> => {
      const store = await loadKeychainGroupStore();
      if (!store) {
        return { state: 'unsupported' };
      }
      let raw: string | null;
      try {
        raw = await store.getItemAsync(SHARED_DEVICE_SESSION_STORAGE_KEY, readOptions);
      } catch (error) {
        return { state: 'unavailable', cause: error };
      }
      if (raw === null) {
        return { state: 'absent' };
      }
      const credential = parseStoredCredential(raw);
      if (!credential) {
        // Something IS stored and we cannot read it. Reporting `absent` would
        // authorise overwriting whatever a newer build put there.
        return {
          state: 'unavailable',
          cause: new Error('shared device session item is present but not parseable'),
        };
      }
      return { state: 'present', credential };
    },

    publish: async (credential): Promise<boolean> => {
      const store = await loadKeychainGroupStore();
      if (!store) {
        return false;
      }
      const value = JSON.stringify(credential);
      try {
        await store.setItemAsync(SHARED_DEVICE_SESSION_STORAGE_KEY, value, {
          ...readOptions,
          keychainAccessible: store.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
        // Read-back verify. A keychain write can resolve without the item having
        // landed under the access group (a missing entitlement is the usual
        // cause), and a phantom credential would send a fresh install into a mint
        // that can never succeed.
        return (await store.getItemAsync(SHARED_DEVICE_SESSION_STORAGE_KEY, readOptions)) === value;
      } catch {
        return false;
      }
    },

    clear: async (): Promise<void> => {
      const store = await loadKeychainGroupStore();
      if (!store) {
        return;
      }
      try {
        await store.deleteItemAsync(SHARED_DEVICE_SESSION_STORAGE_KEY, readOptions);
      } catch {
        // Best-effort: the slot is a join point, not a source of truth.
      }
    },
  };
}

/**
 * The Android broker's JS surface. `read` returns an UNTRUSTED payload that
 * {@link normalizeSharedDeviceSessionRead} narrows; `write` reports whether the
 * native read-back confirmed the bytes.
 */
interface OxyDeviceSessionNativeModule {
  read(): Promise<unknown>;
  write(deviceId: string, deviceSecret: string): Promise<boolean>;
  clear(): Promise<void>;
}

let brokerModule: OxyDeviceSessionNativeModule | null | undefined;

/**
 * Resolve the `OxyDeviceSession` broker, or `null` when it is not autolinked.
 *
 * `requireOptionalNativeModule` (a static import Metro always resolves) rather
 * than a dynamic `import(moduleName)`: the latter compiles to `require(variable)`
 * in the CJS build, which Metro cannot resolve inside a consuming app — it
 * silently returns `null` there, which is exactly how the cross-app identity
 * bridge broke once. Same reasoning as `backgroundSession.ts` next door.
 */
function loadBrokerModule(): OxyDeviceSessionNativeModule | null {
  if (brokerModule === undefined) {
    const native = requireOptionalNativeModule<Partial<OxyDeviceSessionNativeModule>>('OxyDeviceSession');
    brokerModule =
      native && typeof native.read === 'function' && typeof native.write === 'function' && typeof native.clear === 'function'
        ? {
            read: native.read.bind(native),
            write: native.write.bind(native),
            clear: native.clear.bind(native),
          }
        : null;
  }
  return brokerModule;
}

/**
 * The Android store: the signature-protected `OxyDeviceSession` broker.
 *
 * The broker already answers with an explicit status, so the only work here is
 * narrowing an UNTRUSTED payload — `normalizeSharedDeviceSessionRead` resolves
 * anything it does not recognise to `unavailable`, never `absent`.
 */
function createBrokerCredentialStore(): SharedDeviceCredentialStore {
  return {
    read: async (): Promise<SharedDeviceCredentialRead> => {
      const broker = loadBrokerModule();
      if (!broker) {
        return { state: 'unsupported' };
      }
      try {
        return normalizeSharedDeviceSessionRead(await broker.read());
      } catch (error) {
        return { state: 'unavailable', cause: error };
      }
    },

    publish: async (credential): Promise<boolean> => {
      const broker = loadBrokerModule();
      if (!broker) {
        return false;
      }
      try {
        // The broker read-back-verifies natively and returns the verdict.
        return await broker.write(credential.deviceId, credential.deviceSecret);
      } catch {
        return false;
      }
    },

    clear: async (): Promise<void> => {
      const broker = loadBrokerModule();
      if (!broker) {
        return;
      }
      try {
        await broker.clear();
      } catch {
        // Best-effort — see the iOS store.
      }
    },
  };
}

/**
 * The shared DeviceSession credential slot for this runtime, or `null` when
 * there is none.
 *
 * The branch is on the PLATFORM, not on which module happens to load, because
 * `expo-secure-store` loads perfectly well on Android — it would just quietly
 * ignore `keychainAccessGroup` and read a package-private item, which looks
 * exactly like an empty shared slot. This is the same iOS-vs-Android split
 * `KeyManager` makes for the shared identity, for the same reason.
 *
 * Any other native platform gets the broker, which answers `unsupported` when
 * the module is not linked — so the lane is simply off, which is the safe
 * direction.
 */
export function createPlatformSharedDeviceCredentialStore(): SharedDeviceCredentialStore | null {
  if (Platform.OS === 'web') {
    return null;
  }
  return Platform.OS === 'ios' ? createKeychainGroupCredentialStore() : createBrokerCredentialStore();
}
