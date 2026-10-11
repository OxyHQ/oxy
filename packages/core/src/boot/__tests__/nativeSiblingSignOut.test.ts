import type { DeviceSessionState } from '@oxy.so/contracts';
import type { OxyServices } from '../../OxyServices';
import { SessionClient, type SessionClientHost } from '../../session/SessionClient';
import {
  createNativeAuthStateStore,
  type NativeKeyValueStorage,
} from '../../session/authStateStore';
import { runSessionColdBoot } from '../sessionColdBoot';

class ReceivingClient extends SessionClient {
  receive(state: unknown): boolean {
    return this.applyState(state, 'push');
  }
}
const state = (revision: number, account: string | null = 'person'): DeviceSessionState => ({
  deviceId: 'shared-device',
  revision,
  updatedAt: 1720000000000,
  activeAccountId: account,
  accounts: account ? [{ accountId: account, sessionId: `session-${account}`, authuser: 0 }] : [],
});
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
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
  const store = createNativeAuthStateStore(storage);
  const host: SessionClientHost = {
    makeRequest: jest.fn(),
    getBaseURL: () => 'http://test.invalid',
    getAccessToken: () => 'old-bearer',
    getDeviceCredential: () => ({ deviceId: 'shared-device', deviceSecret: 'holder-secret' }),
    onTokensChanged: () => () => undefined,
    setTokens: jest.fn(),
    getCurrentAccountId: () => 'person',
  };
  const mark = jest.fn(async () => {
    await store.setAutomaticIdentitySignInSuppressed?.(true);
  });
  const signInWithCommonsIdentity = jest.fn(async () => ({
    sessionId: 'recreated',
    user: { id: 'commons-owner' },
    accessToken: 'new',
    deviceId: 'new-device',
    deviceSecret: 'new-secret',
  }));
  const oxy = {
    baseURL: 'https://api.oxy.so',
    auth: { signInWithCommonsIdentity },
    session: { setAccessToken: jest.fn() },
    devices: { mintToken: jest.fn() },
    http: {
      getSessionEpoch: () => 0,
      hasSessionEnded: () => false,
      runSingleFlightDeviceSecretMint: (op: () => Promise<unknown>) => op(),
    },
  } as unknown as OxyServices;
  return { store, storage, host, mark, oxy, signInWithCommonsIdentity };
}

describe('full logout received by a native sibling', () => {
  it('persists the received removal before cold boot can recreate Commons identity', async () => {
    const f = fixture();
    const client = new ReceivingClient(f.host, { onFullExplicitSignOut: f.mark });
    client.receive(state(1));
    expect(client.receive(state(2, null))).toBe(true);
    await settle();
    const restarted = createNativeAuthStateStore(f.storage);
    const outcome = await runSessionColdBoot({
      oxy: f.oxy,
      store: restarted,
      platform: { isWeb: false, isNative: true },
    });
    expect(outcome.kind).toBe('unauthenticated');
    expect(f.signInWithCommonsIdentity).not.toHaveBeenCalled();
    expect(await restarted.isAutomaticIdentitySignInSuppressed?.()).toBe(true);
  });

  it('does not publish signed out before the durable barrier completes', async () => {
    const f = fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mark = jest.fn(async () => {
      await barrier;
      await f.mark();
    });
    const seen: Array<string | null> = [];
    const client = new ReceivingClient(f.host, { onFullExplicitSignOut: mark });
    client.subscribe((next) => seen.push(next?.activeAccountId ?? null));
    client.receive(state(1));
    client.receive(state(2, null));
    expect(mark).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['person']);
    release();
    await settle();
    expect(seen).toEqual(['person', null]);
    expect(await f.store.isAutomaticIdentitySignInSuppressed?.()).toBe(true);
  });

  it('does not publish a delayed empty transition after a newer account commit', async () => {
    const f = fixture();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mark = jest.fn(async () => {
      await f.mark();
      await barrier;
    });
    const seen: Array<string | null> = [];
    const client = new ReceivingClient(f.host, { onFullExplicitSignOut: mark });
    client.subscribe((next) => seen.push(next?.activeAccountId ?? null));
    client.receive(state(1));
    client.receive(state(2, null));
    await settle();
    client.receive(state(3, 'new-person'));
    await f.store.setAutomaticIdentitySignInSuppressed?.(false);
    release();
    await settle();
    expect(seen).toEqual(['person', 'new-person']);
    expect(await f.store.isAutomaticIdentitySignInSuppressed?.()).toBe(false);
  });

  it('remaining account, stale/equal/invalid empty and unknown initial state do not mark logout', async () => {
    const f = fixture();
    const client = new ReceivingClient(f.host, { onFullExplicitSignOut: f.mark });
    client.receive(state(1, null));
    client.receive(state(2));
    client.receive(state(3, 'remaining-person'));
    expect(client.receive(state(2, null))).toBe(false);
    expect(client.receive(state(3, null))).toBe(false);
    expect(client.receive({ ...state(4, null), accounts: 'invalid' })).toBe(false);
    await settle();
    expect(f.mark).not.toHaveBeenCalled();
    expect(await f.store.isAutomaticIdentitySignInSuppressed?.()).toBe(false);
  });

  it('identity pin preserves its own key recovery lane after shared removal', async () => {
    const f = fixture();
    const client = new ReceivingClient(f.host, {
      onFullExplicitSignOut: f.mark,
      getPinnedAccountId: () => 'commons-owner',
    });
    client.receive(state(1));
    client.receive(state(2, null));
    await settle();
    expect(f.mark).not.toHaveBeenCalled();
  });
});
