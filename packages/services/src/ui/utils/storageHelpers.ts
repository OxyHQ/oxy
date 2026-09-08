export interface StorageInterface {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
  removeItem: (key: string) => Promise<void>;
  clear: () => Promise<void>;
}

export interface SessionStorageKeys {
  activeSessionId: string;
  sessionIds: string;
  language: string;
}

/**
 * Create an in-memory storage implementation used as a safe fallback.
 */
export const createMemoryStorage = (): StorageInterface => {
  const store = new Map<string, string>();

  return {
    async getItem(key: string) {
      return store.get(key) ?? null;
    },
    async setItem(key: string, value: string) {
      store.set(key, value);
    },
    async removeItem(key: string) {
      store.delete(key);
    },
    async clear() {
      store.clear();
    },
  };
};

/**
 * Create a web storage implementation backed by `localStorage`.
 * Falls back to in-memory storage when unavailable.
 */
const createWebStorage = (): StorageInterface => {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
    return createMemoryStorage();
  }

  return {
    async getItem(key: string) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    async setItem(key: string, value: string) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Ignore quota or access issues for now.
      }
    },
    async removeItem(key: string) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Ignore failures.
      }
    },
    async clear() {
      try {
        window.localStorage.clear();
      } catch {
        // Ignore failures.
      }
    },
  };
};

let asyncStorageInstance: StorageInterface | null = null;

/**
 * Lazily import React Native AsyncStorage implementation.
 */
const createNativeStorage = async (): Promise<StorageInterface> => {
  if (asyncStorageInstance) {
    return asyncStorageInstance;
  }

  try {
    const asyncStorageModule = await import('@react-native-async-storage/async-storage');
    asyncStorageInstance = asyncStorageModule.default as unknown as StorageInterface;
    return asyncStorageInstance;
  } catch (error) {
    if (__DEV__) {
      console.error('Failed to import AsyncStorage:', error);
    }
    return createMemoryStorage();
  }
};

/**
 * Detect whether the current runtime is React Native.
 */
export const isReactNative = (): boolean =>
  typeof navigator !== 'undefined' && navigator.product === 'ReactNative';

/**
 * Create a platform-appropriate storage implementation.
 * Defaults to in-memory storage when no platform storage is available.
 */
export const createPlatformStorage = async (): Promise<StorageInterface> => {
  if (isReactNative()) {
    return createNativeStorage();
  }

  return createWebStorage();
};

export const STORAGE_KEY_PREFIX = 'oxy_session';

/**
 * Produce strongly typed storage key names for the supplied prefix.
 *
 * @param prefix - Storage key prefix
 */
export const getStorageKeys = (prefix: string = STORAGE_KEY_PREFIX): SessionStorageKeys => ({
  activeSessionId: `${prefix}_active_session_id`,
  sessionIds: `${prefix}_session_ids`,
  language: `${prefix}_language`,
});

