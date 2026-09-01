/**
 * Viewer-Graph Cache tests.
 *
 * Covers the two operating modes and the failure posture:
 *  - Redis UNCONFIGURED (`getRedisClient()` → null): every operation degrades to
 *    a no-op — `get` returns null (caller recomputes), `set`/`invalidate` do
 *    nothing and never throw.
 *  - Redis CONFIGURED: `set` writes JSON with the short TTL, `get` parses and
 *    validates the shape (returning null for a malformed/legacy value), and
 *    `invalidate` deletes the key.
 *  - Redis ERRORS are swallowed: a throwing client degrades to "recompute from
 *    source" (get → null) and never fails the write path (set/invalidate resolve).
 */

jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

// Mutable Redis handle the mocked `getRedisClient` returns — set per test to
// model "unconfigured" (null) vs. a fake client.
let redisHandle: unknown = null;
jest.mock('../../config/redis', () => ({
  __esModule: true,
  getRedisClient: () => redisHandle,
}));

import graphCache, { GRAPH_CACHE_TTL_SECONDS } from '../graphCache';
import type { ViewerGraph } from '../../types/user.types';

const GRAPH: ViewerGraph = {
  followingIds: ['f1', 'f2'],
  mutualIds: ['m1'],
  blockedIds: ['b1'],
  restrictedIds: ['r1'],
};

const KEY = 'viewergraph:v1:viewer-1';

interface FakeRedis {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
}

function makeRedis(): FakeRedis {
  return {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };
}

beforeEach(() => {
  redisHandle = null;
  jest.clearAllMocks();
});

describe('graphCache — Redis unconfigured (no-op degradation)', () => {
  it('get returns null without a client', async () => {
    expect(await graphCache.get('viewer-1')).toBeNull();
  });

  it('set and invalidate are silent no-ops', async () => {
    await expect(graphCache.set('viewer-1', GRAPH)).resolves.toBeUndefined();
    await expect(graphCache.invalidate('viewer-1')).resolves.toBeUndefined();
  });
});

describe('graphCache — Redis configured', () => {
  it('set writes the JSON payload with the short TTL', async () => {
    const redis = makeRedis();
    redisHandle = redis;

    await graphCache.set('viewer-1', GRAPH);

    expect(redis.set).toHaveBeenCalledWith(
      KEY,
      JSON.stringify(GRAPH),
      'EX',
      GRAPH_CACHE_TTL_SECONDS,
    );
  });

  it('get parses and returns a well-formed cached graph', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValueOnce(JSON.stringify(GRAPH));
    redisHandle = redis;

    const result = await graphCache.get('viewer-1');

    expect(redis.get).toHaveBeenCalledWith(KEY);
    expect(result).toEqual(GRAPH);
  });

  it('get returns null on a miss', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValueOnce(null);
    redisHandle = redis;

    expect(await graphCache.get('viewer-1')).toBeNull();
  });

  it('get returns null for a malformed/legacy cached value', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValueOnce(JSON.stringify({ followingIds: ['f1'] }));
    redisHandle = redis;

    expect(await graphCache.get('viewer-1')).toBeNull();
  });

  it('get returns null for a pre-restrictedIds cached graph', async () => {
    const redis = makeRedis();
    redis.get.mockResolvedValueOnce(
      JSON.stringify({
        followingIds: ['f1'],
        mutualIds: ['m1'],
        blockedIds: ['b1'],
      }),
    );
    redisHandle = redis;

    expect(await graphCache.get('viewer-1')).toBeNull();
  });

  it('invalidate deletes the viewer key', async () => {
    const redis = makeRedis();
    redisHandle = redis;

    await graphCache.invalidate('viewer-1');

    expect(redis.del).toHaveBeenCalledWith(KEY);
  });
});

describe('graphCache — Redis errors are swallowed', () => {
  it('get returns null when the client throws', async () => {
    const redis = makeRedis();
    redis.get.mockRejectedValueOnce(new Error('boom'));
    redisHandle = redis;

    expect(await graphCache.get('viewer-1')).toBeNull();
  });

  it('set resolves when the client throws (never fails the write path)', async () => {
    const redis = makeRedis();
    redis.set.mockRejectedValueOnce(new Error('boom'));
    redisHandle = redis;

    await expect(graphCache.set('viewer-1', GRAPH)).resolves.toBeUndefined();
  });

  it('invalidate resolves when the client throws', async () => {
    const redis = makeRedis();
    redis.del.mockRejectedValueOnce(new Error('boom'));
    redisHandle = redis;

    await expect(graphCache.invalidate('viewer-1')).resolves.toBeUndefined();
  });
});

describe('graphCache — empty viewer id', () => {
  it('short-circuits every operation for a falsy viewer id', async () => {
    const redis = makeRedis();
    redisHandle = redis;

    expect(await graphCache.get('')).toBeNull();
    await graphCache.set('', GRAPH);
    await graphCache.invalidate('');

    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });
});
