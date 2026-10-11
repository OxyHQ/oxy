import type { OxyServices } from '../../OxyServices';
import {
  createNativeAuthStateStore,
  type NativeKeyValueStorage,
} from '../../session/authStateStore';
import { refreshDeviceSecretArm, refreshPersistedSession } from '../../session/refresh';
import { runSessionColdBoot } from '../sessionColdBoot';

function fixture() {
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
  let epoch = 0;
  const store = createNativeAuthStateStore(storage);
  const mintToken = jest.fn(async () => {
    throw Object.assign(new Error('no_active_session'), { status: 401 });
  });
  const signInWithCommonsIdentity = jest.fn(async () => ({
    sessionId: 'key-session',
    user: { id: 'commons-owner' },
    accessToken: 'key-token',
    deviceId: 'key-device',
    deviceSecret: 'key-secret',
  }));
  const oxy = {
    baseURL: 'https://api.oxy.so',
    devices: { mintToken },
    auth: { signInWithCommonsIdentity },
    session: { setAccessToken: jest.fn() },
    http: {
      getSessionEpoch: () => epoch,
      hasSessionEnded: () => false,
      runSingleFlightDeviceSecretMint: (operation: () => Promise<unknown>) => operation(),
    },
  } as unknown as OxyServices;
  return {
    storage,
    store,
    oxy,
    mintToken,
    signInWithCommonsIdentity,
    bumpEpoch: () => {
      epoch++;
    },
  };
}
const prior = {
  sessionId: 'prior-session',
  userId: 'person',
  deviceId: 'device',
  deviceSecret: 'holder-secret',
};

describe('a native sibling stopped during another app full logout', () => {
  it('cold mint rejection persists logout intent without challenging Commons or deleting the holder', async () => {
    const f = fixture();
    await f.store.save(prior);
    const restarted = createNativeAuthStateStore(f.storage);
    const outcome = await runSessionColdBoot({
      oxy: f.oxy,
      store: restarted,
      platform: { isWeb: false, isNative: true },
    });
    expect(outcome.kind).toBe('unauthenticated');
    expect(f.signInWithCommonsIdentity).not.toHaveBeenCalled();
    expect(
      await createNativeAuthStateStore(f.storage).isAutomaticIdentitySignInSuppressed?.(),
    ).toBe(true);
    expect(await restarted.load()).toMatchObject({
      deviceId: prior.deviceId,
      deviceSecret: prior.deviceSecret,
    });
  });
  it('refresh no_active_session never falls through to automatic key authentication', async () => {
    const f = fixture();
    await f.store.save(prior);
    expect(
      await refreshPersistedSession({
        oxy: f.oxy,
        store: f.store,
        allowCommonsIdentityFallback: true,
      }),
    ).toBeNull();
    expect(f.signInWithCommonsIdentity).not.toHaveBeenCalled();
    const restarted = createNativeAuthStateStore(f.storage);
    expect(await restarted.isAutomaticIdentitySignInSuppressed?.()).toBe(true);
    expect(await restarted.load()).toMatchObject({
      deviceId: prior.deviceId,
      deviceSecret: prior.deviceSecret,
    });
  });
  it('a rejection from before a new local epoch cannot set logout intent', async () => {
    const f = fixture();
    await f.store.save(prior);
    f.mintToken.mockImplementation(async () => {
      f.bumpEpoch();
      throw Object.assign(new Error('no_active_session'), { status: 401 });
    });
    expect(await refreshDeviceSecretArm({ oxy: f.oxy, store: f.store })).toEqual({
      status: 'session-ended',
    });
    expect(await f.store.isAutomaticIdentitySignInSuppressed?.()).toBe(false);
  });
  it('a rejection for a replaced holder cannot mark the new session', async () => {
    const f = fixture();
    await f.store.save(prior);
    f.mintToken.mockImplementation(async () => {
      await f.store.save({ ...prior, sessionId: 'new-session', userId: 'new-user' });
      throw Object.assign(new Error('no_active_session'), { status: 401 });
    });
    expect(await refreshDeviceSecretArm({ oxy: f.oxy, store: f.store })).toEqual({
      status: 'session-ended',
    });
    expect(await f.store.isAutomaticIdentitySignInSuppressed?.()).toBe(false);
    expect(await f.store.load()).toMatchObject({ sessionId: 'new-session', userId: 'new-user' });
  });
  it('a pinned rejection retains the identity lane and does not set account-mode intent', async () => {
    const f = fixture();
    await f.store.save(prior);
    expect(
      await refreshDeviceSecretArm({
        oxy: f.oxy,
        store: f.store,
        pin: { accountId: 'identity-owner', publicKey: 'identity-key' },
      }),
    ).toEqual({ status: 'no-session' });
    expect(await f.store.isAutomaticIdentitySignInSuppressed?.()).toBe(false);
  });
});
