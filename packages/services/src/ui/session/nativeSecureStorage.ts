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
 * `expo-secure-store` is loaded via a runtime-computed dynamic import (the same
 * optional-native-module pattern `OxyProvider` uses for netinfo / keyboard
 * controller), so the web bundle never pulls it and a device without it falls
 * back to AsyncStorage rather than crashing.
 */
import type { NativeKeyValueStorage } from '@oxy.so/core';
import { createPlatformStorage } from '../utils/storageHelpers';

// Variable indirection so Metro's static analyzer never traces expo-secure-store
// into the web bundle; the module is native-only and optional.
const SECURE_STORE_MODULE = 'expo-secure-store';

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
function loadSecureStore(): Promise<SecureStoreLike | null> {
  if (!secureStorePromise) {
    const moduleName = SECURE_STORE_MODULE;
    secureStorePromise = import(moduleName)
      .then((mod: Partial<SecureStoreLike>) => {
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
      })
      .catch(() => null);
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
