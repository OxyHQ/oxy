import type { DeviceTokenMintResponse } from '@oxy.so/contracts';
import type { OxyServices } from '../../OxyServices';
import {
  createNativeAuthStateStore,
  type NativeKeyValueStorage,
} from '../../session/authStateStore';
import { refreshSharedDeviceArm } from '../../session/refresh';
import {
  createSharedMirroringAuthStateStore,
  type SharedDeviceCredentialStore,
} from '../../session/sharedDeviceCredential';

const prior = {
  sessionId: 'old-session',
  userId: 'person',
  deviceId: 'old-device',
  deviceSecret: 'old-holder',
};
const credential = { deviceId: 'new-device', deviceSecret: 'new-holder' };
const mint: DeviceTokenMintResponse = {
  accessToken: 'new-token',
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  nextDeviceSecret: credential.deviceSecret,
  state: {
    deviceId: credential.deviceId,
    activeAccountId: 'person',
    accounts: [{ accountId: 'person', sessionId: 'new-session', authuser: 0 }],
    revision: 4,
    updatedAt: Date.now(),
  },
};
function fixture() {
  const data = new Map<string, string>();
  const kv: NativeKeyValueStorage = {
    getItem: jest.fn(async (key) => data.get(key) ?? null),
    setItem: jest.fn(async (key, value) => {
      data.set(key, value);
    }),
    removeItem: jest.fn(async (key) => {
      data.delete(key);
    }),
  };
  const store = createNativeAuthStateStore(kv);
  let current = true;
  let resolveMint: ((response: DeviceTokenMintResponse) => void) | undefined;
  const mintToken = jest.fn<Promise<DeviceTokenMintResponse>, [string, string]>(
    () =>
      new Promise((resolve) => {
        resolveMint = resolve;
      }),
  );
  const plant = jest.fn();
  const oxy = {
    http: {
      getSessionEpoch: () => 0,
      runSingleFlightDeviceSecretMint: (op: () => Promise<unknown>) => op(),
    },
    devices: { mintToken },
    session: { setAccessToken: plant },
  } as unknown as OxyServices;
  const shared: SharedDeviceCredentialStore = {
    read: jest.fn(async () => ({ state: 'present', credential })),
    publish: jest.fn(async () => true),
    clear: jest.fn(async () => undefined),
  };
  return {
    store,
    kv,
    oxy,
    shared,
    plant,
    mintToken,
    isCurrent: () => current,
    dispose: () => {
      current = false;
    },
    finish: async () => {
      while (!resolveMint) await Promise.resolve();
      resolveMint(mint);
    },
  };
}

describe('shared holder commit durability and provider lifecycle', () => {
  it('a disposed refresh cannot persist or plant a pending mint', async () => {
    const f = fixture();
    await f.store.save(prior);
    const pending = refreshSharedDeviceArm({ ...f, rejectedLocalHolder: true });
    while (!f.mintToken.mock.calls.length) await Promise.resolve();
    f.dispose();
    await f.finish();
    expect(await pending).toEqual({ status: 'session-ended' });
    expect(await createNativeAuthStateStore(f.kv).load()).toEqual(prior);
    expect(f.plant).not.toHaveBeenCalled();
  });
  it('a replacement while minting wins', async () => {
    const f = fixture();
    await f.store.save(prior);
    const pending = refreshSharedDeviceArm({ ...f, rejectedLocalHolder: true });
    while (!f.mintToken.mock.calls.length) await Promise.resolve();
    const replacement = { ...prior, userId: 'new-person' };
    await f.store.save(replacement);
    await f.finish();
    expect(await pending).toEqual({ status: 'session-ended' });
    expect(await f.store.load()).toEqual(replacement);
    expect(f.plant).not.toHaveBeenCalled();
  });
  it('the queue rechecks a save enqueued after the last caller read', async () => {
    const f = fixture();
    await f.store.save(prior);
    const replacement = { ...prior, sessionId: 'new-session' };
    const load = f.store.load;
    let reads = 0;
    const wrapped = {
      ...f.store,
      load: async () => {
        const state = await load();
        if (++reads === 2) void f.store.save(replacement);
        return state;
      },
    };
    const pending = refreshSharedDeviceArm({ ...f, store: wrapped, rejectedLocalHolder: true });
    await f.finish();
    expect(await pending).toEqual({ status: 'persist-failed' });
    expect(await f.store.load()).toEqual(replacement);
    expect(f.plant).not.toHaveBeenCalled();
  });
  it('a conditional commit passes through shared mirroring', async () => {
    const f = fixture();
    await f.store.save(prior);
    (f.shared.read as jest.Mock)
      .mockResolvedValueOnce({ state: 'present', credential })
      .mockResolvedValue({ state: 'absent' });
    const mirror = createSharedMirroringAuthStateStore({ local: f.store, shared: f.shared });
    const pending = refreshSharedDeviceArm({ ...f, store: mirror, rejectedLocalHolder: true });
    await f.finish();
    expect(await pending).toMatchObject({ status: 'ok', userId: 'person' });
    expect(f.shared.publish).toHaveBeenCalledWith(credential);
    expect(await createNativeAuthStateStore(f.kv).load()).toMatchObject({
      ...credential,
      userId: 'person',
    });
  });
  it('durability failure refuses token planting', async () => {
    const f = fixture();
    await f.store.save(prior);
    (f.kv.setItem as jest.Mock).mockRejectedValue(new Error('owned storage failure'));
    const pending = refreshSharedDeviceArm({ ...f, rejectedLocalHolder: true });
    await f.finish();
    expect(await pending).toEqual({ status: 'persist-failed' });
    expect(f.plant).not.toHaveBeenCalled();
    expect(await createNativeAuthStateStore(f.kv).load()).toEqual(prior);
  });
  it('an old rejected mint cannot clear a concurrently published slot', async () => {
    const f = fixture();
    await f.store.save(prior);
    f.mintToken.mockImplementation(async () => {
      throw Object.assign(new Error('invalid_device_secret'), { status: 401 });
    });
    expect(await refreshSharedDeviceArm({ ...f, rejectedLocalHolder: true })).toEqual({
      status: 'invalid-secret',
    });
    expect(f.shared.clear).not.toHaveBeenCalled();
    expect(await f.store.load()).toEqual(prior);
  });
  it('a healthy existing holder is never replaced from the shared slot', async () => {
    const f = fixture();
    await f.store.save(prior);
    expect(await refreshSharedDeviceArm(f)).toEqual({ status: 'no-secret' });
    expect(f.shared.read).not.toHaveBeenCalled();
    expect(f.mintToken).not.toHaveBeenCalled();
  });
});
