import type { DeviceSessionState, DeviceTokenMintResponse } from '@oxy.so/contracts';
import { OxyServices } from '../../OxyServices';
import { SessionClient } from '../SessionClient';
import { createSessionClientHost } from '../sessionClientHost';
import { createNativeAuthStateStore, type NativeKeyValueStorage, type PersistedAuthState } from '../authStateStore';
import { refreshDeviceSecretArm } from '../refresh';

function jwt(userId: string, sessionId: string, nonce = 0): string {
  return `e30.${Buffer.from(JSON.stringify({userId, sessionId, nonce, exp: Math.floor(Date.now() / 1000) + 3600})).toString('base64url')}.s`;
}
const tokenA = jwt('person-a', 'session-a');
const tokenB = jwt('org-b', 'session-b');
const holder = {deviceId: 'same-device', deviceSecret: 'same-holder'};
const state = (activeAccountId: string, revision: number): DeviceSessionState => ({
  deviceId: holder.deviceId, activeAccountId, revision, updatedAt: Date.now(),
  accounts: [{accountId: 'person-a', sessionId: 'session-a', authuser: 0}, {accountId: 'org-b', sessionId: 'session-b', authuser: 0}],
});
const prior: PersistedAuthState = {...holder, sessionId: 'session-a', userId: 'person-a', accessToken: tokenA, expiresAt: new Date(Date.now() + 3600000).toISOString()};
const response: DeviceTokenMintResponse = {accessToken: jwt('person-a', 'session-a', 1), expiresAt: prior.expiresAt!, nextDeviceSecret: 'rotated-holder-a', state: state('person-a', 1)};
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve}; }
const clients: OxyServices[] = [];
const sessions: SessionClient[] = [];
function fixture() {
  const values = new Map<string, string>();
  const storage: NativeKeyValueStorage = {getItem: async key => values.get(key) ?? null, setItem: async (key, value) => {values.set(key, value);}, removeItem: async key => {values.delete(key);}};
  const store = createNativeAuthStateStore(storage);
  const oxy = new OxyServices({baseURL: 'http://fixture.invalid'});
  clients.push(oxy);
  oxy.session.setAccessToken(tokenA);
  return {storage, store, oxy};
}
const originalFetch = global.fetch;
afterEach(() => {global.fetch = originalFetch; for (const session of sessions.splice(0)) session.stop(); for (const client of clients.splice(0)) client.http.dispose();});

