/**
 * MOUNT-ORDER INVARIANT guard for the bulk service LOOKUP routes.
 *
 * `SERVICE_TO_SERVICE_BULK_PATHS` (middleware/security.ts) exempts its paths
 * from the general per-IP browser budget, so each one's dedicated route limiter
 * is the SOLE ceiling on authenticated service traffic to it. The path set and
 * the route limiters therefore have to move together — and they demonstrably do
 * not on their own: `/assets/service/by-ids` shipped with neither, which let a
 * relying app's metadata backfill absorb 24,423 consecutive 429s against the
 * browser budget it should never have been drawing from.
 *
 * The failure mode this guards is the OPPOSITE and worse one: allowlisting a
 * path while its route limiter is missing or gets removed later, which silently
 * leaves authenticated service traffic on that path with no ceiling at all.
 *
 * `rateLimit` is stubbed with a factory that tags the middleware it returns with
 * its redis prefix, so the assertion is about the REAL router wiring (which
 * middleware express actually mounted on which path) rather than about a list
 * kept in a comment.
 */

const mockServiceAuthMiddleware = jest.fn((_req: unknown, _res: unknown, next: () => void) => next());
const mockAuthMiddleware = jest.fn((_req: unknown, _res: unknown, next: () => void) => next());
const mockOptionalAuthMiddleware = jest.fn((_req: unknown, _res: unknown, next: () => void) => next());

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (...args: unknown[]) => mockAuthMiddleware(...args),
  serviceAuthMiddleware: (...args: unknown[]) => mockServiceAuthMiddleware(...args),
}));

jest.mock('../../middleware/optionalAuth', () => ({
  optionalAuthMiddleware: (...args: unknown[]) => mockOptionalAuthMiddleware(...args),
  getUserId: () => undefined,
}));

jest.mock('../../middleware/mediaHeaders', () => ({
  mediaHeadersMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Tag each produced middleware with the prefix it was built from, so the router
// stack can be asked WHICH limiter is mounted, not merely whether one is.
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: (options: { prefix: string }) => {
    const mw = (_req: unknown, _res: unknown, next: () => void) => next();
    (mw as unknown as { __rlPrefix: string }).__rlPrefix = options.prefix;
    return mw;
  },
}));

jest.mock('../../utils/placeholders', () => ({
  generateMissingFilePlaceholder: () => '<svg/>',
  TRANSPARENT_PNG_PLACEHOLDER: '',
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../utils/validation', () => ({
  isValidObjectId: (id: string) => /^[a-fA-F0-9]{24}$/.test(id),
}));

jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: {
    getFilesByIds: jest.fn(),
    findActiveFilesBySha256: jest.fn(),
    getPublicCdnUrl: jest.fn(),
  },
  s3Service: {},
}));

import assetsRouter from '../assets';

const LOOKUP_PREFIX = 'rl:asset-lookup:';

/** Redis prefixes of every `rateLimit()` middleware mounted on `path`. */
function limiterPrefixesFor(path: string): string[] {
  const stack = (assetsRouter as unknown as {
    stack: Array<{ route?: { path: string; stack: Array<{ handle: unknown }> } }>;
  }).stack;

  const layer = stack.find((entry) => entry.route?.path === path);
  if (!layer?.route) {
    throw new Error(
      `No route mounted at "${path}" on the assets router — the path was renamed or removed, `
      + 'so this guard is measuring nothing. Fix the path before trusting the suite.',
    );
  }

  return layer.route.stack
    .map((entry) => (entry.handle as { __rlPrefix?: string } | undefined)?.__rlPrefix)
    .filter((prefix): prefix is string => typeof prefix === 'string');
}

describe('bulk service lookup routes carry their dedicated limiter', () => {
  // Vacuity floor: if the router exposed no routes at all, every assertion below
  // would pass by matching nothing.
  it('the assets router actually exposes routes', () => {
    const stack = (assetsRouter as unknown as { stack: unknown[] }).stack;
    expect(Array.isArray(stack)).toBe(true);
    expect(stack.length).toBeGreaterThan(10);
  });

  it.each(['/service/by-ids', '/service/by-sha256'])(
    '%s mounts the asset-lookup limiter',
    (path) => {
      expect(limiterPrefixesFor(path)).toContain(LOOKUP_PREFIX);
    },
  );

  it('throws a NAMED error when the route path no longer exists', () => {
    // Proves the helper cannot silently return [] for a renamed route, which
    // would make a missing limiter indistinguishable from a missing route.
    expect(() => limiterPrefixesFor('/service/no-such-route')).toThrow(/No route mounted/);
  });

  it('does not mount the cache-upload limiter on a read lookup', () => {
    // The two ceilings are sized for different work (an S3 write vs a projected
    // read); crossing them would silently throttle backfill reads at 30/min.
    expect(limiterPrefixesFor('/service/by-ids')).not.toContain('rl:asset-cache:upload:');
  });
});
