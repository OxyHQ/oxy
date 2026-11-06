import type { DeviceSessionState } from '@oxy.so/contracts';

type Handler = (...args: unknown[]) => void;
class FakeSocket {
  connected = false;
  handlers = new Map<string, Handler[]>();
  on(event: string, cb: Handler) {
    const l = this.handlers.get(event) ?? [];
    l.push(cb);
    this.handlers.set(event, l);
  }
  off(event: string, cb?: Handler) {
    if (!cb) {
      this.handlers.delete(event);
      return;
    }
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((h) => h !== cb),
    );
  }
  connect() {
    this.connected = true;
    this.trigger('connect');
  }
  disconnect() {
    this.connected = false;
  }
  trigger(event: string, ...args: unknown[]) {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
}
let fakeSocket: FakeSocket;
const ioMock = jest.fn((_uri: string, opts?: Record<string, unknown>) => {
  // honor autoConnect like real socket.io (connect immediately unless autoConnect:false)
  if (!opts || opts.autoConnect !== false) fakeSocket.connected = true;
  return fakeSocket;
});
jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: (...args: unknown[]) => ioMock(...(args as [string, Record<string, unknown>?])),
}));

import { SessionClient, type SessionClientHost } from '../SessionClient';

const STATE = (rev: number): DeviceSessionState => ({
  deviceId: 'd1',
  accounts: [{ accountId: 'a1', sessionId: 's1', authuser: 0 }],
  activeAccountId: 'a1',
  revision: rev,
  updatedAt: 1720000000000,
});
// `makeRequest` (HttpService) already strips the server's outer `{ data }` envelope, so it
// returns the unwrapped sync body directly — that is exactly what SessionClient consumes.
const SYNC = (rev: number) => ({
  state: STATE(rev),
  activeToken: { accessToken: `jwt-${rev}`, expiresAt: 'x' },
});

function makeHost(over: Partial<SessionClientHost> = {}): SessionClientHost {
  return {
    makeRequest: jest.fn().mockResolvedValue(SYNC(1)),
    getBaseURL: () => 'http://test.invalid',
    getAccessToken: () => 'tok',
    getDeviceCredential: () => null,
    onTokensChanged: () => () => undefined,
    setTokens: jest.fn(),
    getCurrentAccountId: () => 'a1',
    ...over,
  };
}

beforeEach(() => {
  fakeSocket = new FakeSocket();
  ioMock.mockClear();
});

