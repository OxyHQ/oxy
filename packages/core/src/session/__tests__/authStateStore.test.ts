import {
  createWebAuthStateStore,
  createNativeAuthStateStore,
  createMemoryAuthStateStore,
  AUTH_STATE_STORAGE_KEY,
  AUTH_STATE_TOKEN_STORAGE_KEY,
  type PersistedAuthState,
  type NativeKeyValueStorage,
} from '../authStateStore';

/**
 * The zero-cookie persisted shape: `sessionId` + `userId` are the only required
 * fields; `deviceId` / `deviceSecret` (the mint credential) and
 * `accessToken` / `expiresAt` (warm-boot) are all optional round-trip fields.
 */
const SAMPLE: PersistedAuthState = {
  sessionId: 's-1',
  userId: 'u-1',
  accessToken: 'a-jwt',
  expiresAt: '2030-01-01T00:00:00.000Z',
};

/** A minimal in-map Storage; setItem can be made to throw (quota simulation). */
function makeFakeStorage(opts: { throwOnSet?: boolean } = {}): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      if (opts.throwOnSet) {
        throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      }
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

function installLocalStorage(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  // Remove whatever localStorage the test installed (value or throwing getter).
  if (Object.getOwnPropertyDescriptor(globalThis, 'localStorage')) {
    Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

describe('createWebAuthStateStore', () => {
  it('round-trips a PersistedAuthState under the versioned key', async () => {
    const storage = makeFakeStorage();
    installLocalStorage(storage);
    const store = createWebAuthStateStore();

    await store.save(SAMPLE);
    expect(storage.getItem(AUTH_STATE_STORAGE_KEY)).toBeTruthy();
    expect(await store.load()).toEqual(SAMPLE);
  });

  it('round-trips the optional deviceId + deviceSecret mint credential', async () => {
    installLocalStorage(makeFakeStorage());
    const store = createWebAuthStateStore();
    const withCreds: PersistedAuthState = { ...SAMPLE, deviceId: 'dev-abc', deviceSecret: 'ds-secret-xyz' };

    await store.save(withCreds);
    const loaded = await store.load();
    expect(loaded?.deviceId).toBe('dev-abc');
    expect(loaded?.deviceSecret).toBe('ds-secret-xyz');
    expect(loaded).toEqual(withCreds);
  });

  it('deserializes a minimal blob with no device credentials (fields absent)', async () => {
    const storage = makeFakeStorage();
    installLocalStorage(storage);
    const store = createWebAuthStateStore();

    storage.setItem(AUTH_STATE_STORAGE_KEY, JSON.stringify({ sessionId: 's-1', userId: 'u-1' }));
    const loaded = await store.load();
    expect(loaded).toEqual({ sessionId: 's-1', userId: 'u-1' });
    expect(loaded && 'deviceId' in loaded).toBe(false);
    expect(loaded && 'deviceSecret' in loaded).toBe(false);
    expect(loaded && 'accessToken' in loaded).toBe(false);
  });

  it('clear() wipes the persisted session', async () => {
    installLocalStorage(makeFakeStorage());
    const store = createWebAuthStateStore();

    await store.save({ ...SAMPLE, deviceId: 'dev-abc', deviceSecret: 'ds-secret-xyz' });
    await store.clear();

    expect(await store.load()).toBeNull();
  });

  it('returns null for malformed JSON or a blob missing a required field', async () => {
    const storage = makeFakeStorage();
    installLocalStorage(storage);
    const store = createWebAuthStateStore();

    storage.setItem(AUTH_STATE_STORAGE_KEY, 'not-json');
    expect(await store.load()).toBeNull();

    // Missing userId → invalid.
    storage.setItem(AUTH_STATE_STORAGE_KEY, JSON.stringify({ sessionId: 's' }));
    expect(await store.load()).toBeNull();

    // Missing sessionId → invalid.
    storage.setItem(AUTH_STATE_STORAGE_KEY, JSON.stringify({ userId: 'u' }));
    expect(await store.load()).toBeNull();

    // Empty required strings → invalid.
    storage.setItem(AUTH_STATE_STORAGE_KEY, JSON.stringify({ sessionId: '', userId: '' }));
    expect(await store.load()).toBeNull();
  });

  it('degrades to in-memory when accessing localStorage throws (sandboxed iframe SecurityError)', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });

    // Construction must not throw, and the store must still function (in-memory).
    const store = createWebAuthStateStore();
    // A degraded in-memory store IS its own durability backing → reports `true`.
    await expect(store.save(SAMPLE)).resolves.toBe(true);
    expect(await store.load()).toEqual(SAMPLE);
  });

  it('swallows a write that throws (quota / private mode) without rejecting, and the mirror keeps the session live', async () => {
    installLocalStorage(makeFakeStorage({ throwOnSet: true }));
    const store = createWebAuthStateStore();
    const withCreds: PersistedAuthState = { ...SAMPLE, deviceId: 'dev-abc', deviceSecret: 'ds-secret-xyz' };

    // The durable write threw → the store reports the persist did NOT land.
    await expect(store.save(withCreds)).resolves.toBe(false);
    // The write never reached storage...
    expect(localStorage.getItem(AUTH_STATE_STORAGE_KEY)).toBeNull();
    // ...but the in-memory mirror keeps the session (incl. the mint credential) live.
    expect(await store.load()).toEqual(withCreds);
  });

  it('reports false when the durable write SILENTLY no-ops (read-back mismatch, no throw)', async () => {
    // A backing store whose setItem neither throws nor persists — the exact
    // failure the read-back guards. The mirror keeps the session live, but the
    // credential did not land, so save() must report false.
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        // Only the WARM key writes; the durable credential silently vanishes.
        if (k === AUTH_STATE_TOKEN_STORAGE_KEY) map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      clear: () => map.clear(),
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      get length() {
        return map.size;
      },
    } as Storage;
    installLocalStorage(storage);
    const store = createWebAuthStateStore();

    await expect(
      store.save({ ...SAMPLE, deviceId: 'dev-x', deviceSecret: 'ds-x' }),
    ).resolves.toBe(false);
    // The durable blob never landed…
    expect(storage.getItem(AUTH_STATE_STORAGE_KEY)).toBeNull();
    // …but the mirror still serves the session for this page's lifetime.
    expect(await store.load()).toMatchObject({ deviceId: 'dev-x', deviceSecret: 'ds-x' });
  });

  it('a cleared session reads null even if storage later holds a stale blob (mirror wins)', async () => {
    const storage = makeFakeStorage();
    installLocalStorage(storage);
    const store = createWebAuthStateStore();

    await store.save(SAMPLE);
    await store.clear();
    // Something (another tab / a failed remove) leaves a stale blob behind.
    storage.setItem(AUTH_STATE_STORAGE_KEY, JSON.stringify(SAMPLE));
    // The authoritative in-memory mirror still reports the cleared state.
    expect(await store.load()).toBeNull();
  });

  it('splits the token into the warm key and keeps the durable blob token-free', async () => {
    const storage = makeFakeStorage();
    installLocalStorage(storage);
    const store = createWebAuthStateStore();

    await store.save({ ...SAMPLE, deviceId: 'dev-1', deviceSecret: 'ds-1' });

    // Durable key holds ONLY the small mint-critical fields — never the JWT.
    const durableRaw = storage.getItem(AUTH_STATE_STORAGE_KEY);
    expect(durableRaw).toBeTruthy();
    expect(JSON.parse(durableRaw ?? '{}')).toEqual({
      sessionId: 's-1',
      userId: 'u-1',
      deviceId: 'dev-1',
      deviceSecret: 'ds-1',
    });

    // Warm key holds ONLY the short-lived token pair.
    const warmRaw = storage.getItem(AUTH_STATE_TOKEN_STORAGE_KEY);
    expect(warmRaw).toBeTruthy();
    expect(JSON.parse(warmRaw ?? '{}')).toEqual({
      accessToken: 'a-jwt',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });

    // A FRESH store (empty mirror) composes both keys back into the same shape.
    expect(await createWebAuthStateStore().load()).toEqual({
      ...SAMPLE,
      deviceId: 'dev-1',
      deviceSecret: 'ds-1',
    });
  });

  it('persists the durable credential even when the warm-token write fails', async () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        // Simulate the warm token exceeding the store's capacity while the small
        // durable blob writes fine.
        if (k === AUTH_STATE_TOKEN_STORAGE_KEY) {
          throw new DOMException('QuotaExceededError', 'QuotaExceededError');
        }
        map.set(k, v);
      },
      removeItem: (k: string) => {
        map.delete(k);
      },
      clear: () => map.clear(),
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      get length() {
        return map.size;
      },
    } as Storage;
    installLocalStorage(storage);
    const store = createWebAuthStateStore();

    await expect(
      store.save({ ...SAMPLE, deviceId: 'dev-abc', deviceSecret: 'ds-secret-xyz' }),
    ).resolves.toBe(true);

    // The durable mint credential landed despite the warm-token write throwing.
    const durableRaw = storage.getItem(AUTH_STATE_STORAGE_KEY);
    expect(durableRaw).toBeTruthy();
    const durable = JSON.parse(durableRaw ?? '{}');
    expect(durable.deviceId).toBe('dev-abc');
    expect(durable.deviceSecret).toBe('ds-secret-xyz');
    expect(durable.accessToken).toBeUndefined();
    // The warm-token key never persisted.
    expect(storage.getItem(AUTH_STATE_TOKEN_STORAGE_KEY)).toBeNull();

    // A fresh store restores the mint credential from disk; no warm token survives.
    const loaded = await createWebAuthStateStore().load();
    expect(loaded?.deviceId).toBe('dev-abc');
    expect(loaded?.deviceSecret).toBe('ds-secret-xyz');
    expect(loaded?.accessToken).toBeUndefined();
  });

  it('load() reads an old combined oxy.auth.v1 blob (pre-split back-compat)', async () => {
    const storage = makeFakeStorage();
    installLocalStorage(storage);
    // A user upgraded from the pre-split build: the WHOLE state (incl. the token)
    // lives in the single durable key; the warm key does not exist yet.
    storage.setItem(
      AUTH_STATE_STORAGE_KEY,
      JSON.stringify({ ...SAMPLE, deviceId: 'dev-old', deviceSecret: 'ds-old' }),
    );
    expect(storage.getItem(AUTH_STATE_TOKEN_STORAGE_KEY)).toBeNull();

    const store = createWebAuthStateStore();
    const loaded = await store.load();
    // The token is read back from the combined blob (no one is logged out).
    expect(loaded).toEqual({ ...SAMPLE, deviceId: 'dev-old', deviceSecret: 'ds-old' });
    expect(loaded?.accessToken).toBe('a-jwt');
    expect(loaded?.expiresAt).toBe('2030-01-01T00:00:00.000Z');
  });
});

