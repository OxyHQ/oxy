import type { DeviceSessionState } from '@oxyhq/contracts';
import { SessionClient, type SessionClientHost, type SessionStateOrigin } from '../SessionClient';
import { createMemoryAuthStateStore } from '../authStateStore';

const stateWith = (rev: number, active: string | null, accountIds: string[]): DeviceSessionState => ({
  deviceId: 'd1',
  accounts: accountIds.map((id, i) => ({ accountId: id, sessionId: `s-${id}`, authuser: i })),
  activeAccountId: active,
  revision: rev,
  updatedAt: 1720000000000,
});

const sync = (state: DeviceSessionState) => ({ state, activeToken: { accessToken: `jwt-${state.revision}`, expiresAt: 'x' } });

function makeHost(makeRequest: jest.Mock, currentAccountId: string | null = null): SessionClientHost {
  return {
    makeRequest,
    getBaseURL: () => 'http://test.invalid',
    getAccessToken: () => 't',
    getDeviceCredential: () => null,
    onTokensChanged: () => () => undefined,
    setTokens: jest.fn(),
    getCurrentAccountId: () => currentAccountId,
  };
}

class TestClient extends SessionClient {
  public apply(raw: unknown): boolean {
    return this.applyState(raw);
  }

  public applyWith(raw: unknown, origin: SessionStateOrigin): boolean {
    return this.applyState(raw, origin);
  }
}

describe('SessionClient.registerAndActivate', () => {
  it('adds then switches to the explicit target when it is not already active', async () => {
    const makeRequest = jest
      .fn()
      // add → device set has a1 active, a2 present but not active
      .mockResolvedValueOnce(sync(stateWith(1, 'a1', ['a1', 'a2'])))
      // switch → a2 becomes active
      .mockResolvedValueOnce(sync(stateWith(2, 'a2', ['a1', 'a2'])));
    const c = new SessionClient(makeHost(makeRequest));

    await c.registerAndActivate('a2');

    expect(makeRequest).toHaveBeenNthCalledWith(1, 'POST', '/session/device/add', undefined, { cache: false });
    expect(makeRequest).toHaveBeenNthCalledWith(2, 'POST', '/session/device/switch', { accountId: 'a2' }, { cache: false });
    expect(c.getState()?.activeAccountId).toBe('a2');
    c.stop();
  });

  it('falls back to the host current-account ref when no target is passed', async () => {
    const makeRequest = jest
      .fn()
      .mockResolvedValueOnce(sync(stateWith(1, 'a1', ['a1', 'a2'])))
      .mockResolvedValueOnce(sync(stateWith(2, 'a2', ['a1', 'a2'])));
    const c = new SessionClient(makeHost(makeRequest, 'a2'));

    await c.registerAndActivate();

    expect(makeRequest).toHaveBeenNthCalledWith(2, 'POST', '/session/device/switch', { accountId: 'a2' }, { cache: false });
    c.stop();
  });

  it('does NOT switch when the added account is already active', async () => {
    const makeRequest = jest.fn().mockResolvedValueOnce(sync(stateWith(1, 'a1', ['a1'])));
    const c = new SessionClient(makeHost(makeRequest));

    await c.registerAndActivate('a1');

    expect(makeRequest).toHaveBeenCalledTimes(1);
    expect(makeRequest).toHaveBeenCalledWith('POST', '/session/device/add', undefined, { cache: false });
    c.stop();
  });
});

describe('SessionClient onUnauthenticated', () => {
  it('fires when an applied state has zero accounts (device signout-all)', () => {
    const onUnauthenticated = jest.fn();
    const c = new TestClient(makeHost(jest.fn()), { onUnauthenticated });

    c.apply(stateWith(1, 'a1', ['a1']));
    expect(onUnauthenticated).not.toHaveBeenCalled();

    c.apply(stateWith(2, null, []));
    expect(onUnauthenticated).toHaveBeenCalledTimes(1);
  });

  it('does not fire for a stale (non-applied) empty state', () => {
    const onUnauthenticated = jest.fn();
    const c = new TestClient(makeHost(jest.fn()), { onUnauthenticated });

    c.apply(stateWith(5, 'a1', ['a1']));
    // revision 4 <= 5 → rejected, so onUnauthenticated must NOT fire.
    c.apply(stateWith(4, null, []));
    expect(onUnauthenticated).not.toHaveBeenCalled();
  });

  it('passes the applied-state ORIGIN through to onUnauthenticated', () => {
    const onUnauthenticated = jest.fn();
    const c = new TestClient(makeHost(jest.fn()), { onUnauthenticated });

    // A socket-pushed empty state → `push` origin.
    c.applyWith(stateWith(1, null, []), 'push');
    expect(onUnauthenticated).toHaveBeenLastCalledWith('push');

    // A direct REST response empty state → `request` origin.
    c.applyWith(stateWith(2, null, []), 'request');
    expect(onUnauthenticated).toHaveBeenLastCalledWith('request');
  });
});

describe('SessionClient onUnauthenticated — durable credential guard (bug #4)', () => {
  const CRED = { sessionId: 's1', userId: 'a1', deviceId: 'dev-1', deviceSecret: 'ds-1' };

  // Mirror the provider's origin-gated wipe: erase the durable credential ONLY on
  // a `request`-origin verdict, never on a (possibly transient) `push`.
  function wireGuardedStore() {
    const store = createMemoryAuthStateStore();
    const onUnauthenticated = (origin: SessionStateOrigin) => {
      if (origin === 'request') void store.clear();
    };
    return { store, onUnauthenticated };
  }

  it('a transient socket-pushed accounts===0 does NOT wipe the durable credential', async () => {
    const { store, onUnauthenticated } = wireGuardedStore();
    await store.save(CRED);
    const c = new TestClient(makeHost(jest.fn()), { onUnauthenticated });

    // A `push`-origin empty state (e.g. a reconnect race on another device).
    c.applyWith(stateWith(2, null, []), 'push');
    await Promise.resolve();

    // The device credential survives — a reload can still restore the session.
    expect(await store.load()).toEqual(CRED);
  });

  it('a real (request-origin) sign-out DOES wipe the durable credential', async () => {
    const { store, onUnauthenticated } = wireGuardedStore();
    await store.save(CRED);
    const c = new TestClient(makeHost(jest.fn()), { onUnauthenticated });

    // A `request`-origin empty state = the REST sign-out response.
    c.applyWith(stateWith(2, null, []), 'request');
    await Promise.resolve();

    expect(await store.load()).toBeNull();
  });
});
