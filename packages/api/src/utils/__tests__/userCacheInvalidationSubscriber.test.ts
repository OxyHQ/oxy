jest.mock('../logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const invalidateLocal = jest.fn();
jest.mock('../userCache', () => ({
  __esModule: true,
  default: {
    invalidateLocal,
  },
}));

import { EventEmitter } from 'node:events';

import { OXY_USER_INVALIDATION_CHANNEL } from '@oxyhq/contracts';

import { startUserCacheInvalidationSubscriber } from '../userCacheInvalidationSubscriber';

class FakeRedis extends EventEmitter {
  duplicate = jest.fn(() => this);
  subscribe = jest.fn().mockResolvedValue(undefined);
  quit = jest.fn().mockResolvedValue(undefined);
  disconnect = jest.fn();
}

describe('startUserCacheInvalidationSubscriber', () => {
  beforeEach(() => {
    invalidateLocal.mockClear();
  });

  it('drops local cache on a valid invalidation message without re-publishing', async () => {
    const redis = new FakeRedis();
    startUserCacheInvalidationSubscriber(redis as never);

    expect(redis.subscribe).toHaveBeenCalledWith(OXY_USER_INVALIDATION_CHANNEL);

    redis.emit(
      'message',
      OXY_USER_INVALIDATION_CHANNEL,
      JSON.stringify({ userId: 'user-1', reason: 'profile', at: 1 }),
    );

    expect(invalidateLocal).toHaveBeenCalledWith('user-1');
  });

  it('ignores messages on other channels', () => {
    const redis = new FakeRedis();
    startUserCacheInvalidationSubscriber(redis as never);

    redis.emit(
      'message',
      'other:channel',
      JSON.stringify({ userId: 'user-1', reason: 'profile', at: 1 }),
    );

    expect(invalidateLocal).not.toHaveBeenCalled();
  });

  it('drops malformed messages without throwing', () => {
    const redis = new FakeRedis();
    startUserCacheInvalidationSubscriber(redis as never);

    expect(() => redis.emit('message', OXY_USER_INVALIDATION_CHANNEL, 'not json')).not.toThrow();
    expect(invalidateLocal).not.toHaveBeenCalled();
  });
});
