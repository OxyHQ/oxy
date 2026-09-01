/**
 * GET /users/:userId/mutuals route tests.
 *
 * Focus: the SECURITY wiring and response contract of the route (the four
 * mutual-overlap LOGIC outcomes are covered by
 * `services/__tests__/user.service.getUserMutuals.test.ts`).
 *
 *  - the viewer is taken from `resolveViewerId(req)` (server-derived from the
 *    auth token) and passed to the service — a client-supplied `?viewerId=`
 *    query is IGNORED (anti-impersonation)
 *  - an anonymous caller (resolveViewerId → undefined) is NOT rejected: the
 *    service is still invoked (with `undefined`) and the empty page is returned
 *  - the response uses the SAME `{ data, pagination }` shape as
 *    GET /users/:userId/followers so the SDK can mirror `getUserFollowers`
 *
 * The router is mounted on a minimal Express app and exercised via `node:http`
 * round-trips so we hit the real route + middleware chain. Only the data source
 * (`userService.getUserMutuals`) and the auth/resolution shims are stubbed.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const mockGetPublicUserById = jest.fn();
const mockGetUserMutuals = jest.fn();

// Mutable viewer the stubbed `resolveViewerId` returns — set per test to model
// an authenticated viewer vs. an anonymous caller.
let currentViewerId: string | undefined;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Optional dual-auth is a pass-through here; the viewer is resolved by the
// stubbed `resolveViewerId` (server-side derivation), never from the request
// query/body.
jest.mock('../../middleware/optionalAuth', () => ({
  optionalUserOrServiceAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
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
    getPublicUserById: mockGetPublicUserById,
    getUserMutuals: mockGetUserMutuals,
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
// `resolveUserId` middleware resolves params.userId via this helper — echo the
// input so the target id passes through unchanged.
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
    data?: unknown;
    pagination?: { total: number; limit: number; offset: number; hasMore: boolean };
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
  mockGetUserMutuals.mockReset();
  mockGetPublicUserById.mockResolvedValue({
    _id: '5f000000000000000000000a',
    accountStatus: 'active',
    reputationTier: 'trusted',
  });
});

describe('GET /users/:userId/mutuals', () => {
  const TARGET = '5f000000000000000000000a';
  const VIEWER = '5f000000000000000000000b';

  it('passes the server-derived viewer to the service and returns the paginated shape', async () => {
    currentViewerId = VIEWER;
    const dto = {
      id: 'm1',
      username: 'mutualfriend',
      name: { displayName: 'Mutual Friend', full: 'Mutual Friend', first: 'Mutual' },
      avatar: 'file-m1',
      color: '#3b82f6',
    };
    mockGetUserMutuals.mockResolvedValueOnce({
      data: [dto],
      total: 1,
      hasMore: false,
      limit: 50,
      offset: 0,
    });

    const res = await getJson(server, `/users/${TARGET}/mutuals`);

    expect(res.status).toBe(200);
    expect(mockGetUserMutuals).toHaveBeenCalledTimes(1);
    expect(mockGetUserMutuals).toHaveBeenCalledWith(VIEWER, TARGET, { limit: 50, offset: 0, sort: undefined });
    expect(res.body.data).toEqual([dto]);
    // Same envelope as GET /users/:userId/followers.
    expect(res.body.pagination).toEqual({ total: 1, limit: 50, offset: 0, hasMore: false });
  });

  it('IGNORES a client-supplied viewerId query (anti-impersonation)', async () => {
    currentViewerId = VIEWER;
    mockGetUserMutuals.mockResolvedValueOnce({
      data: [], total: 0, hasMore: false, limit: 50, offset: 0,
    });

    const res = await getJson(server, `/users/${TARGET}/mutuals?viewerId=${TARGET}`);

    expect(res.status).toBe(200);
    // The viewer is the server-derived one, NOT the attacker-supplied query.
    expect(mockGetUserMutuals).toHaveBeenCalledWith(VIEWER, TARGET, { limit: 50, offset: 0, sort: undefined });
  });

  it('does not 401 for an anonymous caller — still invokes the service with undefined', async () => {
    currentViewerId = undefined;
    mockGetUserMutuals.mockResolvedValueOnce({
      data: [], total: 0, hasMore: false, limit: 50, offset: 0,
    });

    const res = await getJson(server, `/users/${TARGET}/mutuals`);

    expect(res.status).toBe(200);
    expect(mockGetUserMutuals).toHaveBeenCalledWith(undefined, TARGET, { limit: 50, offset: 0, sort: undefined });
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination).toEqual({ total: 0, limit: 50, offset: 0, hasMore: false });
  });

  it('forwards parsed limit/offset (capped) to the service', async () => {
    currentViewerId = VIEWER;
    mockGetUserMutuals.mockResolvedValueOnce({
      data: [], total: 0, hasMore: false, limit: 100, offset: 20,
    });

    const res = await getJson(server, `/users/${TARGET}/mutuals?limit=500&offset=20`);

    expect(res.status).toBe(200);
    // limit clamps to PAGINATION.MAX_LIMIT (100).
    expect(mockGetUserMutuals).toHaveBeenCalledWith(VIEWER, TARGET, { limit: 100, offset: 20, sort: undefined });
  });
});
