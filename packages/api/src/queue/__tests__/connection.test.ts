import {
  getAssetVariantQueueConnectionOptions,
  getQueueConnectionOptions,
} from '../connection';

describe('queue Redis isolation', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalQueueRedisUrl = process.env.QUEUE_REDIS_URL;
  const originalRedisUrl = process.env.REDIS_URL;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalQueueRedisUrl === undefined) delete process.env.QUEUE_REDIS_URL;
    else process.env.QUEUE_REDIS_URL = originalQueueRedisUrl;
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
  });

  it('uses the dedicated queue URL when both URLs are present', () => {
    process.env.NODE_ENV = 'production';
    process.env.REDIS_URL = 'redis://cache.internal:6379';
    process.env.QUEUE_REDIS_URL = 'rediss://queue-user:queue-pass@queue.internal:6380/2';

    expect(getAssetVariantQueueConnectionOptions()).toMatchObject({
      host: 'queue.internal',
      port: 6380,
      db: 2,
      username: 'queue-user',
      password: 'queue-pass',
      tls: {},
      maxRetriesPerRequest: null,
    });
  });

  it('refuses the cache URL as a production queue fallback', () => {
    process.env.NODE_ENV = 'production';
    process.env.REDIS_URL = 'redis://cache.internal:6379';
    delete process.env.QUEUE_REDIS_URL;

    expect(() => getAssetVariantQueueConnectionOptions()).toThrow('without QUEUE_REDIS_URL');
    expect(getQueueConnectionOptions()).toMatchObject({ host: 'cache.internal' });
  });

  it('allows one local Redis server outside production', () => {
    process.env.NODE_ENV = 'test';
    process.env.REDIS_URL = 'redis://localhost:6379';
    delete process.env.QUEUE_REDIS_URL;

    expect(getAssetVariantQueueConnectionOptions()).toMatchObject({ host: 'localhost' });
  });
});
