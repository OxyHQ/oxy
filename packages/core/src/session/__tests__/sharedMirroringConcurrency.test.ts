import { createNativeAuthStateStore, type NativeKeyValueStorage } from '../authStateStore';
import {
  createSharedMirroringAuthStateStore,
  publishProvenDeviceCredential,
  type SharedDeviceCredential,
  type SharedDeviceCredentialStore,
} from '../sharedDeviceCredential';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function nativeStore() {
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
  return createNativeAuthStateStore(storage);
}

const first = { sessionId: 's-a', userId: 'a', deviceId: 'device-a', deviceSecret: 'holder-a' };
const second = { sessionId: 's-b', userId: 'b', deviceId: 'device-b', deviceSecret: 'holder-b' };

test('independent publishers still race on the shared slot', async () => {
  const bothRead = deferred();
  const firstPublished = deferred();
  let reads = 0;
  let slot: SharedDeviceCredential | null = null;
  const shared: SharedDeviceCredentialStore = {
    read: async () => {
      if (++reads === 2) bothRead.resolve();
      await bothRead.promise;
      return { state: 'absent' };
    },
    publish: async (credential) => {
      if (credential.deviceId === second.deviceId) await firstPublished.promise;
      slot = credential;
      if (credential.deviceId === first.deviceId) firstPublished.resolve();
      return true;
    },
    clear: async () => {},
  };
  const a = { deviceId: first.deviceId, deviceSecret: first.deviceSecret };
  const b = { deviceId: second.deviceId, deviceSecret: second.deviceSecret };
  expect(
    await Promise.all([
      publishProvenDeviceCredential({ shared, credential: a }),
      publishProvenDeviceCredential({ shared, credential: b }),
    ]),
  ).toEqual([{ status: 'published' }, { status: 'published' }]);
  expect(slot).toEqual(b);
});

test('an older pending save cannot publish after a newer local save', async () => {
  const local = nativeStore();
  const readStarted = deferred();
  const releaseRead = deferred();
  let slot: SharedDeviceCredential | null = null;
  let reads = 0;
  const publish = jest.fn(async (credential: SharedDeviceCredential) => {
    slot = credential;
    return true;
  });
  const shared: SharedDeviceCredentialStore = {
    read: async () => {
      if (++reads === 1) {
        readStarted.resolve();
        await releaseRead.promise;
      }
      return slot ? { state: 'present', credential: slot } : { state: 'absent' };
    },
    publish,
    clear: async () => {},
  };
  const store = createSharedMirroringAuthStateStore({ local, shared });
  const saveFirst = store.save(first);
  await readStarted.promise;
  const saveSecond = store.save(second);
  expect(await local.load()).toEqual(second);
  releaseRead.resolve();
  expect(await Promise.all([saveFirst, saveSecond])).toEqual([true, true]);
  expect(publish).toHaveBeenCalledTimes(1);
  expect(slot).toEqual({ deviceId: second.deviceId, deviceSecret: second.deviceSecret });
});

test('clear completes during a pending read and prevents its publication', async () => {
  const local = nativeStore();
  const started = deferred();
  const release = deferred();
  const publish = jest.fn(async () => true);
  const shared: SharedDeviceCredentialStore = {
    read: async () => {
      started.resolve();
      await release.promise;
      return { state: 'absent' };
    },
    publish,
    clear: async () => {},
  };
  const store = createSharedMirroringAuthStateStore({ local, shared });
  const save = store.save(first);
  await started.promise;
  await store.clear();
  expect(await local.load()).toBeNull();
  release.resolve();
  await save;
  expect(publish).not.toHaveBeenCalled();
});

test('clear completes while an already-started publication remains suspended', async () => {
  const local = nativeStore();
  const started = deferred();
  const release = deferred();
  let slot: SharedDeviceCredential | null = null;
  const shared: SharedDeviceCredentialStore = {
    read: async () => ({ state: 'absent' }),
    publish: async (credential) => {
      started.resolve();
      await release.promise;
      slot = credential;
      return true;
    },
    clear: async () => {},
  };
  const store = createSharedMirroringAuthStateStore({ local, shared });
  const save = store.save(first);
  await started.promise;
  await store.clear();
  expect(await local.load()).toBeNull();
  expect(slot).toBeNull();
  release.resolve();
  await save;
  expect(slot).toEqual({ deviceId: first.deviceId, deviceSecret: first.deviceSecret });
  expect(await local.load()).toBeNull();
});

test('a guarded save rechecks its guard after the shared read', async () => {
  const local = nativeStore();
  const started = deferred();
  const release = deferred();
  const publish = jest.fn(async () => true);
  const shared: SharedDeviceCredentialStore = {
    read: async () => {
      started.resolve();
      await release.promise;
      return { state: 'absent' };
    },
    publish,
    clear: async () => {},
  };
  const store = createSharedMirroringAuthStateStore({ local, shared });
  let current = true;
  const save = store.saveIfCurrent?.(first, { expectedState: null, isCurrent: () => current });
  await started.promise;
  current = false;
  release.resolve();
  expect(await save).toBe(true);
  expect(publish).not.toHaveBeenCalled();
});

test('reentrant clear from the shared reader does not deadlock or publish', async () => {
  const local = nativeStore();
  const publish = jest.fn(async () => true);
  let store: ReturnType<typeof createSharedMirroringAuthStateStore>;
  const shared: SharedDeviceCredentialStore = {
    read: async () => {
      await store.clear();
      return { state: 'absent' };
    },
    publish,
    clear: async () => {},
  };
  store = createSharedMirroringAuthStateStore({ local, shared });
  expect(await store.save(first)).toBe(true);
  expect(await local.load()).toBeNull();
  expect(publish).not.toHaveBeenCalled();
});

test('a failed guarded save leaves the earlier proven credential eligible', async () => {
  const local = nativeStore();
  const started = deferred();
  const release = deferred();
  const publish = jest.fn(async () => true);
  const shared: SharedDeviceCredentialStore = {
    read: async () => {
      started.resolve();
      await release.promise;
      return { state: 'absent' };
    },
    publish,
    clear: async () => {},
  };
  const store = createSharedMirroringAuthStateStore({ local, shared });
  const save = store.save(first);
  await started.promise;
  expect(
    await store.saveIfCurrent?.(second, { expectedState: first, isCurrent: () => false }),
  ).toBe(false);
  release.resolve();
  await save;
  expect(publish).toHaveBeenCalledWith({
    deviceId: first.deviceId,
    deviceSecret: first.deviceSecret,
  });
});

test('a new login can persist locally while its save waits for an earlier blocked publish', async () => {
  const local = nativeStore();
  const started = deferred();
  const release = deferred();
  const shared: SharedDeviceCredentialStore = {
    read: async () => ({ state: 'absent' }),
    publish: async () => {
      started.resolve();
      await release.promise;
      return true;
    },
    clear: async () => {},
  };
  const store = createSharedMirroringAuthStateStore({ local, shared });
  const oldSave = store.save(first);
  await started.promise;
  await store.clear();
  const newSave = store.save(second);
  expect(await local.load()).toEqual(second);
  expect(
    await Promise.race([
      newSave.then(() => 'completed'),
      new Promise<string>((resolve) => setImmediate(() => resolve('pending'))),
    ]),
  ).toBe('pending');
  release.resolve();
  expect(await Promise.all([oldSave, newSave])).toEqual([true, true]);
});
