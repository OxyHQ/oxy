import type { DeviceTokenMintResponse } from '@oxy.so/contracts';
import type { OxyServices } from '../../OxyServices';
import { createNativeAuthStateStore, type NativeKeyValueStorage } from '../../session/authStateStore';
import { refreshDeviceSecretArm, refreshPersistedSession, type RefreshDeps } from '../../session/refresh';
import type { SharedDeviceCredentialStore } from '../../session/sharedDeviceCredential';
import { runSessionColdBoot } from '../sessionColdBoot';

const prior = {sessionId: 'prior-session', userId: 'person', deviceId: 'old-device', deviceSecret: 'old-holder'};
const shared = {deviceId: 'new-device', deviceSecret: 'new-holder'};
const mint: DeviceTokenMintResponse = {
  accessToken: 'new-token', expiresAt: new Date(Date.now() + 300_000).toISOString(), nextDeviceSecret: shared.deviceSecret,
  state: {deviceId: shared.deviceId, activeAccountId: 'person', accounts: [{accountId: 'person', sessionId: 'new-session', authuser: 0}], revision: 2, updatedAt: Date.now()},
};
function reject(message = 'invalid_device_secret', status = 401): Error {return Object.assign(new Error(message), {status});}
function fixture() {
  const values = new Map<string, string>();
  const storage: NativeKeyValueStorage = {getItem: async key => values.get(key) ?? null, setItem: async (key, value) => {values.set(key, value);}, removeItem: async key => {values.delete(key);}};
  const store = createNativeAuthStateStore(storage);
  let epoch = 0;
  const mintToken = jest.fn<Promise<DeviceTokenMintResponse>, [string, string]>(async () => {throw reject();});
  const signInWithCommonsIdentity = jest.fn(async () => ({sessionId: 'identity-session', user: {id: 'identity-owner'}, accessToken: 'identity-token', deviceId: 'identity-device', deviceSecret: 'identity-secret'}));
  const plant = jest.fn();
  const oxy = {baseURL: 'https://api.oxy.so', devices: {mintToken}, auth: {signInWithCommonsIdentity}, session: {setAccessToken: plant}, http: {getSessionEpoch: () => epoch, hasSessionEnded: () => false, runSingleFlightDeviceSecretMint: (operation: () => Promise<unknown>) => operation()}} as unknown as OxyServices;
  const slot: SharedDeviceCredentialStore = {read: jest.fn(async () => ({state: 'present', credential: shared})), publish: jest.fn(async () => true), clear: jest.fn(async () => undefined)};
  return {storage, store, oxy, mintToken, signInWithCommonsIdentity, plant, slot, bump: () => {epoch++;}};
}
function deps(f: ReturnType<typeof fixture>): RefreshDeps & {sharedDeviceCredential: SharedDeviceCredentialStore} {
  return {oxy: f.oxy, store: f.store, allowCommonsIdentityFallback: true, sharedDeviceCredential: f.slot};
}

describe('invalidated authenticated native holder and explicit shared re-login', () => {
  it.each(['cold', 'refresh'])('%s preserves holder history and prevents automatic key sign-in after invalid-secret', async lane => {
    const f = fixture(); await f.store.save(prior);
    if (lane === 'cold') expect((await runSessionColdBoot({oxy: f.oxy, store: f.store, platform: {isWeb: false, isNative: true}})).kind).toBe('unauthenticated');
    else expect(await refreshPersistedSession({oxy: f.oxy, store: f.store, allowCommonsIdentityFallback: true})).toBeNull();
    expect(f.signInWithCommonsIdentity).not.toHaveBeenCalled();
    const restarted = createNativeAuthStateStore(f.storage);
    expect(await restarted.isAutomaticIdentitySignInSuppressed?.()).toBe(true);
    expect(await restarted.load()).toMatchObject(prior);
  });
  it('does not infer logout from an unauthenticated candidate credential', async () => {
    const f = fixture(); await f.store.save({...prior, sessionId: '', userId: ''});
    expect(await refreshDeviceSecretArm({oxy: f.oxy, store: f.store})).toEqual({status: 'invalid-secret'});
    expect(await f.store.isAutomaticIdentitySignInSuppressed?.()).toBe(false);
  });
  it('a pinned rejection does not set ACCOUNT logout intent', async () => {
    const f = fixture(); await f.store.save(prior);
    expect(await refreshDeviceSecretArm({oxy: f.oxy, store: f.store, pin: {accountId: 'person', publicKey: 'key'}})).toEqual({status: 'invalid-secret'});
    expect(await f.store.isAutomaticIdentitySignInSuppressed?.()).toBe(false);
  });
  it.each(['network', 'unauthorized'])('%s cannot authorize holder replacement', async message => {
    const f = fixture(); await f.store.save(prior); f.mintToken.mockRejectedValue(reject(message, message === 'network' ? 503 : 401));
    expect(await refreshPersistedSession(deps(f))).toBeNull(); expect(f.slot.read).not.toHaveBeenCalled();
    expect(await f.store.load()).toEqual(prior); expect(await f.store.isAutomaticIdentitySignInSuppressed?.()).toBe(false);
  });
  it('warm recovery proves a new shared holder before persisting or planting', async () => {
    const f = fixture(); await f.store.save(prior);
    f.mintToken.mockImplementation(async device => {if (device === prior.deviceId) throw reject(); expect(await f.store.load()).toEqual(prior); expect(f.plant).not.toHaveBeenCalled(); return mint;});
    expect(await refreshPersistedSession(deps(f))).toBe(mint.accessToken);
    expect(await f.store.load()).toMatchObject({...shared, sessionId: 'new-session', userId: 'person'});
    expect(f.plant).toHaveBeenCalledWith(mint.accessToken); expect(f.signInWithCommonsIdentity).not.toHaveBeenCalled();
  });
  it('cold recovery proves shared re-login after rejecting local holder history', async () => {
    const f = fixture(); await f.store.save(prior);
    f.mintToken.mockImplementation(async device => {if (device === prior.deviceId) throw reject(); expect(await f.store.load()).toEqual(prior); return mint;});
    expect(await runSessionColdBoot({oxy: f.oxy, store: f.store, platform: {isWeb: false, isNative: true}, sharedDeviceCredential: f.slot})).toMatchObject({kind: 'session', session: {userId: 'person'}});
    expect(f.signInWithCommonsIdentity).not.toHaveBeenCalled();
  });
  it('late invalid-secret cannot mark a replaced session', async () => {
    const f = fixture(); await f.store.save(prior);
    f.mintToken.mockImplementation(async () => {await f.store.save({...prior, userId: 'new-person'}); throw reject();});
    expect(await refreshDeviceSecretArm({oxy: f.oxy, store: f.store})).toEqual({status: 'session-ended'});
    expect(await f.store.isAutomaticIdentitySignInSuppressed?.()).toBe(false);
  });
  it('a shared mint that outlives its epoch plants nothing', async () => {
    const f = fixture(); await f.store.save(prior);
    f.mintToken.mockImplementation(async device => {if (device === prior.deviceId) throw reject(); f.bump(); return mint;});
    expect(await refreshPersistedSession(deps(f))).toBeNull(); expect(await f.store.load()).toEqual(prior); expect(f.plant).not.toHaveBeenCalled(); expect(f.signInWithCommonsIdentity).not.toHaveBeenCalled();
  });
});