describe('SessionClient socket', () => {
  it('ignores a previously registered socket callback after local isolation and a later device', async () => {
    const host = makeHost();
    const client = new SessionClient(host);
    await client.start();
    const oldCallback = fakeSocket.handlers.get('session_state')?.[0];
    if (!oldCallback) throw new Error('Expected a registered session_state callback');
    client.resetLocalState();
    client.adoptState(STATE(2));
    (host.setTokens as jest.Mock).mockClear();
    (host.makeRequest as jest.Mock).mockClear();
    oldCallback(STATE(99));
    await Promise.resolve();
    expect(client.getState()?.revision).toBe(2);
    expect(host.setTokens).not.toHaveBeenCalled();
    expect(host.makeRequest).not.toHaveBeenCalled();
    client.stop();
  });

  it('start() bootstraps then opens ONE socket to the base URL with a token-in-handshake auth callback', async () => {
    const host = makeHost();
    const c = new SessionClient(host);
    await c.start();
    expect(host.makeRequest).toHaveBeenCalledWith('GET', '/session/device/state', undefined, {
      cache: false,
    });
    expect(ioMock).toHaveBeenCalledTimes(1);
    const [uri, opts] = ioMock.mock.calls[0];
    expect(uri).toBe('http://test.invalid');
    const authCb = jest.fn();
    (opts?.auth as (cb: (d: { token: string }) => void) => void)(authCb);
    expect(authCb).toHaveBeenCalledWith({ token: 'tok' });
    c.stop();
  });

  it('applies a pushed session_state event', async () => {
    const c = new SessionClient(makeHost());
    await c.start();
    fakeSocket.trigger('session_state', STATE(9));
    expect(c.getState()?.revision).toBe(9);
    c.stop();
  });

  it('fetches the active token via bootstrap when a pushed state changes the active account', async () => {
    const makeRequest = jest.fn().mockResolvedValue(SYNC(1));
    const host = makeHost({ makeRequest, getCurrentAccountId: () => 'other-account' });
    const c = new SessionClient(host);
    await c.start();
    makeRequest.mockClear();
    fakeSocket.trigger('session_state', STATE(9));
    await Promise.resolve();
    expect(makeRequest).toHaveBeenCalledWith('GET', '/session/device/state', undefined, {
      cache: false,
    });
    c.stop();
  });

  it('C1 regression: plants the active token on a socket-pushed switch even when the post-push bootstrap returns the SAME revision as the push', async () => {
    const setTokens = jest.fn();
    const makeRequest = jest
      .fn()
      .mockResolvedValueOnce(SYNC(1)) // initial bootstrap in start()
      .mockResolvedValue(SYNC(9)); // post-push bootstrap: same revision as the socket push below
    const host = makeHost({ makeRequest, setTokens, getCurrentAccountId: () => 'other-account' });
    const c = new SessionClient(host);
    await c.start();
    makeRequest.mockClear();
    setTokens.mockClear();
    fakeSocket.trigger('session_state', STATE(9));
    await Promise.resolve();
    await Promise.resolve();
    expect(makeRequest).toHaveBeenCalledWith('GET', '/session/device/state', undefined, {
      cache: false,
    });
    expect(setTokens).toHaveBeenCalledWith('jwt-9');
    c.stop();
  });

  it('does not re-fetch when the pushed active account matches the host-held account', async () => {
    const makeRequest = jest.fn().mockResolvedValue(SYNC(1));
    const host = makeHost({ makeRequest, getCurrentAccountId: () => 'a1' });
    const c = new SessionClient(host);
    await c.start();
    makeRequest.mockClear();
    fakeSocket.trigger('session_state', STATE(9));
    await Promise.resolve();
    expect(makeRequest).not.toHaveBeenCalled();
    c.stop();
  });

  it('audits a socket switch between two operators of the same account', async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const nateToken = `h.${encode({ userId: 'org', sessionId: 'session-nate', act: { sub: 'nate' }, exp: 4102444800 })}.s`;
    let bearer = nateToken;
    let revision = 1;
    const state = (rev: number): DeviceSessionState => ({
      deviceId: 'd1', revision: rev, updatedAt: 1720000000000,
      activeAccountId: 'org',
      accounts: [
        { accountId: 'org', sessionId: 'session-nate', authuser: 0, operatedByUserId: 'nate' },
        { accountId: 'org', sessionId: 'session-alice', authuser: 1, operatedByUserId: 'alice' },
      ],
    });
    const directory = () => ({
      deviceId: 'd1', revision, updatedAt: 1720000000000,
      activeContextId: revision === 1 ? 'ctx-nate-org' : 'ctx-alice-org',
      principals: ['nate', 'alice'].map((name, index) => ({
        id: `p-${name}`, userId: name, authuser: index, user: { id: name, username: name },
        contexts: [{ id: `ctx-${name}-org`, accountId: 'org', kind: 'organization', relationship: 'member',
          account: { id: 'org', username: 'org' }, onDevice: true, available: true,
          active: name === (revision === 1 ? 'nate' : 'alice'), lastUsedAt: null }],
      })),
    });
    const makeRequest = jest.fn(async (_method: string, path: string) => {
      if (path === '/session/device/state') return { state: state(1), activeToken: { accessToken: nateToken, expiresAt: 'x' } };
      if (path === '/session/device/directory') return directory();
      throw new Error(`Unexpected path ${path}`);
    });
    const host = makeHost({
      makeRequest: makeRequest as SessionClientHost['makeRequest'],
      getAccessToken: () => bearer,
      setTokens: (token) => { bearer = token; },
      getCurrentAccountId: () => 'org',
    });
    const ensureActiveToken = jest.fn(async () => undefined);
    const client = new SessionClient(host, { transport: { ensureActiveToken } });
    await client.start();
    await client.refreshDirectory();
    expect(client.getActiveContext()?.actor.userId).toBe('nate');
    makeRequest.mockClear();
    revision = 2;
    fakeSocket.trigger('session_state', state(2));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(client.getActiveContext()?.actor.userId).toBe('alice');
    expect(host.getAccessToken()).toBe(nateToken);
    expect(ensureActiveToken).toHaveBeenCalledWith(state(2));
    expect(makeRequest.mock.calls.map((args) => args[1])).toEqual(['/session/device/directory']);
    client.stop();
  });

  it('audits a stale bootstrap token after a newer same-account operator switch', async () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const jwt = (actor: string) => `h.${encode({ userId: 'org', sessionId: `session-${actor}`, exp: 4102444800 })}.s`;
    const nate = jwt('nate');
    const alice = jwt('alice');
    const state = (revision: number): DeviceSessionState => ({
      deviceId: 'd1', revision, updatedAt: 1720000000000, activeAccountId: 'org',
      accounts: [
        { accountId: 'org', sessionId: 'session-nate', authuser: 0, operatedByUserId: 'nate' },
        { accountId: 'org', sessionId: 'session-alice', authuser: 1, operatedByUserId: 'alice' },
      ],
    });
    const sync = (revision: number, accessToken: string) => ({ state: state(revision), activeToken: { accessToken, expiresAt: 'x' } });
    let releaseOld!: (value: unknown) => void;
    const old = new Promise((resolve) => { releaseOld = resolve; });
    const makeRequest = jest.fn().mockResolvedValueOnce(sync(1, nate)).mockReturnValueOnce(old).mockResolvedValue(sync(2, alice));
    let token = nate;
    const host = makeHost({ makeRequest, getAccessToken: () => token, setTokens: (value) => { token = value; }, getCurrentAccountId: () => 'org' });
    const client = new SessionClient(host);
    try {
      await client.start();
      const pendingOld = client.bootstrap();
      fakeSocket.trigger('session_state', state(2));
      await client.bootstrap();
      expect(token).toBe(alice);
      expect(client.getState()?.revision).toBe(2);
      releaseOld(sync(1, nate));
      await pendingOld;
      expect(client.getState()?.revision).toBe(2);
      expect(token).toBe(nate);
    } finally { client.stop(); }
  });

  it('does not open a socket at all when signed out (bearer-only)', async () => {
    const c = new SessionClient(makeHost({ getAccessToken: () => null }));
    await c.start();
    expect(ioMock).not.toHaveBeenCalled();
    c.stop();
  });

  it('reconnects an existing socket when a fresh token arrives after a transient drop', async () => {
    const listeners: Array<(t: string | null) => void> = [];
    const host = makeHost({
      onTokensChanged: (l) => {
        listeners.push(l);
        return () => undefined;
      },
    });
    const c = new SessionClient(host);
    await c.start();
    expect(fakeSocket.connected).toBe(true); // authenticated connect on start
    fakeSocket.connected = false; // simulate a transient socket drop
    for (const l of listeners) l('fresh-token');
    expect(fakeSocket.connected).toBe(true);
    c.stop();
  });

  it('stop() disconnects the socket', async () => {
    const c = new SessionClient(makeHost());
    await c.start();
    c.stop();
    expect(fakeSocket.connected).toBe(false);
  });

  it('session_accounts_changed for the current user refetches device state (GET /session/device/state)', async () => {
    const makeRequest = jest.fn().mockResolvedValue(SYNC(1));
    const host = makeHost({ makeRequest, getCurrentAccountId: () => 'a1' });
    const c = new SessionClient(host);
    await c.start();
    makeRequest.mockClear();
    fakeSocket.trigger('session_accounts_changed', { userId: 'a1', revision: 5, reason: 'add' });
    await Promise.resolve();
    expect(makeRequest).toHaveBeenCalledWith('GET', '/session/device/state', undefined, {
      cache: false,
    });
    c.stop();
  });

  it('session_accounts_changed for a DIFFERENT user is ignored (no refetch)', async () => {
    const makeRequest = jest.fn().mockResolvedValue(SYNC(1));
    const host = makeHost({ makeRequest, getCurrentAccountId: () => 'a1' });
    const c = new SessionClient(host);
    await c.start();
    makeRequest.mockClear();
    fakeSocket.trigger('session_accounts_changed', {
      userId: 'someone-else',
      revision: 5,
      reason: 'switch',
    });
    await Promise.resolve();
    expect(makeRequest).not.toHaveBeenCalled();
    c.stop();
  });

  it('session_accounts_changed drops a malformed payload without refetching', async () => {
    const makeRequest = jest.fn().mockResolvedValue(SYNC(1));
    const host = makeHost({ makeRequest, getCurrentAccountId: () => 'a1' });
    const c = new SessionClient(host);
    await c.start();
    makeRequest.mockClear();
    fakeSocket.trigger('session_accounts_changed', { userId: 'a1', reason: 'not-a-real-reason' });
    await Promise.resolve();
    expect(makeRequest).not.toHaveBeenCalled();
    c.stop();
  });

  it('a socket-pushed empty state fires onUnauthenticated with the PUSH origin (bug #4)', async () => {
    const onUnauthenticated = jest.fn();
    const c = new SessionClient(makeHost(), { onUnauthenticated });
    await c.start();

    const EMPTY: DeviceSessionState = {
      deviceId: 'd1',
      accounts: [],
      activeAccountId: null,
      revision: 9,
      updatedAt: 1720000000001,
    };
    fakeSocket.trigger('session_state', EMPTY);

    expect(onUnauthenticated).toHaveBeenCalledWith('push');
    c.stop();
  });

  it('a REST signOut-all empty response fires onUnauthenticated with the REQUEST origin', async () => {
    const onUnauthenticated = jest.fn();
    const EMPTY_SYNC = {
      state: {
        deviceId: 'd1',
        accounts: [],
        activeAccountId: null,
        revision: 9,
        updatedAt: 1720000000001,
      },
      activeToken: null,
    };
    // bootstrap during start() returns a populated state; the signout (and any
    // stray reconcile) returns empty.
    const makeRequest = jest.fn().mockResolvedValue(EMPTY_SYNC).mockResolvedValueOnce(SYNC(1));
    const c = new SessionClient(makeHost({ makeRequest }), { onUnauthenticated });
    await c.start();

    await c.signOut({ all: true });
    // Flush any fire-and-forget post-commit reconcile before asserting/teardown.
    await Promise.resolve();

    expect(onUnauthenticated).toHaveBeenCalledWith('request');
    c.stop();
  });
});
