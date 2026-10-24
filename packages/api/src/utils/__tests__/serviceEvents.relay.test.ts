/**
 * The Valkey leg of the service-event feed (`utils/serviceEvents.ts`): every
 * oxy-api task hears every revocation, drops it from its own `sessionCache`
 * tier and relays it to ITS sockets only; a task vouches for its sockets (the
 * heartbeat) only while its own probe comes back; a lost subscription
 * disconnects its sockets at once.
 *
 * Valkey is a small in-memory broker with ioredis's pub/sub surface; the real
 * socket path is `routes/__tests__/sessionRevocationFeed.test.ts`.
 */
import { EventEmitter } from 'node:events';
import {
  OXY_SERVICE_EVENTS_HEARTBEAT_EVENT,
  OXY_SERVICE_EVENTS_HEARTBEAT_MS,
  OXY_SESSION_REVOKED_EVENT,
} from '@oxy.so/contracts';

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

/** One Valkey: clients subscribe to channels, `publish` reaches every subscriber. */
class Broker {
  readonly subscribers = new Set<FakeRedis>();
  delivering = true;
  publish(channel: string, message: string): number {
    if (!this.delivering) return 0;
    let count = 0;
    for (const client of this.subscribers) {
      if (client.channels.has(channel)) {
        count += 1;
        client.emit('message', channel, message);
      }
    }
    return count;
  }
}

class FakeRedis extends EventEmitter {
  readonly channels = new Set<string>();
  constructor(private readonly broker: Broker) {
    super();
  }
  duplicate(): FakeRedis {
    return new FakeRedis(this.broker);
  }
  async subscribe(...channels: string[]): Promise<number> {
    for (const channel of channels) this.channels.add(channel);
    this.broker.subscribers.add(this);
    return this.channels.size;
  }
  async publish(channel: string, message: string): Promise<number> {
    return this.broker.publish(channel, message);
  }
  async quit(): Promise<void> {
    this.broker.subscribers.delete(this);
  }
  disconnect(): void {
    this.broker.subscribers.delete(this);
  }
}

const broker = new Broker();
const mockPublisher = new FakeRedis(broker);
jest.mock('../../config/redis', () => ({ getRedisClient: () => mockPublisher }));

import sessionCache from '../sessionCache';
import { publishSessionRevocation, startServiceEvents } from '../serviceEvents';

function namespace() {
  return {
    sockets: new Map(),
    use: jest.fn(),
    on: jest.fn(),
    local: { emit: jest.fn(), disconnectSockets: jest.fn() },
  };
}
type FakeNamespace = ReturnType<typeof namespace>;
const heartbeats = (ns: FakeNamespace) =>
  ns.local.emit.mock.calls.filter(([event]) => event === OXY_SERVICE_EVENTS_HEARTBEAT_EVENT).length;
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
  broker.delivering = true;
  broker.subscribers.clear();
});
afterEach(() => jest.useRealTimers());

describe('the Valkey relay between oxy-api tasks', () => {
  it('delivers a revocation to every task, each relaying to its own sockets and dropping its own tier', async () => {
    const a = namespace();
    const b = namespace();
    const taskA = startServiceEvents(a as never, mockPublisher as never);
    const taskB = startServiceEvents(b as never, mockPublisher as never);
    await flush();
    const dropLocal = jest.spyOn(sessionCache, 'invalidateLocal');
    const dropUser = jest.spyOn(sessionCache, 'invalidateUserSessionsLocal');

    publishSessionRevocation({ sessionId: 's-1', userId: 'u-1', at: 1 });
    publishSessionRevocation({ userId: 'u-2', at: 2 });
    await flush();

    for (const ns of [a, b]) {
      expect(
        ns.local.emit.mock.calls
          .filter(([event]) => event === OXY_SESSION_REVOKED_EVENT)
          .map(([, value]) => value.at),
      ).toEqual([1, 2]);
      expect(ns.local.emit).toHaveBeenCalledWith(OXY_SESSION_REVOKED_EVENT, {
        sessionId: 's-1',
        userId: 'u-1',
        at: 1,
      });
      expect(ns.local.emit).toHaveBeenCalledWith(OXY_SESSION_REVOKED_EVENT, {
        userId: 'u-2',
        at: 2,
      });
    }
    expect(dropLocal).toHaveBeenCalledTimes(2);
    expect(dropLocal).toHaveBeenCalledWith('s-1');
    expect(dropUser).toHaveBeenCalledWith('u-2');
    await taskA.stop();
    await taskB.stop();
  });

  it('ignores a message that is not a revocation', async () => {
    const a = namespace();
    const task = startServiceEvents(a as never, mockPublisher as never);
    await flush();
    broker.publish('oxy-api:session:revoked', '{"sessionId":"s-1"}');
    broker.publish('oxy-api:session:revoked', 'not json');
    expect(a.local.emit).not.toHaveBeenCalledWith(OXY_SESSION_REVOKED_EVENT, expect.anything());
    await task.stop();
  });

  it('sends heartbeats only while its own probe comes back', async () => {
    const a = namespace();
    const task = startServiceEvents(a as never, mockPublisher as never);
    await flush();
    const first = heartbeats(a);
    jest.advanceTimersByTime(OXY_SERVICE_EVENTS_HEARTBEAT_MS);
    await flush();
    expect(heartbeats(a)).toBeGreaterThan(first);

    // Valkey stops delivering: past the probe window the heartbeats stop.
    broker.delivering = false;
    jest.advanceTimersByTime(3 * OXY_SERVICE_EVENTS_HEARTBEAT_MS);
    await flush();
    const silent = heartbeats(a);
    jest.advanceTimersByTime(3 * OXY_SERVICE_EVENTS_HEARTBEAT_MS);
    await flush();
    expect(heartbeats(a)).toBe(silent);

    // Delivery returns: the very probe that comes back resumes them.
    broker.delivering = true;
    jest.advanceTimersByTime(OXY_SERVICE_EVENTS_HEARTBEAT_MS);
    await flush();
    expect(heartbeats(a)).toBeGreaterThan(silent);
    await task.stop();
  });

  it('disconnects its sockets the moment its subscription closes', async () => {
    const a = namespace();
    const task = startServiceEvents(a as never, mockPublisher as never);
    await flush();
    jest.advanceTimersByTime(OXY_SERVICE_EVENTS_HEARTBEAT_MS);
    await flush();
    const subscriber = [...broker.subscribers][0];
    subscriber.emit('close');
    expect(a.local.disconnectSockets).toHaveBeenCalledWith(true);

    // And it stops vouching until a probe returns again.
    const before = heartbeats(a);
    broker.delivering = false;
    jest.advanceTimersByTime(OXY_SERVICE_EVENTS_HEARTBEAT_MS);
    await flush();
    expect(heartbeats(a)).toBe(before);
    await task.stop();
  });
});
