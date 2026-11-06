/**
 * The native secure key/value seam every durable `@oxy.so/core` store in this
 * package is built on.
 *
 * `@oxy.so/core` owns the store LOGIC (`createNativeAuthStateStore` for the
 * zero-cookie device credential, `createNativeIdentityPinStore` for the identity
 * pin) and takes its persistence as an injected `NativeKeyValueStorage`. This
 * module supplies that injection ONCE, so those stores can never drift onto
 * different backings — a device credential in SecureStore and a pin in
 * AsyncStorage would resolve differently after a keystore reset.
 *
 * `expo-secure-store` is a REQUIRED peer of this package (13.5.0): without its
 * native module the device credential would sit in plaintext AsyncStorage. It
 * is still loaded lazily, as a direct statement of a `try` block (the shape
 * Metro marks optional, `optionalPeerLoads.test.ts`), so a build whose native
 * module is missing (react-native-macos, an app that has not rebuilt) degrades
 * to AsyncStorage instead of crashing. The specifier is a LITERAL: the old
 * `const m = 'expo-secure-store'; import(m)` never hid it from Metro (Babel
 * evaluates the constant, so Metro resolved it anyway) and only hid it from the
 * gates that read this source.
 *
 * ## Whose item this is (iOS)
 *
 * Every key stored here is the SAME name in every Oxy app (`oxy.auth.v1`, the
 * warm token, the sign-out marker, the identity pin). On Android each app's
 * expo-secure-store is its own; on iOS an item written without an access group
 * lands in the app's default group, which for every app but Commons and the
 * Peable wallet is the shared one, so they all read and overwrote ONE session.
 * The items now live in the app's own group (`<prefix><bundle id>`,
 * `ownKeychainItemPlan`, ADR 0062 D6); the copy in the shared group is never
 * read as this app's (it may be another app's, or Commons' vault session) and
 * never deleted (apps still on an older build use it). The cross-app join point
 * is the dedicated device-session slot (`sharedDeviceCredentialStore.ts`), whose
 * credential every adopting app proves with a mint.
 */
import {
  type NativeKeyValueStorage,
  deleteThroughPlan,
  nativeSessionItemNames,
  ownKeychainItemPlan,
  readThroughPlan,
  resolveKeychainAccess,
} from '@oxy.so/core/session';
import { createPlatformStorage } from '../utils/storageHelpers';

interface SecureStoreLike {
  getItemAsync(key: string, options?: object): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: object): Promise<void>;
  deleteItemAsync(key: string, options?: object): Promise<void>;
}

/**
 * Where this app's own copy of `key` is on iOS (`ownKeychainItemPlan`,
 * docs/identity/ios-keychain-access-groups.md): the app's own group, then
 * Commons' or the wallet's default group where D3 put it. Android and web: no
 * options.
 */
async function ownItemPlan(key: string) {
  return ownKeychainItemPlan(await resolveKeychainAccess(), nativeSessionItemNames(key));
}

let secureStorePromise: Promise<SecureStoreLike | null> | null = null;

/**
 * Resolve the `expo-secure-store` module once (memoised), or `null` when it is
 * unavailable — callers then fall back to AsyncStorage. Never throws.
 */
async function importSecureStore(): Promise<SecureStoreLike | null> {
  let mod: Partial<SecureStoreLike>;
  try {
    mod = (await import('expo-secure-store')) as unknown as Partial<SecureStoreLike>;
  } catch {
    return null;
  }
  if (
    typeof mod.getItemAsync === 'function' &&
    typeof mod.setItemAsync === 'function' &&
    typeof mod.deleteItemAsync === 'function'
  ) {
    return {
      getItemAsync: mod.getItemAsync.bind(mod),
      setItemAsync: mod.setItemAsync.bind(mod),
      deleteItemAsync: mod.deleteItemAsync.bind(mod),
    } satisfies SecureStoreLike;
  }
  return null;
}

function loadSecureStore(): Promise<SecureStoreLike | null> {
  if (!secureStorePromise) {
    secureStorePromise = importSecureStore();
  }
  return secureStorePromise;
}

/**
 * A native `NativeKeyValueStorage` that prefers `expo-secure-store` (encrypted
 * at rest) and falls back to AsyncStorage when SecureStore is not installed.
 * The SecureStore module is resolved lazily on first access so construction
 * stays synchronous.
 */
export function createNativeSecureKeyValueStorage(): NativeKeyValueStorage {
  let asyncStorage: Awaited<ReturnType<typeof createPlatformStorage>> | null = null;
  const getAsyncStorage = async () => {
    if (!asyncStorage) {
      asyncStorage = await createPlatformStorage();
    }
    return asyncStorage;
  };
  return {
    getItem: async (key) => {
      const secure = await loadSecureStore();
      if (secure) {
        return readThroughPlan(secure, key, {}, (await ownItemPlan(key)).read);
      }
      return (await getAsyncStorage()).getItem(key);
    },
    setItem: async (key, value) => {
      const secure = await loadSecureStore();
      if (secure) {
        await secure.setItemAsync(key, value, (await ownItemPlan(key)).write);
        return;
      }
      await (await getAsyncStorage()).setItem(key, value);
    },
    removeItem: async (key) => {
      const secure = await loadSecureStore();
      if (secure) {
        await deleteThroughPlan(secure, key, {}, (await ownItemPlan(key)).delete);
        return;
      }
      await (await getAsyncStorage()).removeItem(key);
    },
  };
}
