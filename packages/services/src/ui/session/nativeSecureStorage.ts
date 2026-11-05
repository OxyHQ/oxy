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
 */
import type { NativeKeyValueStorage } from '@oxy.so/core/session';
import { createPlatformStorage } from '../utils/storageHelpers';

interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
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
        return secure.getItemAsync(key);
      }
      return (await getAsyncStorage()).getItem(key);
    },
    setItem: async (key, value) => {
      const secure = await loadSecureStore();
      if (secure) {
        await secure.setItemAsync(key, value);
        return;
      }
      await (await getAsyncStorage()).setItem(key, value);
    },
    removeItem: async (key) => {
      const secure = await loadSecureStore();
      if (secure) {
        await secure.deleteItemAsync(key);
        return;
      }
      await (await getAsyncStorage()).removeItem(key);
    },
  };
}
