import { SessionClient } from '@oxy.so/core';

type Handler = (...args: unknown[]) => void;
class FakeSocket {
  connected = false;
  on(_event: string, _cb: Handler) {}
  off(_event: string, _cb?: Handler) {}
  connect() { this.connected = true; }
  disconnect() { this.connected = false; }
}
const ioMock = jest.fn((_uri: string, _opts?: Record<string, unknown>) => new FakeSocket());
// Core loads socket.io-client only when `start()` needs realtime transport. This
// mock proves the services factory keeps that boundary lazy.
jest.mock('socket.io-client', () => ({ __esModule: true, io: (...args: unknown[]) => ioMock(...(args as [string, Record<string, unknown>?])) }));

import { createSessionClient } from '../createSessionClient';

// Sockets are bearer-only: `start()` opens a socket only when a bearer token is
// held. This mock reports one so the wiring test exercises the socket factory.
function fakeOxy() {
  const listeners = new Set<(t: string | null) => void>();
  return {
    makeRequest: jest.fn().mockResolvedValue(undefined),
    getBaseURL: jest.fn().mockReturnValue('https://api.oxy.so'),
    getAccessToken: jest.fn().mockReturnValue('bearer.jwt.token'),
    setTokens: jest.fn(),
    onTokensChanged: jest.fn((l: (t: string | null) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    }),
  };
}

describe('createSessionClient', () => {
  test('wires a SessionClient instance backed by the host + device-first token transport', () => {
    const oxy = fakeOxy();

    const { client, host } = createSessionClient(oxy as never);

    expect(client).toBeInstanceOf(SessionClient);
    expect(typeof client.bootstrap).toBe('function');
    expect(client.getState()).toBeNull();
    expect(typeof host.setCurrentAccountId).toBe('function');
  });

  test('the returned host reflects setCurrentAccountId', () => {
    const oxy = fakeOxy();

    const { host } = createSessionClient(oxy as never);

    expect(host.getCurrentAccountId()).toBeNull();
    host.setCurrentAccountId('u1');
    expect(host.getCurrentAccountId()).toBe('u1');
  });

  test('loads socket.io only when start() opens realtime transport', async () => {
    ioMock.mockClear();
    const oxy = fakeOxy();

    const { client } = createSessionClient(oxy as never);
    await client.start();

    // The lazily-loaded `io` opens the session socket at the base URL.
    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(ioMock).toHaveBeenCalledWith('https://api.oxy.so', expect.objectContaining({ transports: ['websocket'] }));
    client.stop();
  });

  test('passes onUnauthenticated through to the SessionClient', async () => {
    ioMock.mockClear();
    const oxy = fakeOxy();
    const onUnauthenticated = jest.fn();

    const { client } = createSessionClient(oxy as never, onUnauthenticated);

    // The client was constructed with the callback (no direct getter is exposed;
    // constructing without throwing + wiring the socket factory is the contract
    // this factory owns — the callback firing on a zero-account applied state is
    // covered by @oxy.so/core's SessionClient tests).
    expect(client).toBeInstanceOf(SessionClient);
    await client.start();
    expect(ioMock).toHaveBeenCalledTimes(1);
    client.stop();
  });

  test('threads the pinned-account resolver through: a pinned registerAndActivate only ADDS', async () => {
    // `sessionMode: 'identity'`. The pin reaching `SessionClient` is observable
    // here: a pinned client's own session is minted for the pinned account
    // explicitly, so registering it must never SWITCH the shared device session
    // (which would re-elect the active account under every other app on it).
    const oxy = fakeOxy();

    const { client } = createSessionClient(oxy as never, undefined, () => 'pinned-account');
    await client.registerAndActivate('pinned-account');

    const paths = oxy.makeRequest.mock.calls.map((call) => call[1]);
    expect(paths).toContain('/session/device/add');
    expect(paths).not.toContain('/session/device/switch');
  });

  test('a resolver reporting no pin (account mode) leaves registerAndActivate switching', async () => {
    const oxy = fakeOxy();

    const { client } = createSessionClient(oxy as never, undefined, () => null);
    await client.registerAndActivate('u1');

    const paths = oxy.makeRequest.mock.calls.map((call) => call[1]);
    expect(paths).toContain('/session/device/add');
    expect(paths).toContain('/session/device/switch');
  });
});
