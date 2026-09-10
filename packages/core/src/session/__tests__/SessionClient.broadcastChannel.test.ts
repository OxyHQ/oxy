/**
 * SessionClient same-origin `BroadcastChannel` cross-tab state propagation.
 *
 * This is the AUTHENTICATED-only survivor of the zero-cookie cutover: when one
 * authenticated tab commits an account switch / sign-out, same-origin siblings
 * re-sync their device state instantly without waiting on the socket. The
 * signed-out "self-acquire on sibling sign-in" wake is gone (sockets are now
 * bearer-only), so every case here runs with a bearer present.
 */
import type { DeviceSessionState } from '@oxy.so/contracts';

type Handler = (...args: unknown[]) => void;
class FakeSocket {
  connected = false;
  handlers = new Map<string, Handler[]>();
  on(event: string, cb: Handler) { const l = this.handlers.get(event) ?? []; l.push(cb); this.handlers.set(event, l); }
  off(event: string, cb?: Handler) { if (!cb) { this.handlers.delete(event); return; } this.handlers.set(event, (this.handlers.get(event) ?? []).filter((h) => h !== cb)); }
  connect() { this.connected = true; this.trigger('connect'); }
  disconnect() { this.connected = false; }
  trigger(event: string, ...args: unknown[]) { for (const h of this.handlers.get(event) ?? []) h(...args); }
}
let fakeSocket: FakeSocket;
const ioMock = jest.fn((_uri: string, opts?: Record<string, unknown>) => {
  if (!opts || opts.autoConnect !== false) fakeSocket.connected = true;
  return fakeSocket;
});
jest.mock('socket.io-client', () => ({ __esModule: true, io: (...args: unknown[]) => ioMock(...(args as [string, Record<string, unknown>?])) }));

// A same-name in-process BroadcastChannel bus: postMessage delivers to every
// OTHER open channel of the same name (never the sender) — matching the spec.
type BusEntry = { name: string; onmessage: ((event: { data: unknown }) => void) | null };
const bus = new Set<BusEntry>();
class FakeBroadcastChannel {
  private entry: BusEntry;
  constructor(public name: string) { this.entry = { name, onmessage: null }; bus.add(this.entry); }
  get onmessage(): ((event: { data: unknown }) => void) | null { return this.entry.onmessage; }
  set onmessage(cb: ((event: { data: unknown }) => void) | null) { this.entry.onmessage = cb; }
  postMessage(data: unknown) {
    for (const e of bus) {
      if (e === this.entry || e.name !== this.name) continue;
      e.onmessage?.({ data });
    }
  }
  close() { bus.delete(this.entry); }
}

import { SessionClient, type SessionClientHost } from '../SessionClient';

const STATE = (rev: number, accounts = [{ accountId: 'a1', sessionId: 's1', authuser: 0 }]): DeviceSessionState =>
  ({ deviceId: 'd1', accounts, activeAccountId: accounts[0]?.accountId ?? null, revision: rev, updatedAt: 1720000000000 });
const SYNC = (rev: number) => ({ state: STATE(rev), activeToken: { accessToken: `jwt-${rev}`, expiresAt: 'x' } });

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

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => {
  fakeSocket = new FakeSocket();
  ioMock.mockClear();
  bus.clear();
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeBroadcastChannel as unknown;
});
afterEach(() => {
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
});

describe('SessionClient BroadcastChannel cross-tab re-sync (authenticated)', () => {
  it('a local mutation wakes an authenticated same-origin sibling to re-sync (bootstrap)', async () => {
    const bMakeRequest = jest.fn().mockResolvedValue(SYNC(1));
    const b = new SessionClient(makeHost({ makeRequest: bMakeRequest, getAccessToken: () => 'tok-b' }), {});
    await b.start();
    bMakeRequest.mockClear();
    const a = new SessionClient(makeHost({ getAccessToken: () => 'tok-a' }), {});
    await a.start();
    await a.addCurrentAccount();
    await flush();
    expect(bMakeRequest).toHaveBeenCalledWith('GET', '/session/device/state', undefined, { cache: false });
    a.stop();
    b.stop();
  });

  it('does not re-sync the posting tab from its own commit ping (no self-loop)', async () => {
    const makeRequest = jest.fn().mockResolvedValue(SYNC(1));
    const a = new SessionClient(makeHost({ makeRequest, getAccessToken: () => 'tok-a' }), {});
    await a.start();
    makeRequest.mockClear();
    // `addCurrentAccount` POSTs then posts a commit ping; the ping never echoes
    // to the sender, so this tab must NOT re-fetch its own device state.
    await a.addCurrentAccount();
    await flush();
    expect(makeRequest).not.toHaveBeenCalledWith('GET', '/session/device/state', undefined, { cache: false });
    a.stop();
  });

  it('is a no-op on platforms without BroadcastChannel (native)', async () => {
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
    const c = new SessionClient(makeHost({ getAccessToken: () => 'tok' }), {});
    await c.start();
    // Mutations must not throw when BroadcastChannel is absent.
    await expect(c.switchAccount('a1')).resolves.toBeUndefined();
    c.stop();
  });
});
