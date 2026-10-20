/**
 * The reference-reconciliation routes carry TWO budgets (ADR 0043 D6).
 *
 * The begin and the inventory PAGES draw on `rl:asset-app:reconcile:`; the
 * commit, the status read and the release draw on
 * `rl:asset-app:reconcile-control:`. When the release shared the page budget, a
 * client that had just been refused a page (Homiio, 2026-10-20) was refused its
 * release too, and the session stayed open — blocking that entity type for an
 * hour. This pins the REAL router wiring: `rateLimit` is stubbed with a factory
 * that tags each middleware with its prefix.
 */

const mockServiceAuthMiddleware = jest.fn((_req: unknown, _res: unknown, next: () => void) =>
  next(),
);
const mockAuthMiddleware = jest.fn((_req: unknown, _res: unknown, next: () => void) => next());
const mockOptionalAuthMiddleware = jest.fn((_req: unknown, _res: unknown, next: () => void) =>
  next(),
);

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

const PAGES = 'rl:asset-app:reconcile:';
const CONTROL = 'rl:asset-app:reconcile-control:';

type Layer = {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
};

/** Redis prefixes of every `rateLimit()` middleware on `method path`. */
function limiterPrefixesFor(method: string, path: string): string[] {
  const stack = (assetsRouter as unknown as { stack: Layer[] }).stack;
  const layer = stack.find((entry) => entry.route?.path === path && entry.route.methods[method]);
  if (!layer?.route) {
    throw new Error(`No ${method.toUpperCase()} ${path} on the assets router — fix the guard`);
  }
  return layer.route.stack
    .map((entry) => (entry.handle as { __rlPrefix?: string } | undefined)?.__rlPrefix)
    .filter((prefix): prefix is string => typeof prefix === 'string');
}

const SESSION = '/service/references/reconcile/:sessionId';

describe('reference reconciliation: pages and control on separate budgets', () => {
  it.each([
    ['post', '/service/references/reconcile'],
    ['put', SESSION],
  ])('%s %s draws on the page budget only', (method, path) => {
    const prefixes = limiterPrefixesFor(method, path);
    expect(prefixes).toEqual([PAGES]);
  });

  it.each([
    ['post', `${SESSION}/commit`],
    ['get', SESSION],
    ['delete', SESSION],
  ])('%s %s draws on the control budget, never the page one', (method, path) => {
    const prefixes = limiterPrefixesFor(method, path);
    expect(prefixes).toEqual([CONTROL]);
    // The point: a client refused a page must still be able to release.
    expect(prefixes).not.toContain(PAGES);
  });

  it('throws a named error for a route that does not exist', () => {
    expect(() => limiterPrefixesFor('patch', SESSION)).toThrow(/No PATCH/);
  });
});
