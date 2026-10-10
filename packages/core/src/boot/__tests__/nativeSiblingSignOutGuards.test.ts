import type { OxyServices } from '../../OxyServices';
import { runSessionColdBoot } from '../sessionColdBoot';
import type { DeviceSessionState } from '@oxy.so/contracts';
import { SessionClient, type SessionClientHost } from '../../session/SessionClient';
import {
  createNativeAuthStateStore,
  type NativeKeyValueStorage,
} from '../../session/authStateStore';

const current = { sessionId: 'old', userId: 'person', deviceId: 'device', deviceSecret: 'secret' };
function kv() {
  const data = new Map<string, string>();
  const storage: NativeKeyValueStorage = {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
  return storage;
}
const state = (revision: number, empty = false, deviceId = 'device'): DeviceSessionState => ({
  deviceId,
  revision,
  updatedAt: 1720000000000,
  activeAccountId: empty ? null : 'person',
  accounts: empty ? [] : [{ accountId: 'person', sessionId: 'session', authuser: 0 }],
});
class Receiver extends SessionClient {
  receive(value: unknown) {
    return this.applyState(value, 'push');
  }
}
const host: SessionClientHost = {
  makeRequest: jest.fn(),
  getBaseURL: () => 'http://test.invalid',
  getAccessToken: () => 'token',
  getDeviceCredential: () => null,
  onTokensChanged: () => () => undefined,
  setTokens: jest.fn(),
  getCurrentAccountId: () => 'person',
};

it('checks expected session inside the store queue after an earlier pending replacement save', async () => {
  const storage = kv();
  const store = createNativeAuthStateStore(storage);
  await store.save(current);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const set = storage.setItem;
  storage.setItem = async (key, value) => {
    await barrier;
    await set(key, value);
  };
  const saving = store.save({ ...current, sessionId: 'new', userId: 'new-person' });
  const marking = store.setAutomaticIdentitySignInSuppressed?.(true, {
    expectedState: current,
    isCurrent: () => true,
  });
  release();
  await saving;
  expect(await marking).toBe(false);
  expect(await createNativeAuthStateStore(storage).isAutomaticIdentitySignInSuppressed?.()).toBe(
    false,
  );
  expect(await store.load()).toMatchObject({ sessionId: 'new', userId: 'new-person' });
});

it('checks epoch inside the queue after the caller has already enqueued marker persistence', async () => {
  const storage = kv();
  const store = createNativeAuthStateStore(storage);
  await store.save(current);
  let isCurrent = true;
  const marking = store.setAutomaticIdentitySignInSuppressed?.(true, {
    expectedState: current,
    isCurrent: () => isCurrent,
  });
  isCurrent = false;
  expect(await marking).toBe(false);
  expect(await store.isAutomaticIdentitySignInSuppressed?.()).toBe(false);
});

it('a different device empty projection does not create same-device logout intent', async () => {
  const mark = jest.fn(async () => undefined);
  const receiver = new Receiver(host, { onFullExplicitSignOut: mark });
  receiver.receive(state(1));
  receiver.receive(state(1, true, 'different-device'));
  await Promise.resolve();
  expect(mark).not.toHaveBeenCalled();
});

it('a reset local lifecycle discards the empty publication after the durable barrier', async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const receiver = new Receiver(host, { onFullExplicitSignOut: () => barrier });
  const seen: Array<number | null> = [];
  receiver.subscribe((next) => seen.push(next?.revision ?? null));
  receiver.receive(state(1));
  receiver.receive(state(2, true));
  receiver.resetLocalState();
  release();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(seen).toEqual([1, null]);
  expect(receiver.getState()).toBeNull();
});

it('a superseded cold mint ends this account boot without a fresh key challenge', async () => {
  const storage = kv();
  const store = createNativeAuthStateStore(storage);
  await store.save(current);
  let epoch = 0;
  const signInWithCommonsIdentity = jest.fn();
  const oxy = {
    baseURL: 'https://api.oxy.so',
    auth: { signInWithCommonsIdentity },
    session: { setAccessToken: jest.fn() },
    devices: {
      mintToken: async () => {
        epoch++;
        throw Object.assign(new Error('no_active_session'), { status: 401 });
      },
    },
    http: {
      getSessionEpoch: () => epoch,
      hasSessionEnded: () => false,
      runSingleFlightDeviceSecretMint: (operation: () => Promise<unknown>) => operation(),
    },
  } as unknown as OxyServices;
  expect(
    (await runSessionColdBoot({ oxy, store, platform: { isWeb: false, isNative: true } })).kind,
  ).toBe('unauthenticated');
  expect(signInWithCommonsIdentity).not.toHaveBeenCalled();
  expect(await store.isAutomaticIdentitySignInSuppressed?.()).toBe(false);
});

it('warm holder initial REST empty verdict awaits durable intent before bootstrap resolves', async () => {
  const storage = kv();
  const store = createNativeAuthStateStore(storage);
  await store.save(current);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bearer = `h.${Buffer.from(JSON.stringify({ userId: 'person' })).toString('base64url')}.s`;
  const request = jest.fn(async () => ({ state: state(2, true), activeToken: null }));
  const receiver = new Receiver(
    {
      ...host,
      makeRequest: request,
      getAccessToken: () => bearer,
      getDeviceCredential: () => ({
        deviceId: current.deviceId,
        deviceSecret: current.deviceSecret,
      }),
    },
    {
      onFullExplicitSignOut: async () => {
        await barrier;
        await store.setAutomaticIdentitySignInSuppressed?.(true);
      },
    },
  );
  let resolved = false;
  const boot = receiver.bootstrap().then(() => {
    resolved = true;
  });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(resolved).toBe(false);
  release();
  await boot;
  expect(await createNativeAuthStateStore(storage).isAutomaticIdentitySignInSuppressed?.()).toBe(
    true,
  );
});
