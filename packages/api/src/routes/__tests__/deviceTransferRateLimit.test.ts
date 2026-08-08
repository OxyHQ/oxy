/**
 * Every Redis-backed limiter in `routes/deviceTransfer.ts` MUST register a
 * UNIQUE key prefix. Two limiters sharing a prefix increment the same counter
 * when a request flows through both (express-rate-limit throws
 * ERR_ERL_DOUBLE_COUNT and the effective per-key budget is silently halved).
 * This suite captures each prefix at module-load time via a mocked RedisStore
 * and asserts the four device-transfer limiters are present and distinct.
 */

const capturedPrefixes: string[] = [];

jest.mock('rate-limit-redis', () => ({
  RedisStore: jest.fn().mockImplementation((opts: { prefix?: string }) => {
    if (typeof opts?.prefix === 'string') capturedPrefixes.push(opts.prefix);
    return {
      init: jest.fn(),
      increment: jest.fn(async () => ({ totalHits: 1, resetTime: new Date() })),
      decrement: jest.fn(),
      resetKey: jest.fn(),
      resetAll: jest.fn(),
    };
  }),
}));

// Force the Redis branch of `makeStore` so a RedisStore (with its prefix) is
// actually constructed for each limiter at import time.
jest.mock('../../config/redis', () => ({
  getRedisClient: () => ({ call: jest.fn() }),
}));

// Stub the auth middleware, service, and socket util so importing the route only
// constructs the limiters — this suite asserts which limiters are mounted, not
// what the handlers behind them do.
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/deviceTransfer.service', () => ({
  initDeviceTransfer: jest.fn(),
  getDeviceTransferInfo: jest.fn(),
  approveDeviceTransfer: jest.fn(),
  denyDeviceTransfer: jest.fn(),
}));
jest.mock('../../utils/devicePairSocket', () => ({
  emitDevicePairUpdate: jest.fn(),
}));

// Importing the route builds every limiter at load time, populating
// `capturedPrefixes` via the mocked RedisStore constructor.
import '../deviceTransfer';

describe('deviceTransfer.ts limiter prefixes are unique', () => {
  const expected = [
    'rl:identity:devicetransfer:init:',
    'rl:identity:devicetransfer:info:',
    'rl:identity:devicetransfer:approve:',
    'rl:identity:devicetransfer:deny:',
  ];

  it('registers all four device-transfer limiters', () => {
    for (const prefix of expected) {
      expect(capturedPrefixes).toContain(prefix);
    }
  });

  it('registers each prefix exactly once (no ERR_ERL_DOUBLE_COUNT)', () => {
    for (const prefix of expected) {
      expect(capturedPrefixes.filter((p) => p === prefix)).toHaveLength(1);
    }
    expect(new Set(expected).size).toBe(expected.length);
  });
});
