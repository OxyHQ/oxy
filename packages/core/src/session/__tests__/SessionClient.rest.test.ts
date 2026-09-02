import type { DeviceSessionState } from '@oxyhq/contracts';
import { SessionClient, type SessionClientHost } from '../SessionClient';

const STATE = (rev: number): DeviceSessionState => ({
  deviceId: 'd1', accounts: [{ accountId: 'a1', sessionId: 's1', authuser: 0 }], activeAccountId: 'a1', revision: rev, updatedAt: 1720000000000,
});

function makeHost(makeRequest: jest.Mock): SessionClientHost {
  return {
    makeRequest,
    getBaseURL: () => 'http://test.invalid',
    getAccessToken: () => 't',
    getDeviceCredential: () => null,
    onTokensChanged: () => () => undefined,
    setTokens: jest.fn(),
    getCurrentAccountId: () => null,
  };
}

// `makeRequest` (HttpService) already strips the server's outer `{ data }` envelope, so it
// returns the unwrapped sync body directly — that is exactly what SessionClient consumes.
const SYNC = (rev: number) => ({ state: STATE(rev), activeToken: { accessToken: `jwt-${rev}`, expiresAt: 'x' } });

describe('SessionClient REST', () => {
  it('bootstrap GETs /session/device/state and applies it', async () => {
    const makeRequest = jest.fn().mockResolvedValueOnce(SYNC(3));
    const host = makeHost(makeRequest);
    const c = new SessionClient(host);
    await c.bootstrap();
    expect(makeRequest).toHaveBeenCalledWith('GET', '/session/device/state', undefined, { cache: false });
    expect(c.getState()?.revision).toBe(3);
    expect(host.setTokens).toHaveBeenCalledWith('jwt-3');
  });

  it('switchAccount POSTs and applies the returned state', async () => {
    const makeRequest = jest.fn().mockResolvedValueOnce(SYNC(4));
    const host = makeHost(makeRequest);
    const c = new SessionClient(host);
    await c.switchAccount('a1');
    expect(makeRequest).toHaveBeenCalledWith('POST', '/session/device/switch', { accountId: 'a1' }, { cache: false });
    expect(c.getState()?.revision).toBe(4);
    expect(host.setTokens).toHaveBeenCalledWith('jwt-4');
    c.stop();
  });

  it('signOut one account POSTs { accountId }', async () => {
    const makeRequest = jest.fn().mockResolvedValueOnce(SYNC(5));
    const c = new SessionClient(makeHost(makeRequest));
    await c.signOut({ accountId: 'a1' });
    expect(makeRequest).toHaveBeenCalledWith('POST', '/session/device/signout', { accountId: 'a1' }, { cache: false });
    c.stop();
  });

  it('signOut all POSTs { all: true }', async () => {
    const makeRequest = jest.fn().mockResolvedValueOnce(SYNC(6));
    const c = new SessionClient(makeHost(makeRequest));
    await c.signOut({ all: true });
    expect(makeRequest).toHaveBeenCalledWith('POST', '/session/device/signout', { all: true }, { cache: false });
    c.stop();
  });

  it('addCurrentAccount POSTs /session/device/add with no body', async () => {
    const makeRequest = jest.fn().mockResolvedValueOnce(SYNC(2));
    const c = new SessionClient(makeHost(makeRequest));
    await c.addCurrentAccount();
    expect(makeRequest).toHaveBeenCalledWith('POST', '/session/device/add', undefined, { cache: false });
    c.stop();
  });

  it('does not throw / does not apply when the server returns invalid state', async () => {
    const makeRequest = jest.fn().mockResolvedValueOnce({ bogus: true });
    const c = new SessionClient(makeHost(makeRequest));
    await c.bootstrap();
    expect(c.getState()).toBeNull();
  });

  it('applies state but does not plant a token when activeToken is null', async () => {
    const makeRequest = jest.fn().mockResolvedValueOnce({ state: STATE(7), activeToken: null });
    const host = makeHost(makeRequest);
    const c = new SessionClient(host);
    await c.bootstrap();
    expect(c.getState()?.revision).toBe(7);
    expect(host.setTokens).not.toHaveBeenCalled();
  });

  it('accepts a NEW device\'s lower-revision state and plants its token (cross-device revision reset)', async () => {
    const deviceA: DeviceSessionState = {
      deviceId: 'A', accounts: [{ accountId: 'a1', sessionId: 's1', authuser: 0 }], activeAccountId: 'a1', revision: 10, updatedAt: 1720000000000,
    };
    const deviceB: DeviceSessionState = {
      deviceId: 'B', accounts: [{ accountId: 'a2', sessionId: 's2', authuser: 0 }], activeAccountId: 'a2', revision: 1, updatedAt: 1720000001000,
    };
    const makeRequest = jest.fn()
      .mockResolvedValueOnce({ state: deviceA, activeToken: { accessToken: 'jwt-A', expiresAt: 'x' } })
      .mockResolvedValueOnce({ state: deviceB, activeToken: { accessToken: 'jwt-B', expiresAt: 'x' } });
    const host = makeHost(makeRequest);
    const c = new SessionClient(host);

    await c.bootstrap();
    expect(c.getState()?.deviceId).toBe('A');
    expect(host.setTokens).toHaveBeenLastCalledWith('jwt-A');

    // Device B is freshly converged (revision 1) — it must win over device A's
    // stale-but-higher revision, and its token must be planted.
    await c.bootstrap();
    expect(c.getState()?.deviceId).toBe('B');
    expect(c.getState()?.revision).toBe(1);
    expect(host.setTokens).toHaveBeenLastCalledWith('jwt-B');
  });
});
