/**
 * `userCache.invalidate` broadcast tests.
 *
 * `invalidate` is the chokepoint every user-state write in oxy-api already goes
 * through, which is why the cross-service invalidation signal hangs off it
 * rather than off ~25 individual call sites. These tests pin the two properties
 * that make that safe:
 *
 *  - The DEFAULT broadcasts. A writer that does not classify itself
 *    over-invalidates (a wasted eviction downstream) instead of leaving
 *    consumers serving stale identity nobody can tell is stale.
 *  - `'graph'` puts NOTHING on the wire. Follow churn is high-frequency and one
 *    bulk call moves up to 200 edges; suppressing at the publisher is what keeps
 *    that from becoming a burst every Oxy backend receives and discards.
 *
 * Local + Redis eviction must happen for BOTH reasons — only the fan-out differs.
 */

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

let redisHandle: unknown = null;
jest.mock('../../config/redis', () => ({
  __esModule: true,
  getRedisClient: () => redisHandle,
}));

import { OXY_USER_INVALIDATION_CHANNEL } from '@oxyhq/contracts';

import userCache from '../userCache';

interface FakeRedis {
  status: string;
  del: jest.Mock;
  publish: jest.Mock;
}

function makeRedis(status = 'ready'): FakeRedis {
  return {
    status,
    del: jest.fn().mockResolvedValue(1),
    publish: jest.fn().mockResolvedValue(1),
  };
}

describe('userCache.invalidate — cross-service broadcast', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = makeRedis();
    redisHandle = redis;
    userCache.clear();
  });

  afterEach(() => {
    redisHandle = null;
    jest.clearAllMocks();
  });

  it('broadcasts by default, on the contract channel', () => {
    userCache.invalidate('user-1');

    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, message] = redis.publish.mock.calls[0];
    expect(channel).toBe(OXY_USER_INVALIDATION_CHANNEL);
    expect(JSON.parse(message)).toEqual({
      userId: 'user-1',
      reason: 'profile',
      at: expect.any(Number),
    });
  });

  it('broadcasts an explicit profile change', () => {
    userCache.invalidate('user-1', 'profile');
    expect(redis.publish).toHaveBeenCalledTimes(1);
  });

  it('publishes NOTHING for graph churn', () => {
    userCache.invalidate('user-1', 'graph');
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('still evicts locally and in Redis for graph churn', () => {
    // Suppression is about the fan-out only. oxy-api's own caches must still
    // drop the row, or follow counts would go stale inside oxy-api itself.
    userCache.invalidate('user-1', 'graph');
    expect(redis.del).toHaveBeenCalledWith('user:user-1');
  });

  it('evicts and broadcasts for a profile change', () => {
    userCache.invalidate('user-1', 'profile');
    expect(redis.del).toHaveBeenCalledWith('user:user-1');
    expect(redis.publish).toHaveBeenCalledTimes(1);
  });

  it('evicts locally without broadcasting via invalidateLocal', () => {
    userCache.invalidateLocal('user-1');
    expect(redis.del).toHaveBeenCalledWith('user:user-1');
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('does nothing at all for an empty user id', () => {
    userCache.invalidate('');
    expect(redis.del).not.toHaveBeenCalled();
    expect(redis.publish).not.toHaveBeenCalled();
  });

  it('does not publish when Redis is unconfigured', () => {
    redisHandle = null;
    expect(() => userCache.invalidate('user-1')).not.toThrow();
  });

  it('does not publish when the client is not ready', () => {
    redisHandle = makeRedis('connecting');
    expect(() => userCache.invalidate('user-1')).not.toThrow();
    expect((redisHandle as FakeRedis).publish).not.toHaveBeenCalled();
  });

  it('never lets a publish failure escape the write path', async () => {
    // `invalidate` runs after a committed database write, on the request path.
    // A broadcast failure must never turn a completed profile update into a 500.
    redis.publish.mockRejectedValue(new Error('redis down'));

    expect(() => userCache.invalidate('user-1')).not.toThrow();
    await Promise.resolve();
  });

  it('never lets a synchronously throwing publish escape', () => {
    redis.publish.mockImplementation(() => {
      throw new Error('redis down');
    });
    expect(() => userCache.invalidate('user-1')).not.toThrow();
  });
});
