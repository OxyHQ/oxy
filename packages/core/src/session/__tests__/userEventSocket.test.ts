import { createUserEventSocket } from '../userEventSocket';
import type { MinimalSocket, SocketIOFactory } from '../socketLoader';

interface FakeSocket extends MinimalSocket {
  handlers: Map<string, (payload: unknown) => void>;
  auth: (cb: (data: Record<string, string>) => void) => void;
  disconnect: jest.Mock;
}

function harness() {
  let token: string | null = null;
  const sockets: FakeSocket[] = [];
  const factory: SocketIOFactory = (_uri, opts) => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const socket: FakeSocket = {
      connected: true,
      handlers,
      auth: (opts as { auth: FakeSocket['auth'] }).auth,
      on: (event, handler) => {
        handlers.set(event, handler as (payload: unknown) => void);
      },
      off: () => undefined,
      emit: () => undefined,
      connect: () => undefined,
      disconnect: jest.fn(),
    };
    sockets.push(socket);
    return socket;
  };
  const socket = createUserEventSocket({
    baseURL: 'https://api.example.test',
    getAccessToken: () => token,
    socketFactory: factory,
  });
  return {
    socket,
    sockets,
    setToken: (next: string | null) => {
      token = next;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createUserEventSocket', () => {
  it('opens nothing without a bearer', async () => {
    const { socket, sockets } = harness();
    socket.sync();
    await flush();
    expect(sockets).toHaveLength(0);
  });

  it('authenticates each handshake with the current bearer and delivers events', async () => {
    const { socket, sockets, setToken } = harness();
    const received: unknown[] = [];
    socket.onServerEvent('supervision_changed', (payload) => received.push(payload));
    setToken('token-a');
    socket.sync();
    await flush();
    expect(sockets).toHaveLength(1);
    const auth = jest.fn();
    setToken('token-b');
    sockets[0].auth(auth);
    expect(auth).toHaveBeenCalledWith({ token: 'token-b' });
    sockets[0].handlers.get('supervision_changed')?.({ n: 1 });
    expect(received).toEqual([{ n: 1 }]);
    // The device's own state is never asked for on this socket.
    expect(sockets[0].handlers.has('session_state')).toBe(false);
  });

  it('closes when the bearer goes and reopens for the next account on restart', async () => {
    const { socket, sockets, setToken } = harness();
    const received: unknown[] = [];
    socket.onServerEvent('notification', (payload) => received.push(payload));
    setToken('token-a');
    socket.sync();
    await flush();
    socket.restart();
    await flush();
    expect(sockets).toHaveLength(2);
    expect(sockets[0].disconnect).toHaveBeenCalled();
    sockets[1].handlers.get('notification')?.('hi');
    expect(received).toEqual(['hi']);
    setToken(null);
    socket.sync();
    expect(sockets[1].disconnect).toHaveBeenCalled();
  });

  it('opens again after a stop (a remount)', async () => {
    const { socket, sockets, setToken } = harness();
    setToken('token-a');
    socket.sync();
    await flush();
    socket.stop();
    expect(sockets[0].disconnect).toHaveBeenCalled();
    socket.sync();
    await flush();
    expect(sockets).toHaveLength(2);
  });
});
