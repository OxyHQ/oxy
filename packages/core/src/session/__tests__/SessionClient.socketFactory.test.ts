import type { DeviceSessionState } from '@oxy.so/contracts';
import * as socketLoader from '../socketLoader';
import type { MinimalSocket, SocketIOFactory } from '../socketLoader';
import { SessionClient, type SessionClientHost } from '../SessionClient';

/**
 * P0 (bundler-fragility): SessionClient must NOT depend on a runtime dynamic
 * `import('socket.io-client')` when a consumer (services/auth-sdk) injects the
 * `io` factory statically. These tests pin the two branches of `connectSocket`:
 *
 *  1. `socketFactory` injected  → the injected factory is used and the lazy
 *     loader (`getSocketIO`) is NEVER invoked (the exact call that fails in the
 *     Metro/Expo-web + Vite published-dist consumers).
 *  2. no `socketFactory`        → the lazy loader IS invoked (fallback).
 */

type Handler = (...args: unknown[]) => void;
class FakeSocket implements MinimalSocket {
  connected = false;
  handlers = new Map<string, Handler[]>();
  on(event: string, cb: Handler) { const l = this.handlers.get(event) ?? []; l.push(cb); this.handlers.set(event, l); }
  off(event: string, cb?: Handler) { if (!cb) { this.handlers.delete(event); return; } this.handlers.set(event, (this.handlers.get(event) ?? []).filter((h) => h !== cb)); }
  emit(_event: string, ..._args: unknown[]) { /* no-op: device socket never emits */ }
  connect() { this.connected = true; }
  disconnect() { this.connected = false; }
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

describe('SessionClient injected socketFactory', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('uses the injected factory and NEVER invokes the lazy loader', async () => {
    const loaderSpy = jest.spyOn(socketLoader, 'getSocketIO');
    let created: FakeSocket | null = null;
    const factory: SocketIOFactory = jest.fn((_uri: string) => {
      created = new FakeSocket();
      created.connected = true;
      return created;
    });

    const client = new SessionClient(makeHost(), { socketFactory: factory });
    await client.start();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('http://test.invalid', expect.objectContaining({ transports: ['websocket'] }));
    expect(loaderSpy).not.toHaveBeenCalled();
    expect(created).not.toBeNull();
    client.stop();
  });

  it('falls back to the lazy loader when no factory is injected', async () => {
    const fake = new FakeSocket();
    fake.connected = true;
    const lazyFactory: SocketIOFactory = jest.fn(() => fake);
    const loaderSpy = jest.spyOn(socketLoader, 'getSocketIO').mockResolvedValue(lazyFactory);

    const client = new SessionClient(makeHost());
    await client.start();

    expect(loaderSpy).toHaveBeenCalledTimes(1);
    expect(lazyFactory).toHaveBeenCalledWith('http://test.invalid', expect.objectContaining({ transports: ['websocket'] }));
    client.stop();
  });
});
