import type { DeviceSessionState } from '@oxy.so/contracts';
import type { MinimalSocket, SocketIOFactory } from '../socketLoader';
import { SessionClient, type SessionClientHost } from '../SessionClient';

type Handler = (...args: unknown[]) => void;
class FakeSocket implements MinimalSocket {
  connected = false;
  handlers = new Map<string, Handler[]>();
  on(event: string, cb: Handler) { const l = this.handlers.get(event) ?? []; l.push(cb); this.handlers.set(event, l); }
  off(event: string, cb?: Handler) { if (!cb) { this.handlers.delete(event); return; } this.handlers.set(event, (this.handlers.get(event) ?? []).filter((h) => h !== cb)); }
  emit(_event: string, ..._args: unknown[]) { /* client→server emit, unused here */ }
  connect() { this.connected = true; }
  disconnect() { this.connected = false; }
  emitServer(event: string, payload: unknown) { for (const h of this.handlers.get(event) ?? []) h(payload); }
}

const STATE = (rev: number): DeviceSessionState => ({ deviceId: 'd1', accounts: [{ accountId: 'a1', sessionId: 's1', authuser: 0 }], activeAccountId: 'a1', revision: rev, updatedAt: 1720000000000 });
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

describe('SessionClient.onServerEvent', () => {
  it('delivers a server event to a listener registered BEFORE the socket exists', async () => {
    let created: FakeSocket | null = null;
    const factory: SocketIOFactory = jest.fn(() => { created = new FakeSocket(); created.connected = true; return created; });
    const client = new SessionClient(makeHost(), { socketFactory: factory });
    const seen: unknown[] = [];
    client.onServerEvent('civic:attested', (p) => seen.push(p));
    await client.start();
    created?.emitServer('civic:attested', { byUserId: 'u2' });
    expect(seen).toEqual([{ byUserId: 'u2' }]);
    client.stop();
  });

  it('delivers to a listener registered AFTER the socket exists, and unsubscribe stops delivery', async () => {
    let created: FakeSocket | null = null;
    const factory: SocketIOFactory = jest.fn(() => { created = new FakeSocket(); created.connected = true; return created; });
    const client = new SessionClient(makeHost(), { socketFactory: factory });
    await client.start();
    const seen: unknown[] = [];
    const unsub = client.onServerEvent('civic:attested', (p) => seen.push(p));
    created?.emitServer('civic:attested', 1);
    unsub();
    created?.emitServer('civic:attested', 2);
    expect(seen).toEqual([1]);
    client.stop();
  });

  it('one listener throwing does not break the others', async () => {
    let created: FakeSocket | null = null;
    const factory: SocketIOFactory = jest.fn(() => { created = new FakeSocket(); created.connected = true; return created; });
    const client = new SessionClient(makeHost(), { socketFactory: factory });
    await client.start();
    const seen: unknown[] = [];
    client.onServerEvent('civic:attested', () => { throw new Error('boom'); });
    client.onServerEvent('civic:attested', (p) => seen.push(p));
    created?.emitServer('civic:attested', 'ok');
    expect(seen).toEqual(['ok']);
    client.stop();
  });
});