describe('createNativeAuthStateStore', () => {
  function makeNativeStorage(): NativeKeyValueStorage & { map: Map<string, string> } {
    const map = new Map<string, string>();
    return {
      map,
      getItem: async (k) => (map.has(k) ? (map.get(k) as string) : null),
      setItem: async (k, v) => {
        map.set(k, v);
      },
      removeItem: async (k) => {
        map.delete(k);
      },
    };
  }

  it('round-trips through the injected async storage', async () => {
    const storage = makeNativeStorage();
    const store = createNativeAuthStateStore(storage);

    await store.save(SAMPLE);
    expect(storage.map.get(AUTH_STATE_STORAGE_KEY)).toBeTruthy();
    expect(await store.load()).toEqual(SAMPLE);
  });

  it('clear() wipes the persisted session', async () => {
    const store = createNativeAuthStateStore(makeNativeStorage());
    await store.save({ ...SAMPLE, deviceId: 'dev-1', deviceSecret: 'ds-1' });
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it('keeps the session live via the mirror when the injected storage throws (locked keychain)', async () => {
    const store = createNativeAuthStateStore({
      getItem: async () => {
        throw new Error('secure store locked');
      },
      setItem: async () => {
        throw new Error('secure store locked');
      },
      removeItem: async () => {
        throw new Error('secure store locked');
      },
    });
    // The durable write threw → reports the persist did NOT land…
    await expect(store.save(SAMPLE)).resolves.toBe(false);
    // …but the in-memory mirror preserves the session for this app run.
    expect(await store.load()).toEqual(SAMPLE);
  });

  it('reports false when the durable SecureStore write SILENTLY no-ops (oversize value, no throw)', async () => {
    // Android SecureStore can resolve a write WITHOUT throwing yet not persist an
    // oversize value — the read-back is the only reliable proof. save() must
    // report false so a rotating-secret lane refuses to plant on it.
    const map = new Map<string, string>();
    const storage: NativeKeyValueStorage = {
      getItem: async (k) => map.get(k) ?? null,
      setItem: async (k, v) => {
        if (k === AUTH_STATE_TOKEN_STORAGE_KEY) map.set(k, v); // durable silently dropped
      },
      removeItem: async (k) => {
        map.delete(k);
      },
    };
    const store = createNativeAuthStateStore(storage);

    await expect(
      store.save({ ...SAMPLE, deviceId: 'dev-x', deviceSecret: 'ds-x' }),
    ).resolves.toBe(false);
    expect(map.get(AUTH_STATE_STORAGE_KEY)).toBeUndefined();
    expect(await store.load()).toMatchObject({ deviceId: 'dev-x', deviceSecret: 'ds-x' });
  });

  it('persists the durable credential even when the warm-token write fails (oversize SecureStore value)', async () => {
    const map = new Map<string, string>();
    const storage: NativeKeyValueStorage = {
      getItem: async (k) => map.get(k) ?? null,
      // The large JWT exceeds the SecureStore value limit; the small durable blob
      // writes fine.
      setItem: async (k, v) => {
        if (k === AUTH_STATE_TOKEN_STORAGE_KEY) {
          throw new Error('Value too large for SecureStore');
        }
        map.set(k, v);
      },
      removeItem: async (k) => {
        map.delete(k);
      },
    };
    const store = createNativeAuthStateStore(storage);

    await expect(
      store.save({ ...SAMPLE, deviceId: 'dev-n', deviceSecret: 'ds-n' }),
    ).resolves.toBe(true);

    // The durable mint credential landed to disk.
    expect(map.get(AUTH_STATE_STORAGE_KEY)).toBeTruthy();
    const durable = JSON.parse(map.get(AUTH_STATE_STORAGE_KEY) ?? '{}');
    expect(durable.deviceId).toBe('dev-n');
    expect(durable.deviceSecret).toBe('ds-n');
    expect(durable.accessToken).toBeUndefined();
    expect(map.get(AUTH_STATE_TOKEN_STORAGE_KEY)).toBeUndefined();

    // A FRESH store (empty mirror) restores the mint credential from disk.
    const loaded = await createNativeAuthStateStore(storage).load();
    expect(loaded?.deviceId).toBe('dev-n');
    expect(loaded?.deviceSecret).toBe('ds-n');
    expect(loaded?.accessToken).toBeUndefined();
  });

  it('load() reads an old combined blob (pre-split back-compat)', async () => {
    const map = new Map<string, string>();
    const storage: NativeKeyValueStorage = {
      getItem: async (k) => map.get(k) ?? null,
      setItem: async (k, v) => {
        map.set(k, v);
      },
      removeItem: async (k) => {
        map.delete(k);
      },
    };
    // Pre-split combined blob in the single durable key; no warm key.
    map.set(
      AUTH_STATE_STORAGE_KEY,
      JSON.stringify({ ...SAMPLE, deviceId: 'dev-old', deviceSecret: 'ds-old' }),
    );

    const store = createNativeAuthStateStore(storage);
    expect(await store.load()).toEqual({ ...SAMPLE, deviceId: 'dev-old', deviceSecret: 'ds-old' });
  });

  it('clear() wipes BOTH the durable and warm keys', async () => {
    const storage = makeNativeStorage();
    const store = createNativeAuthStateStore(storage);
    await store.save({ ...SAMPLE, deviceId: 'dev-1', deviceSecret: 'ds-1' });
    // Both keys were written by the split save.
    expect(storage.map.get(AUTH_STATE_STORAGE_KEY)).toBeTruthy();
    expect(storage.map.get(AUTH_STATE_TOKEN_STORAGE_KEY)).toBeTruthy();

    await store.clear();
    expect(storage.map.get(AUTH_STATE_STORAGE_KEY)).toBeUndefined();
    expect(storage.map.get(AUTH_STATE_TOKEN_STORAGE_KEY)).toBeUndefined();
    expect(await store.load()).toBeNull();
  });
});

describe('createMemoryAuthStateStore', () => {
  it('round-trips and clears in process memory', async () => {
    const store = createMemoryAuthStateStore();
    await store.save(SAMPLE);
    expect(await store.load()).toEqual(SAMPLE);
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});
