jest.mock('../logger', () => ({ logger: { warn: jest.fn() } }));
let redisHandle: unknown;
jest.mock('../../config/redis', () => ({ getRedisClient: () => redisHandle }));
import type { AccountDocument } from '../../services/user.service';
import userCache from '../userCache';

const stale = { id: 'viewer', isStaff: true } as AccountDocument;
const fresh = { id: 'viewer', isStaff: false } as AccountDocument;
let resolveRead: (value: string | null) => void;
let redis: { status: string; get: jest.Mock; setex: jest.Mock; del: jest.Mock };
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => {
  userCache.clear();
  redis = {
    status: 'ready',
    get: jest.fn(
      () =>
        new Promise<string | null>((resolve) => {
          resolveRead = resolve;
        }),
    ),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };
  redisHandle = redis;
});
afterEach(() => {
  redisHandle = null;
  userCache.clear();
});
it('coalesces simultaneous cold reads without blocking database fallback', async () => {
  for (let i = 0; i < 20; i++) expect(userCache.get('viewer')).toBeNull();
  expect(redis.get).toHaveBeenCalledTimes(1);
  resolveRead(JSON.stringify(fresh));
  await settle();
  expect(userCache.get('viewer')).toEqual(fresh);
});
it('does not overwrite a newer database result with a delayed Redis document', async () => {
  userCache.get('viewer');
  userCache.set('viewer', fresh);
  resolveRead(JSON.stringify(stale));
  await settle();
  expect(userCache.get('viewer')).toEqual(fresh);
});
it.each(['invalidateLocal', 'clear'] as const)(
  'does not restore stale permissions after %s',
  async (action) => {
    userCache.get('viewer');
    if (action === 'clear') userCache.clear();
    else userCache.invalidateLocal('viewer');
    resolveRead(JSON.stringify(stale));
    await settle();
    redisHandle = null;
    expect(userCache.get('viewer')).toBeNull();
  },
);
it('allows another warm-fill after a miss', async () => {
  userCache.get('viewer');
  resolveRead(null);
  await settle();
  userCache.get('viewer');
  expect(redis.get).toHaveBeenCalledTimes(2);
  resolveRead(null);
  await settle();
});
it('does not let an old completion clear a newer warm-fill after eviction', async () => {
  userCache.get('viewer');
  const oldRead = resolveRead;
  userCache.invalidateLocal('viewer');
  userCache.get('viewer');
  const newRead = resolveRead;
  oldRead(JSON.stringify(stale));
  await settle();
  expect(userCache.get('viewer')).toBeNull();
  expect(redis.get).toHaveBeenCalledTimes(2);
  newRead(JSON.stringify(fresh));
  await settle();
  expect(userCache.get('viewer')).toEqual(fresh);
});
it('retries after Redis rejection without retaining the failed read', async () => {
  redis.get.mockRejectedValueOnce(new Error('disconnected'));
  userCache.get('viewer');
  await settle();
  expect(userCache.get('viewer')).toBeNull();
  expect(redis.get).toHaveBeenCalledTimes(2);
  resolveRead(JSON.stringify(fresh));
  await settle();
  expect(userCache.get('viewer')).toEqual(fresh);
});
