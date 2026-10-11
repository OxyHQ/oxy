import type { OxyServices } from '../../OxyServices';
import type { SessionLoginResponse } from '../../models/session';
import {
  createNativeAuthStateStore,
  type AuthStateStore,
  type NativeKeyValueStorage,
} from '../../session/authStateStore';
import { refreshPersistedSession } from '../../session/refresh';
import { runSessionColdBoot } from '../sessionColdBoot';

type LogoutStore = AuthStateStore & {
  setAutomaticIdentitySignInSuppressed?: (suppressed: boolean) => Promise<boolean>;
};
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
  const session = {
    sessionId: 'new-key-session',
    user: { id: 'commons-owner' },
    accessToken: 'new-key-token',
    deviceId: 'new-device',
    deviceSecret: 'new-secret',
  } as SessionLoginResponse;
  const signInWithCommonsIdentity = jest.fn(async () => session);
  const oxy = {
    baseURL: 'https://api.oxy.so',
    auth: { signInWithCommonsIdentity },
    session: { setAccessToken: jest.fn() },
    devices: { mintToken: jest.fn() },
    http: {
      getSessionEpoch: () => 0,
      hasSessionEnded: () => false,
      runSingleFlightDeviceSecretMint: (operation: () => Promise<unknown>) => operation(),
    },
  } as unknown as OxyServices;
  return { storage, values, oxy, signInWithCommonsIdentity };
}

describe('explicit native account logout survives a new process', () => {
  it('does not challenge Commons after full signout and a recreated store', async () => {
    const { storage, oxy, signInWithCommonsIdentity } = fixture();
    const original: LogoutStore = createNativeAuthStateStore(storage);
    await original.save({
      sessionId: 'old',
      userId: 'commons-owner',
      deviceId: 'old-device',
      deviceSecret: 'old-secret',
    });
    await original.setAutomaticIdentitySignInSuppressed?.(true);
    await original.clear();
    const restarted = createNativeAuthStateStore(storage);
    const outcome = await runSessionColdBoot({
      oxy,
      store: restarted,
      platform: { isWeb: false, isNative: true },
    });
    expect(outcome.kind).toBe('unauthenticated');
    expect(signInWithCommonsIdentity).not.toHaveBeenCalled();
  });
  it('also blocks the automatic refresh key lane after logout', async () => {
    const { storage, oxy, signInWithCommonsIdentity } = fixture();
    const original: LogoutStore = createNativeAuthStateStore(storage);
    await original.setAutomaticIdentitySignInSuppressed?.(true);
    await original.clear();
    const token = await refreshPersistedSession({
      oxy,
      store: createNativeAuthStateStore(storage),
      allowCommonsIdentityFallback: true,
    });
    expect(token).toBeNull();
    expect(signInWithCommonsIdentity).not.toHaveBeenCalled();
  });
  it('a pending save cannot restore a credential after the later clear', async () => {
    const { storage } = fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backingSet = storage.setItem;
    storage.setItem = async (key, value) => {
      await barrier;
      await backingSet(key, value);
    };
    const store = createNativeAuthStateStore(storage);
    const saving = store.save({
      sessionId: 'old',
      userId: 'old-user',
      deviceId: 'old-device',
      deviceSecret: 'old-secret',
    });
    const clearing = store.clear();
    release();
    await Promise.all([saving, clearing]);
    expect(await createNativeAuthStateStore(storage).load()).toBeNull();
  });
});

describe('durable automatic identity sign-in intent', () => {
  it('ordinary save/clear preserve suppression until an explicit successful sign-in releases it', async () => {
    const { storage, oxy, signInWithCommonsIdentity } = fixture();
    const original = createNativeAuthStateStore(storage);
    expect(await original.setAutomaticIdentitySignInSuppressed?.(true)).toBe(true);
    await original.save({ sessionId: 'late-notify', userId: 'old-user' });
    await original.clear();
    const next = createNativeAuthStateStore(storage);
    expect(await next.isAutomaticIdentitySignInSuppressed?.()).toBe(true);
    await next.setAutomaticIdentitySignInSuppressed?.(false);
    const restarted = createNativeAuthStateStore(storage);
    const outcome = await runSessionColdBoot({
      oxy,
      store: restarted,
      platform: { isWeb: false, isNative: true },
    });
    expect(outcome.kind).toBe('session');
    expect(signInWithCommonsIdentity).toHaveBeenCalledTimes(1);
  });
  it('unknown marker storage denies key recovery without deleting identity material', async () => {
    const { storage, oxy, signInWithCommonsIdentity, values } = fixture();
    values.set('identity-private-key', 'fixture-preserved');
    storage.getItem = async () => {
      throw new Error('locked storage');
    };
    const outcome = await runSessionColdBoot({
      oxy,
      store: createNativeAuthStateStore(storage),
      platform: { isWeb: false, isNative: true },
    });
    expect(outcome.kind).toBe('unauthenticated');
    expect(signInWithCommonsIdentity).not.toHaveBeenCalled();
    expect(values.get('identity-private-key')).toBe('fixture-preserved');
  });
  it('does not plant a key-proof result when logout intent arrives during challenge', async () => {
    const { storage, oxy, signInWithCommonsIdentity } = fixture();
    const store = createNativeAuthStateStore(storage);
    const original = signInWithCommonsIdentity.getMockImplementation();
    if (!original) throw new Error('Missing fixture implementation');
    signInWithCommonsIdentity.mockImplementation(async () => {
      await store.setAutomaticIdentitySignInSuppressed?.(true);
      return original();
    });
    const outcome = await runSessionColdBoot({
      oxy,
      store,
      platform: { isWeb: false, isNative: true },
    });
    expect(outcome.kind).toBe('unauthenticated');
    expect(oxy.session.setAccessToken).not.toHaveBeenCalled();
    expect(await store.load()).toBeNull();
  });
});

it('failed marker release remains suppressed in memory and after storage reopens', async () => {
  const { storage } = fixture();
  const store = createNativeAuthStateStore(storage);
  await store.setAutomaticIdentitySignInSuppressed?.(true);
  const originalRemove = storage.removeItem;
  storage.removeItem = async () => {
    throw new Error('locked');
  };
  expect(await store.setAutomaticIdentitySignInSuppressed?.(false)).toBe(false);
  expect(await store.isAutomaticIdentitySignInSuppressed?.()).toBe(true);
  storage.removeItem = originalRemove;
  expect(await createNativeAuthStateStore(storage).isAutomaticIdentitySignInSuppressed?.()).toBe(
    true,
  );
});

it('a generic late save cannot warm-plant a bearer while logout intent remains', async () => {
  const { storage, oxy, signInWithCommonsIdentity } = fixture();
  const original = createNativeAuthStateStore(storage);
  await original.setAutomaticIdentitySignInSuppressed?.(true);
  await original.save({
    sessionId: 'old',
    userId: 'commons-owner',
    accessToken: 'old-warm-bearer',
    expiresAt: '2030-01-01T00:00:00Z',
  });
  const outcome = await runSessionColdBoot({
    oxy,
    store: createNativeAuthStateStore(storage),
    platform: { isWeb: false, isNative: true },
  });
  expect(outcome.kind).toBe('unauthenticated');
  expect(oxy.session.setAccessToken).not.toHaveBeenCalled();
  expect(signInWithCommonsIdentity).not.toHaveBeenCalled();
});
