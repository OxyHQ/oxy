interface RedisHandle {
  set: jest.Mock;
  pttl: jest.Mock;
  incr: jest.Mock;
  expire: jest.Mock;
  del: jest.Mock;
}

let redisHandle: RedisHandle | null = null;
const getRedisClientMock = jest.fn(() => redisHandle);
const loggerWarnMock = jest.fn();

jest.mock('../../../config/redis', () => ({
  getRedisClient: getRedisClientMock,
}));

jest.mock('../../../utils/logger', () => ({
  logger: { warn: loggerWarnMock },
}));

import {
  acquireAvatarOriginLease,
  clearAvatarOriginFailures,
  recordAvatarOriginRateLimit,
} from '../avatarFetchBackpressure';

describe('federated avatar origin backpressure', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-11T12:00:00.000Z'));
    jest.clearAllMocks();
    redisHandle = null;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('serializes requests by origin while allowing a different origin', async () => {
    expect(await acquireAvatarOriginLease('https://media.one.example/a.png')).toBe(0);
    expect(await acquireAvatarOriginLease('https://media.one.example/b.png')).toBe(15_000);
    expect(await acquireAvatarOriginLease('https://media.two.example/a.png')).toBe(0);

    jest.advanceTimersByTime(15_001);
    expect(await acquireAvatarOriginLease('https://media.one.example/c.png')).toBe(0);
  });

  it('honours Retry-After and applies exponential backoff to repeated 429s', async () => {
    const url = 'https://limited.example/avatar.png';

    expect(await recordAvatarOriginRateLimit(url, '120')).toBe(120_000);
    expect(await acquireAvatarOriginLease(url)).toBe(120_000);

    jest.advanceTimersByTime(120_001);
    expect(await recordAvatarOriginRateLimit(url, undefined)).toBe(60_000);
    expect(await acquireAvatarOriginLease(url)).toBe(60_000);
  });

  it('resets exponential failure history after a successful response', async () => {
    const url = 'https://recovered.example/avatar.png';

    expect(await recordAvatarOriginRateLimit(url, undefined)).toBe(30_000);
    jest.advanceTimersByTime(30_001);
    expect(await recordAvatarOriginRateLimit(url, undefined)).toBe(60_000);
    await clearAvatarOriginFailures(url);
    jest.advanceTimersByTime(60_001);

    expect(await recordAvatarOriginRateLimit(url, undefined)).toBe(30_000);
  });

  it('preserves the origin request lease when a successful response clears failures', async () => {
    const url = 'https://fast.example/avatar.png';

    expect(await acquireAvatarOriginLease(url)).toBe(0);
    await clearAvatarOriginFailures(url);

    expect(await acquireAvatarOriginLease('https://fast.example/another.png')).toBe(15_000);
  });

  it('coordinates leases and 429 cooldowns through Redis across replicas', async () => {
    redisHandle = {
      set: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('OK'),
      pttl: jest.fn().mockResolvedValue(42_000),
      incr: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      del: jest.fn().mockResolvedValue(2),
    };
    const url = 'https://shared.example/avatar.png';

    expect(await acquireAvatarOriginLease(url)).toBe(42_000);
    expect(await recordAvatarOriginRateLimit(url, '90')).toBe(90_000);
    expect(redisHandle.set).toHaveBeenLastCalledWith(
      expect.stringMatching(/:cooldown$/),
      'rate-limited',
      'PX',
      90_000,
    );

    await clearAvatarOriginFailures(url);
    expect(redisHandle.del).toHaveBeenCalledWith(
      expect.stringMatching(/:rate-limit-failures$/),
    );
  });
});
