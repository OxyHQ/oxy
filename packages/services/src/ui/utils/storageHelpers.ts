import { deviceStorage } from '../data/deviceStorage';

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
 * Detect whether the current runtime is React Native.
 */
export const isReactNative = (): boolean =>
  typeof navigator !== 'undefined' && navigator.product === 'ReactNative';

/**
 * The SDK's key-value storage: the device's `@oxy.so/bloom-data` store
 * (`data/deviceStorage.ts`), which moves each key off AsyncStorage (or
 * localStorage) the first time it is read.
 */
export const createPlatformStorage = async (): Promise<StorageInterface> => deviceStorage();

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
