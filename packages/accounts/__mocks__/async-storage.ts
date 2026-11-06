/**
 * In-memory AsyncStorage stub. Tests that depend on persisted-locale behaviour
 * write directly to the store before mounting; everything else gets a clean
 * slate via `__resetAsyncStorage()` in beforeEach.
 */

const store = new Map<string, string>();

const AsyncStorage = {
  getItem: jest.fn(async (key: string): Promise<string | null> => store.get(key) ?? null),
  setItem: jest.fn(async (key: string, value: string): Promise<void> => {
    store.set(key, value);
  }),
  removeItem: jest.fn(async (key: string): Promise<void> => {
    store.delete(key);
  }),
  clear: jest.fn(async (): Promise<void> => {
    store.clear();
  }),
  getAllKeys: jest.fn(async (): Promise<string[]> => Array.from(store.keys())),
};

/** Helper for tests that need to seed AsyncStorage before mount. */
export function __seedAsyncStorage(key: string, value: string): void {
  store.set(key, value);
}

/** Reset the in-memory store between tests. */
export function __resetAsyncStorage(): void {
  store.clear();
}

export default AsyncStorage;
