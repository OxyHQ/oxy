/**
 * GET /users/me/graph route tests.
 *
 * Focus: the SECURITY wiring, cache behavior, and response contract of the route
 * (the graph LOGIC outcomes are covered by
 * `services/__tests__/user.service.getViewerGraph.test.ts`).
 *
 *  - the viewer is taken from `resolveViewerId(req)` for user sessions and
 *    passed to the service — there is no `:userId` param and a client-supplied
 *    `?viewerId=` query is IGNORED (anti-IDOR / anti-impersonation)
 *  - service-token delegation returns the empty graph even when a delegated
 *    viewer resolves, because blocks and restrictions are private data
 *  - an anonymous caller (resolveViewerId → undefined) is NOT rejected: it returns
 *    the empty graph WITHOUT invoking the service or touching the cache
 *  - a cache HIT returns the cached graph and never recomputes from the service
 *  - a cache MISS recomputes via the service and writes the result back to cache
 *  - the response is the `{ data: { followingIds, mutualIds, blockedIds, restrictedIds } }`
 *    envelope
 *
 * The router is mounted on a minimal Express app and exercised via `node:http`
 * round-trips so we hit the real route + middleware chain. Only the data source
 * (`userService.getViewerGraph`), the cache (`graphCache`), and the
 * auth/resolution shims are stubbed.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const mockGetViewerGraph = jest.fn();
const mockGraphCacheGet = jest.fn();
const mockGraphCacheSet = jest.fn();

// Mutable viewer the stubbed `resolveViewerId` returns — set per test to model
// an authenticated viewer vs. an anonymous caller.
let currentViewerId: string | undefined;
let currentServiceApp: { appId: string; scopes: string[] } | undefined;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Optional dual-auth is a pass-through here; the viewer is resolved by the
// stubbed `resolveViewerId` (server-side derivation), never from the request
// query/body.
jest.mock('../../middleware/optionalAuth', () => ({
  optionalUserOrServiceAuth: (
    req: { serviceApp?: typeof currentServiceApp },
    _res: unknown,
    next: () => void
  ) => {
    req.serviceApp = currentServiceApp;
    next();
  },
  resolveViewerId: () => currentViewerId,
}));

jest.mock('../../services/email.service', () => ({
  emailService: { deleteAllUserData: jest.fn() },
}));
jest.mock('../../services/federation.service', () => ({
  federationService: { scheduleAvatarRefresh: jest.fn() },
  isOwnFederationDomain: jest.fn(),
}));
jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: { ensureOwnedAssetPublic: jest.fn().mockResolvedValue(undefined) },
  s3Service: {},
}));
jest.mock('../../services/user.service', () => ({
  userService: {
    getViewerGraph: mockGetViewerGraph,
  },
}));
jest.mock('../../utils/graphCache', () => ({
  __esModule: true,
  default: {
    get: mockGraphCacheGet,
    set: mockGraphCacheSet,
    invalidate: jest.fn(),
  },
}));
jest.mock('../../services/identityExport.service', () => ({
  buildExportBundle: jest.fn(),
}));
jest.mock('../../services/signature.service', () => ({
  __esModule: true,
  default: {},
}));
jest.mock('../../controllers/users.controller', () => ({
  UsersController: class {
    searchUsers = jest.fn();
  },
}));
jest.mock('../../utils/userCache', () => ({
  __esModule: true,
  default: { invalidate: jest.fn() },
}));
jest.mock('../../utils/validation', () => ({
  resolveUserIdToObjectId: jest.fn(async (id: string) => id),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
import usersRouter from '../users';
import { errorHandler } from '../../middleware/errorHandler';

interface JsonResponse {
  status: number;
  body: {
    error?: string;
    message?: string;
    data?: { followingIds?: string[]; mutualIds?: string[]; blockedIds?: string[]; restrictedIds?: string[] };
  };
}

async function getJson(server: http.Server, path: string): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: 'GET', host: '127.0.0.1', port: address.port, path },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            const parsed = raw.length > 0 ? JSON.parse(raw) : {};
            resolve({ status: res.statusCode ?? 0, body: parsed });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

let server: http.Server;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/users', usersRouter);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1', done);
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  currentViewerId = undefined;
  currentServiceApp = undefined;
  mockGetViewerGraph.mockReset();
  mockGraphCacheGet.mockReset();
  mockGraphCacheSet.mockReset();
});

describe('GET /users/me/graph', () => {
  const VIEWER = '5f000000000000000000000b';
  const GRAPH = { followingIds: ['f1'], mutualIds: ['m1'], blockedIds: ['b1'], restrictedIds: ['r1'] };

  it('recomputes from the service on a cache miss and writes back to cache', async () => {
    currentViewerId = VIEWER;
    mockGraphCacheGet.mockResolvedValueOnce(null);
    mockGetViewerGraph.mockResolvedValueOnce(GRAPH);
    mockGraphCacheSet.mockResolvedValueOnce(undefined);

    const res = await getJson(server, '/users/me/graph');

    expect(res.status).toBe(200);
    expect(mockGraphCacheGet).toHaveBeenCalledWith(VIEWER);
    expect(mockGetViewerGraph).toHaveBeenCalledTimes(1);
    expect(mockGetViewerGraph).toHaveBeenCalledWith(VIEWER);
    expect(mockGraphCacheSet).toHaveBeenCalledWith(VIEWER, GRAPH);
    expect(res.body.data).toEqual(GRAPH);
  });

  it('returns the cached graph on a hit and never recomputes', async () => {
    currentViewerId = VIEWER;
    mockGraphCacheGet.mockResolvedValueOnce(GRAPH);

    const res = await getJson(server, '/users/me/graph');

    expect(res.status).toBe(200);
    expect(mockGraphCacheGet).toHaveBeenCalledWith(VIEWER);
    expect(mockGetViewerGraph).not.toHaveBeenCalled();
    expect(mockGraphCacheSet).not.toHaveBeenCalled();
    expect(res.body.data).toEqual(GRAPH);
  });

  it('IGNORES a client-supplied viewerId query (anti-impersonation)', async () => {
    currentViewerId = VIEWER;
    mockGraphCacheGet.mockResolvedValueOnce(null);
    mockGetViewerGraph.mockResolvedValueOnce(GRAPH);

    const res = await getJson(server, '/users/me/graph?viewerId=5f000000000000000000000a');

    expect(res.status).toBe(200);
    // The viewer is the server-derived one, NOT the attacker-supplied query.
    expect(mockGraphCacheGet).toHaveBeenCalledWith(VIEWER);
    expect(mockGetViewerGraph).toHaveBeenCalledWith(VIEWER);
  });

  it('returns the empty graph for an anonymous caller without service or cache access', async () => {
    currentViewerId = undefined;

    const res = await getJson(server, '/users/me/graph');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      followingIds: [],
      mutualIds: [],
      blockedIds: [],
      restrictedIds: [],
    });
    expect(mockGraphCacheGet).not.toHaveBeenCalled();
    expect(mockGetViewerGraph).not.toHaveBeenCalled();
    expect(mockGraphCacheSet).not.toHaveBeenCalled();
  });

  it('does not expose a delegated user graph to a service token', async () => {
    currentViewerId = VIEWER;
    currentServiceApp = { appId: 'mention', scopes: ['user:read'] };

    const res = await getJson(server, '/users/me/graph');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      followingIds: [],
      mutualIds: [],
      blockedIds: [],
      restrictedIds: [],
    });
    expect(mockGraphCacheGet).not.toHaveBeenCalled();
    expect(mockGetViewerGraph).not.toHaveBeenCalled();
    expect(mockGraphCacheSet).not.toHaveBeenCalled();
  });
});