describe('device refresh uses full native context CAS after a normal SDK switch', () => {
  it('late A cannot overwrite persisted B for the same holder or publish shared bytes', async () => {
    const {storage, store, oxy} = fixture(); await store.save(prior);
    const entered = deferred<void>(); const release = deferred<DeviceTokenMintResponse>();
    global.fetch = jest.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith('/session/device/token')) {entered.resolve(); return new Response(JSON.stringify({data: await release.promise}), {status: 200, headers: {'content-type': 'application/json'}});}
      if (path.endsWith('/session/device/switch')) return new Response(JSON.stringify({data: {state: state('org-b', 2), activeToken: {accessToken: tokenB, expiresAt: prior.expiresAt}}}), {status: 200, headers: {'content-type': 'application/json'}});
      if (path.includes('/session/device/directory')) return new Response(JSON.stringify({data: {deviceId: holder.deviceId, revision: 2, updatedAt: Date.now(), principals: [], contexts: [], activeContextId: null}}), {status: 200, headers: {'content-type': 'application/json'}});
      throw new Error(`Unexpected fixture route ${path}`);
    }) as typeof fetch;
    const sharedPublish = jest.fn();
    const native = {...store, save: async (next: PersistedAuthState) => {const ok = await store.save(next); if (ok) sharedPublish(next); return ok;}, saveIfCurrent: async (next: PersistedAuthState, guard: Parameters<NonNullable<typeof store.saveIfCurrent>>[1]) => {const ok = await store.saveIfCurrent!(next, guard); if (ok) sharedPublish(next); return ok;}};
    const pending = refreshDeviceSecretArm({oxy, store: native}); await entered.promise;
    const epochA = oxy.http.getSessionEpoch();
    const host = createSessionClientHost(oxy); host.setDeviceCredential(holder);
    const client = new SessionClient(host); sessions.push(client);
    await client.switchAccount('org-b');
    expect(client.getState()?.activeAccountId).toBe('org-b'); expect(oxy.session.accessToken).toBe(tokenB);
    expect(oxy.http.getSessionEpoch()).toBeGreaterThan(epochA);
    const selectedB = {...prior, sessionId: 'session-b', userId: 'org-b', accessToken: tokenB};
    await native.save(selectedB); sharedPublish.mockClear();
    release.resolve(response);
    expect(await pending).toEqual({status: 'session-ended'});
    expect(oxy.session.accessToken).toBe(tokenB);
    expect(await native.load()).toEqual(selectedB);
    expect(await createNativeAuthStateStore(storage).load()).toEqual(selectedB);
    expect(sharedPublish).not.toHaveBeenCalled();
  });
  it('a replacement queued after the retained-state read still wins the native CAS', async () => {
    const {storage, store, oxy} = fixture(); await store.save(prior);
    const entered = deferred<void>(); const release = deferred<DeviceTokenMintResponse>();
    const readReached = deferred<void>(); const continueRead = deferred<void>(); let reads = 0;
    const guarded = {...store, load: async () => {const snapshot = await store.load(); if (++reads === 2) {readReached.resolve(); await continueRead.promise;} return snapshot;}};
    global.fetch = jest.fn(async () => {entered.resolve(); return new Response(JSON.stringify({data: await release.promise}), {status: 200, headers: {'content-type': 'application/json'}});}) as typeof fetch;
    const pending = refreshDeviceSecretArm({oxy, store: guarded}); await entered.promise;
    oxy.http.endSession(); release.resolve(response); await readReached.promise;
    const selectedB = {...prior, sessionId: 'session-b', userId: 'org-b', accessToken: tokenB};
    oxy.session.setAccessToken(tokenB); await store.save(selectedB); continueRead.resolve();
    expect(await pending).toEqual({status: 'session-ended'}); expect(oxy.session.accessToken).toBe(tokenB);
    expect(await createNativeAuthStateStore(storage).load()).toEqual(selectedB);
  });
  it('token-null teardown retains only valid credential rotation without restoring a bearer', async () => {
    const {storage, store, oxy} = fixture(); await store.save(prior);
    const entered = deferred<void>(); const release = deferred<DeviceTokenMintResponse>();
    global.fetch = jest.fn(async () => {entered.resolve(); return new Response(JSON.stringify({data: await release.promise}), {status: 200, headers: {'content-type': 'application/json'}});}) as typeof fetch;
    const pending = refreshDeviceSecretArm({oxy, store}); await entered.promise; oxy.http.endSession(); release.resolve(response);
    expect(await pending).toEqual({status: 'session-ended'}); expect(oxy.session.accessToken).toBeNull();
    expect(await createNativeAuthStateStore(storage).load()).toEqual({...prior, deviceSecret: response.nextDeviceSecret});
  });
  it('cleared native storage stays absent after a late successful mint', async () => {
    const {storage, store, oxy} = fixture(); await store.save(prior);
    const entered = deferred<void>(); const release = deferred<DeviceTokenMintResponse>();
    global.fetch = jest.fn(async () => {entered.resolve(); return new Response(JSON.stringify({data: await release.promise}), {status: 200, headers: {'content-type': 'application/json'}});}) as typeof fetch;
    const pending = refreshDeviceSecretArm({oxy, store}); await entered.promise; oxy.http.endSession(); await store.clear(); release.resolve(response);
    expect(await pending).toEqual({status: 'session-ended'}); expect(oxy.session.accessToken).toBeNull(); expect(await createNativeAuthStateStore(storage).load()).toBeNull();
  });
  it('current same-context refresh still persists and plants its valid mint', async () => {
    const {storage, store, oxy} = fixture(); await store.save(prior);
    global.fetch = jest.fn(async () => new Response(JSON.stringify({data: response}), {status: 200, headers: {'content-type': 'application/json'}})) as typeof fetch;
    expect(await refreshDeviceSecretArm({oxy, store})).toMatchObject({status: 'ok', userId: 'person-a'});
    expect(oxy.session.accessToken).toBe(response.accessToken); expect((await createNativeAuthStateStore(storage).load())?.deviceSecret).toBe(response.nextDeviceSecret);
  });
});
