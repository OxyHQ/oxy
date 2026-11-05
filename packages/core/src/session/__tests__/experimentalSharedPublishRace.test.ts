import { publishProvenDeviceCredential, type SharedDeviceCredential, type SharedDeviceCredentialStore } from '../sharedDeviceCredential';
import { createSharedMirroringAuthStateStore } from '../sharedDeviceCredential';
import { createNativeAuthStateStore, type NativeKeyValueStorage } from '../authStateStore';

it('baseline: two publishers can both observe an empty shared slot and replace one another', async () => {
  const alice = { deviceId: 'device-a', deviceSecret: 'holder-a' };
  const nate = { deviceId: 'device-b', deviceSecret: 'holder-b' };
  let sharedValue: SharedDeviceCredential | null = null;
  let reads = 0;
  let releaseReads!: () => void;
  const bothRead = new Promise<void>((resolve) => { releaseReads = resolve; });
  let firstDone!: () => void;
  const firstPublished = new Promise<void>((resolve) => { firstDone = resolve; });
  const shared: SharedDeviceCredentialStore = {
    read: async () => { reads++; if (reads === 2) releaseReads(); await bothRead; return { state: 'absent' }; },
    publish: async (credential) => {
      if (credential.deviceId === nate.deviceId) await firstPublished;
      sharedValue = credential;
      if (credential.deviceId === alice.deviceId) firstDone();
      return true;
    },
    clear: async () => {},
  };
  const results = await Promise.all([
    publishProvenDeviceCredential({ shared, credential: alice }),
    publishProvenDeviceCredential({ shared, credential: nate }),
  ]);
  expect(results).toEqual([{ status: 'published' }, { status: 'published' }]);
  expect(sharedValue).toEqual(nate);
});

it('baseline: two saves from one native wrapper can leave its shared slot on the older device', async () => {
  const values = new Map<string, string>();
  const storage: NativeKeyValueStorage = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async (key) => { values.delete(key); },
  };
  let sharedValue: SharedDeviceCredential | null = null;
  let reads = 0;
  let releaseReads!: () => void;
  const bothRead = new Promise<void>((resolve) => { releaseReads = resolve; });
  let secondDone!: () => void;
  const secondPublished = new Promise<void>((resolve) => { secondDone = resolve; });
  const shared: SharedDeviceCredentialStore = {
    read: async () => { reads++; if (reads === 2) releaseReads(); await bothRead; return { state: 'absent' }; },
    publish: async (credential) => {
      if (credential.deviceId === 'device-a') await secondPublished;
      sharedValue = credential;
      if (credential.deviceId === 'device-b') secondDone();
      return true;
    },
    clear: async () => {},
  };
  const local = createNativeAuthStateStore(storage);
  const store = createSharedMirroringAuthStateStore({ local, shared });
  const first = { sessionId: 'session-a', userId: 'alice', deviceId: 'device-a', deviceSecret: 'holder-a' };
  const second = { sessionId: 'session-b', userId: 'nate', deviceId: 'device-b', deviceSecret: 'holder-b' };
  expect(await Promise.all([store.save(first), store.save(second)])).toEqual([true, true]);
  expect(await local.load()).toEqual(second);
  expect(sharedValue).toEqual({ deviceId: 'device-a', deviceSecret: 'holder-a' });
});
