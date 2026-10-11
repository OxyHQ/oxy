/**
 * Shared in-memory mocks for KeyManager identity tests.
 *
 * The secure-store mock keys every entry by `(keychainService ?? 'default') + ' '
 * + key` so the v2 slot layout — which gives the primary and backup DISTINCT
 * keychain services — is faithfully modeled (a write under one service is
 * invisible to a read under another, exactly like Android's per-service
 * AndroidKeyStore keys).
 *
 * `__simulateKeystoreDeath__(service)` reproduces the SDK 57 Android failure mode
 * this whole hardening defends against: an undecryptable entry is DELETED on the
 * READ path and the read returns `null` (no throw). A subsequent write under that
 * service creates a fresh, readable entry (a new keystore key), so recovery can
 * re-persist afterwards.
 *
 * The AsyncStorage mock is a real in-memory map (the identity marker + the
 * advisory migration flag live here — independent of the keychain).
 */

type FailOp = 'set' | 'get';

export interface FailPlan {
  failKey?: string;
  failOp?: FailOp;
  failTimes?: number;
  /** Restrict the fault to one keychain service (`'default'` for unscoped keys). */
  failService?: string;
}

const compositeKey = (service: string | undefined, key: string): string =>
  `${service ?? 'default'} ${key}`;

export function createSecureStoreMock() {
  const store = new Map<string, string>(); // keyed by `${service} ${key}`
  const poisoned = new Set<string>(); // composite keys pending delete-on-read (keystore death)
  const failPlan: FailPlan = {};

  const maybeFail = (op: FailOp, key: string, service?: string): void => {
    if (
      failPlan.failOp === op &&
      failPlan.failKey === key &&
      (failPlan.failService === undefined || failPlan.failService === (service ?? 'default'))
    ) {
      if (failPlan.failTimes !== undefined) {
        failPlan.failTimes -= 1;
        if (failPlan.failTimes <= 0) {
          failPlan.failKey = undefined;
          failPlan.failOp = undefined;
          failPlan.failTimes = undefined;
          failPlan.failService = undefined;
        }
      }
      throw new Error(`Simulated ${op} failure for ${key}`);
    }
  };

  return {
    __esModule: true,
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
    WHEN_UNLOCKED: 'WHEN_UNLOCKED',
    setItemAsync: jest.fn(
      async (key: string, value: string, opts?: { keychainService?: string }) => {
        maybeFail('set', key, opts?.keychainService);
        const ck = compositeKey(opts?.keychainService, key);
        poisoned.delete(ck); // a fresh write mints a new (readable) keystore entry
        store.set(ck, value);
      },
    ),
    getItemAsync: jest.fn(async (key: string, opts?: { keychainService?: string }) => {
      maybeFail('get', key, opts?.keychainService);
      const ck = compositeKey(opts?.keychainService, key);
      if (poisoned.has(ck)) {
        // Android SDK 57: undecryptable ciphertext is DELETED on read → null.
        poisoned.delete(ck);
        store.delete(ck);
        return null;
      }
      return store.get(ck) ?? null;
    }),
    deleteItemAsync: jest.fn(async (key: string, opts?: { keychainService?: string }) => {
      const ck = compositeKey(opts?.keychainService, key);
      poisoned.delete(ck);
      store.delete(ck);
    }),
    __resetStore__: () => {
      store.clear();
      poisoned.clear();
      failPlan.failKey = undefined;
      failPlan.failOp = undefined;
      failPlan.failTimes = undefined;
      failPlan.failService = undefined;
    },
    __getStore__: () => store,
    __getRaw__: (key: string, service?: string): string | null =>
      store.get(compositeKey(service, key)) ?? null,
    __setRaw__: (key: string, value: string, service?: string): void => {
      store.set(compositeKey(service, key), value);
    },
    __deleteRaw__: (key: string, service?: string): void => {
      store.delete(compositeKey(service, key));
    },
    __simulateKeystoreDeath__: (service: string): void => {
      // Mark every existing entry under this service as undecryptable; the next
      // read of each deletes it and returns null.
      for (const ck of store.keys()) {
        if (ck.startsWith(`${service} `)) {
          poisoned.add(ck);
        }
      }
    },
    __failPlan__: failPlan,
  };
}

export function createAsyncStorageMock() {
  const map = new Map<string, string>();
  return {
    getItem: async (key: string): Promise<string | null> => map.get(key) ?? null,
    setItem: async (key: string, value: string): Promise<void> => {
      map.set(key, value);
    },
    removeItem: async (key: string): Promise<void> => {
      map.delete(key);
    },
    __map__: map,
    __reset__: (): void => map.clear(),
  };
}
