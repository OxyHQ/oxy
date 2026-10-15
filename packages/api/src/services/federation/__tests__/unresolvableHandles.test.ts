/**
 * The failed-discovery cache: fleet-wide through Redis when it is ready, per
 * process otherwise, and per process again when a Redis call fails.
 */
const mockRedis = {
  status: 'ready',
  exists: jest.fn(),
  set: jest.fn(),
};
let redisAvailable = true;

jest.mock('../../../config/redis', () => ({
  getRedisClient: () => (redisAvailable ? mockRedis : null),
}));
jest.mock('../../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { UNRESOLVABLE_HANDLE_TTL_SECONDS, unresolvableHandles } from '../unresolvableHandles';

beforeEach(() => {
  redisAvailable = true;
  mockRedis.status = 'ready';
  mockRedis.exists.mockReset();
  mockRedis.set.mockReset();
  unresolvableHandles.clearLocal();
});

it('remembers a failed handle in Redis for the window', async () => {
  mockRedis.set.mockResolvedValue('OK');
  await unresolvableHandles.remember('ghost@example.social');
  expect(mockRedis.set).toHaveBeenCalledWith(
    'federation:unresolvable-handle:ghost@example.social',
    '1',
    'EX',
    UNRESOLVABLE_HANDLE_TTL_SECONDS,
  );
  mockRedis.exists.mockResolvedValue(1);
  expect(await unresolvableHandles.has('ghost@example.social')).toBe(true);
  mockRedis.exists.mockResolvedValue(0);
  expect(await unresolvableHandles.has('ghost@example.social')).toBe(false);
});

it('keeps the window per process without Redis, and lets it lapse', async () => {
  redisAvailable = false;
  const now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
  try {
    await unresolvableHandles.remember('ghost@example.social');
    expect(await unresolvableHandles.has('ghost@example.social')).toBe(true);
    expect(await unresolvableHandles.has('other@example.social')).toBe(false);
    clock.mockReturnValue(now + UNRESOLVABLE_HANDLE_TTL_SECONDS * 1000 + 1);
    expect(await unresolvableHandles.has('ghost@example.social')).toBe(false);
  } finally {
    clock.mockRestore();
  }
});

it('falls back to the process cache when a Redis call fails', async () => {
  mockRedis.set.mockRejectedValue(new Error('connection reset'));
  mockRedis.exists.mockRejectedValue(new Error('connection reset'));
  await unresolvableHandles.remember('ghost@example.social');
  expect(await unresolvableHandles.has('ghost@example.social')).toBe(true);
});
