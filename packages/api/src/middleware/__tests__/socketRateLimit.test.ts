import { createSocketRateLimiter } from '../socketRateLimit';
import type { Socket } from 'socket.io';

// Minimal Socket mock that satisfies the subset of Socket used by the rate limiter.
// The middleware function only uses: socket.id, socket.use, socket.on, socket.emit, socket.disconnect.
// We extend a partial Socket and add test helpers.
type MiddlewareFn = (packet: unknown[], next: jest.Mock) => void;
type EventListener = (...args: unknown[]) => void;

interface MockSocketHelpers {
  _fireEvent(packet?: unknown[]): jest.Mock;
  _fireDisconnect(): void;
}

type MockSocket = Pick<Socket, 'id'> & {
  use: jest.Mock;
  on: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
} & MockSocketHelpers;

function createMockSocket(id = 'socket-1'): MockSocket {
  const listeners: Record<string, EventListener[]> = {};
  const middlewares: MiddlewareFn[] = [];
  return {
    id,
    use: jest.fn((fn: MiddlewareFn) => {
      middlewares.push(fn);
    }),
    on: jest.fn((event: string, fn: EventListener) => {
      (listeners[event] ??= []).push(fn);
    }),
    emit: jest.fn(),
    disconnect: jest.fn(),
    _fireEvent(packet: unknown[] = ['test']) {
      const mw = middlewares[0];
      if (!mw) throw new Error('No middleware installed');
      const next = jest.fn();
      mw(packet, next);
      return next;
    },
    _fireDisconnect() {
      (listeners['disconnect'] ?? []).forEach((fn) => fn());
    },
  };
}

/**
 * Wraps a mock socket for use with the rate limiter middleware.
 * The mock implements all Socket properties accessed by the middleware
 * (id, use, on, emit, disconnect).
 */
function toSocket(mock: MockSocket): Socket {
  // The middleware only accesses a small subset of Socket properties.
  // The mock provides all of them, so this structural cast is safe.
  const socketLike: Record<string, unknown> = mock;
  return socketLike as Socket;
}

describe('createSocketRateLimiter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('allows events under the limit', () => {
    const middleware = createSocketRateLimiter(5, 10_000);
    const socket = createMockSocket();
    const next = jest.fn();

    // Connect
    middleware(toSocket(socket), next);
    expect(next).toHaveBeenCalled();
    expect(socket.use).toHaveBeenCalled();

    // Send 5 events — all should pass
    for (let i = 0; i < 5; i++) {
      const ackNext = socket._fireEvent();
      expect(ackNext).toHaveBeenCalled();
    }

    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects when limit is exceeded', () => {
    const middleware = createSocketRateLimiter(3, 10_000);
    const socket = createMockSocket();
    middleware(toSocket(socket), jest.fn());

    // Send 3 events — OK
    for (let i = 0; i < 3; i++) {
      socket._fireEvent();
    }

    // 4th event — exceeds limit
    const ackNext = socket._fireEvent();
    expect(ackNext).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('resets counter after window expires', () => {
    const middleware = createSocketRateLimiter(3, 1_000);
    const socket = createMockSocket();
    middleware(toSocket(socket), jest.fn());

    // Use up all 3
    for (let i = 0; i < 3; i++) {
      socket._fireEvent();
    }

    // Advance past the window
    jest.advanceTimersByTime(1_100);

    // Should be allowed again
    const ackNext = socket._fireEvent();
    expect(ackNext).toHaveBeenCalled();
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('cleans up state on disconnect', () => {
    const middleware = createSocketRateLimiter(10, 10_000);
    const socket = createMockSocket();
    middleware(toSocket(socket), jest.fn());

    // Send an event to create state
    socket._fireEvent();

    // Disconnect
    socket._fireDisconnect();

    // Reconnect with same id — should start fresh (no accumulated count)
    const socket2 = createMockSocket('socket-1');
    middleware(toSocket(socket2), jest.fn());

    // Should allow full limit again
    for (let i = 0; i < 10; i++) {
      const ackNext = socket2._fireEvent();
      expect(ackNext).toHaveBeenCalled();
    }
  });
});
