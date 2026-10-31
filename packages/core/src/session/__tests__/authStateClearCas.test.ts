import {
  AUTH_STATE_STORAGE_KEY,
  AUTH_STATE_TOKEN_STORAGE_KEY,
  createNativeAuthStateStore,
  type NativeKeyValueStorage,
  type PersistedAuthState,
} from '../authStateStore';

const oldState: PersistedAuthState = {
  deviceId: 'device',
  deviceSecret: 'old-holder',
  userId: 'alice',
  sessionId: 'old-session',
  accessToken: 'old-token',
};
const newState: PersistedAuthState = {
  deviceId: 'device',
  deviceSecret: 'new-holder',
  userId: 'nate',
  sessionId: 'new-session',
  accessToken: 'new-token',
};

function memoryStorage() {
  const values = new Map<string, string>();
  const storage: NativeKeyValueStorage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
  return { values, storage };
}

it('does not expose per-instance clear from the default native store', () => {
  const { storage } = memoryStorage();
  expect(createNativeAuthStateStore(storage).clearIfCurrent).toBeUndefined();
});

it('clears the exact holder and verifies the durable and warm keys', async () => {
  const { values, storage } = memoryStorage();
  const store = createNativeAuthStateStore(storage, { experimentalPerInstanceClear: true });
  await store.save(oldState);
  expect(await store.clearIfCurrent?.({ expectedState: oldState, isCurrent: () => true })).toEqual({
    status: 'cleared',
    stillCurrent: true,
  });
  expect(await store.load()).toBeNull();
  expect(values.has(AUTH_STATE_STORAGE_KEY)).toBe(false);
  expect(values.has(AUTH_STATE_TOKEN_STORAGE_KEY)).toBe(false);
});

it('does not delete a replaced holder or an ABA lifecycle', async () => {
  const { storage } = memoryStorage();
  const store = createNativeAuthStateStore(storage, { experimentalPerInstanceClear: true });
  await store.save(newState);
  expect(await store.clearIfCurrent?.({ expectedState: oldState, isCurrent: () => true })).toEqual({
    status: 'superseded',
  });
  await store.save(oldState);
  expect(await store.clearIfCurrent?.({ expectedState: oldState, isCurrent: () => false })).toEqual(
    { status: 'superseded' },
  );
  expect(await store.load()).toEqual(oldState);
});

it('checks the lifecycle after delayed native reads and before removing either key', async () => {
  const { values, storage } = memoryStorage();
  const first = createNativeAuthStateStore(storage, { experimentalPerInstanceClear: true });
  await first.save(oldState);
  let unblock!: () => void;
  let observed!: () => void;
  const started = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const delayed: NativeKeyValueStorage = {
    ...storage,
    getItem: async (key) => {
      if (key === AUTH_STATE_STORAGE_KEY) {
        observed();
        await wait;
      }
      return storage.getItem(key);
    },
  };
  const store = createNativeAuthStateStore(delayed, { experimentalPerInstanceClear: true });
  let current = true;
  const pending = store.clearIfCurrent?.({ expectedState: oldState, isCurrent: () => current });
  await started;
  current = false;
  unblock();
  expect(await pending).toEqual({ status: 'superseded' });
  expect(values.has(AUTH_STATE_STORAGE_KEY)).toBe(true);
  expect(values.has(AUTH_STATE_TOKEN_STORAGE_KEY)).toBe(true);
});

it('serializes a new sign-in behind a deletion already in flight', async () => {
  const { values, storage } = memoryStorage();
  let unblock!: () => void;
  let observed!: () => void;
  const started = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let delay = false;
  const delayed: NativeKeyValueStorage = {
    ...storage,
    removeItem: async (key) => {
      if (delay && key === AUTH_STATE_STORAGE_KEY) {
        observed();
        await wait;
      }
      await storage.removeItem(key);
    },
  };
  const store = createNativeAuthStateStore(delayed, { experimentalPerInstanceClear: true });
  await store.save(oldState);
  let current = true;
  delay = true;
  const pending = store.clearIfCurrent?.({ expectedState: oldState, isCurrent: () => current });
  await started;
  current = false;
  const save = store.save(newState);
  unblock();
  expect(await pending).toEqual({ status: 'cleared', stillCurrent: false });
  expect(await save).toBe(true);
  expect(await store.load()).toEqual(newState);
  expect(JSON.parse(values.get(AUTH_STATE_STORAGE_KEY) ?? '{}').deviceSecret).toBe('new-holder');
  expect(JSON.parse(values.get(AUTH_STATE_TOKEN_STORAGE_KEY) ?? '{}').accessToken).toBe(
    'new-token',
  );
});

it('keeps a synchronously reentered save queued after the old clear', async () => {
  const { storage } = memoryStorage();
  const store = createNativeAuthStateStore(storage, { experimentalPerInstanceClear: true });
  await store.save(oldState);
  let save: Promise<boolean> | undefined;
  let current = true;
  const result = await store.clearIfCurrent?.({
    expectedState: oldState,
    isCurrent: () => {
      if (!save) {
        save = store.save(newState);
        current = false;
        return true;
      }
      return current;
    },
  });
  expect(result).toEqual({ status: 'cleared', stillCurrent: false });
  expect(await save).toBe(true);
  expect(await store.load()).toEqual(newState);
});

it('reports unverified silent removal as a storage failure', async () => {
  const { values, storage } = memoryStorage();
  const store = createNativeAuthStateStore(
    { ...storage, removeItem: async () => {} },
    { experimentalPerInstanceClear: true },
  );
  await store.save(oldState);
  expect(await store.clearIfCurrent?.({ expectedState: oldState, isCurrent: () => true })).toEqual({
    status: 'storage_error',
  });
  expect(values.has(AUTH_STATE_STORAGE_KEY)).toBe(true);
});

it('baseline: a second store instance is outside the first instance queue', async () => {
  const { values, storage } = memoryStorage();
  let unblock!: () => void;
  let observed!: () => void;
  const started = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let delay = false;
  const delayed: NativeKeyValueStorage = {
    ...storage,
    removeItem: async (key) => {
      if (delay && key === AUTH_STATE_STORAGE_KEY) {
        observed();
        await wait;
      }
      await storage.removeItem(key);
    },
  };
  const first = createNativeAuthStateStore(delayed, { experimentalPerInstanceClear: true });
  const second = createNativeAuthStateStore(storage, { experimentalPerInstanceClear: true });
  await first.save(oldState);
  delay = true;
  const pending = first.clearIfCurrent?.({ expectedState: oldState, isCurrent: () => true });
  await started;
  expect(await second.save(newState)).toBe(true);
  unblock();
  expect(await pending).toEqual({ status: 'cleared', stillCurrent: true });
  expect(values.has(AUTH_STATE_STORAGE_KEY)).toBe(false);
});
