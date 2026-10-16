/**
 * The file-record cache is invalidated across API tasks (ADR 0041 stage 4b):
 * `fileCache.invalidate` drops the local copy AND publishes on Redis; every
 * task's subscriber drops its own copy, locally only. Transport: an in-memory
 * Redis that delivers PUBLISH to every subscribed duplicate, as Redis does.
 */

import { EventEmitter } from 'node:events';

type Listener = (channel: string, message: string) => void;

class FakeBus {
  subscribers = new Set<FakeRedis>();
  published: Array<{ channel: string; message: string }> = [];
}

class FakeRedis extends EventEmitter {
  status = 'ready';
  channels = new Set<string>();
  constructor(readonly bus: FakeBus) {
    super();
  }
  duplicate(): FakeRedis {
    return new FakeRedis(this.bus);
  }
  async publish(channel: string, message: string): Promise<number> {
    this.bus.published.push({ channel, message });
    let delivered = 0;
    for (const sub of this.bus.subscribers) {
      if (sub.channels.has(channel)) {
        sub.emit('message', channel, message);
        delivered++;
      }
    }
    return delivered;
  }
  async subscribe(channel: string): Promise<void> {
    this.channels.add(channel);
    this.bus.subscribers.add(this);
  }
  async quit(): Promise<void> {
    this.bus.subscribers.delete(this);
  }
  disconnect(): void {
    this.bus.subscribers.delete(this);
  }
  override on(event: string, listener: Listener): this {
    return super.on(event, listener);
  }
}

const bus = new FakeBus();
const mockRedis: { current: FakeRedis | null } = { current: null };

jest.mock('../../config/redis', () => ({
  getRedisClient: () => mockRedis.current,
}));

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import fileCache, {
  FILE_CACHE_INVALIDATION_BATCH,
  FILE_CACHE_INVALIDATION_CHANNEL,
  FILE_CACHE_ORIGIN,
} from '../fileCache';
import {
  handleFileCacheInvalidationMessage,
  startFileCacheInvalidationSubscriber,
} from '../fileCacheInvalidationSubscriber';
import type { FileRecord } from '../../types/file.types';
import { logger } from '../logger';

const record = (id: string) => ({ id, status: 'active' }) as unknown as FileRecord;

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  fileCache.clear();
  bus.published.length = 0;
  mockRedis.current = new FakeRedis(bus);
});

describe('publishing', () => {
  it('drops the local copy and publishes the id once, with this process as origin', () => {
    fileCache.set('f1', record('f1'));
    fileCache.invalidate('f1');
    expect(fileCache.get('f1')).toBeNull();
    expect(bus.published).toHaveLength(1);
    expect(bus.published[0].channel).toBe(FILE_CACHE_INVALIDATION_CHANNEL);
    expect(JSON.parse(bus.published[0].message)).toEqual({
      v: 1,
      origin: FILE_CACHE_ORIGIN,
      fileIds: ['f1'],
    });
  });

  it('batches many ids, deduplicated', () => {
    const ids = Array.from({ length: FILE_CACHE_INVALIDATION_BATCH + 3 }, (_, i) => `f${i}`);
    fileCache.invalidateMany([...ids, 'f0', '']);
    expect(bus.published.map((m) => JSON.parse(m.message).fileIds.length)).toEqual([
      FILE_CACHE_INVALIDATION_BATCH,
      3,
    ]);
  });

  it('without Redis, or with Redis not ready, is local only and never throws', () => {
    mockRedis.current = null;
    fileCache.set('f1', record('f1'));
    expect(() => fileCache.invalidate('f1')).not.toThrow();
    expect(fileCache.get('f1')).toBeNull();

    mockRedis.current = new FakeRedis(bus);
    mockRedis.current.status = 'reconnecting';
    fileCache.invalidate('f2');
    expect(bus.published).toHaveLength(0);
  });

  it('a failed publish is logged, not thrown', async () => {
    const failing = new FakeRedis(bus);
    failing.publish = async () => {
      throw new Error('connection lost');
    };
    mockRedis.current = failing;
    expect(() => fileCache.invalidate('f1')).not.toThrow();
    await flush();
    expect(logger.warn).toHaveBeenCalledWith(
      'fileCache: invalidation publish failed',
      expect.objectContaining({ err: 'connection lost' }),
    );
  });
});

describe('subscribing', () => {
  it("drops a peer's ids locally and does not re-publish", async () => {
    const subscription = startFileCacheInvalidationSubscriber(mockRedis.current as never);
    await flush();
    fileCache.set('f1', record('f1'));
    fileCache.set('f2', record('f2'));

    // Another task published.
    await new FakeRedis(bus).publish(
      FILE_CACHE_INVALIDATION_CHANNEL,
      JSON.stringify({ v: 1, origin: 'another-task', fileIds: ['f1'] }),
    );
    expect(fileCache.get('f1')).toBeNull();
    expect(fileCache.get('f2')).not.toBeNull();
    expect(bus.published).toHaveLength(1); // only the peer's message
    await subscription.stop();
  });

  it('ignores its own messages, other channels and malformed messages', () => {
    fileCache.set('f1', record('f1'));
    handleFileCacheInvalidationMessage(
      FILE_CACHE_INVALIDATION_CHANNEL,
      JSON.stringify({ v: 1, origin: FILE_CACHE_ORIGIN, fileIds: ['f1'] }),
    );
    handleFileCacheInvalidationMessage(
      'oxy:user:invalidate',
      JSON.stringify({ v: 1, origin: 'peer', fileIds: ['f1'] }),
    );
    handleFileCacheInvalidationMessage(FILE_CACHE_INVALIDATION_CHANNEL, '{not json');
    handleFileCacheInvalidationMessage(
      FILE_CACHE_INVALIDATION_CHANNEL,
      JSON.stringify({ v: 2, origin: 'peer', fileIds: ['f1'] }),
    );
    expect(fileCache.get('f1')).not.toBeNull();
  });
});

describe('a read in flight across an invalidation', () => {
  it('is not cached when the invalidation arrived after the read began', () => {
    const readStartedAt = Date.now();
    handleFileCacheInvalidationMessage(
      FILE_CACHE_INVALIDATION_CHANNEL,
      JSON.stringify({ v: 1, origin: 'peer', fileIds: ['f1'] }),
    );
    expect(fileCache.setIfFresh('f1', record('f1'), readStartedAt)).toBe(false);
    expect(fileCache.get('f1')).toBeNull();
  });

  it('is cached when the read began after the invalidation', async () => {
    fileCache.invalidate('f1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(fileCache.setIfFresh('f1', record('f1'), Date.now())).toBe(true);
    expect(fileCache.get('f1')).not.toBeNull();
  });
});
