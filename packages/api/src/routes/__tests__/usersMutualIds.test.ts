/**
 * GET /users/mutual-ids route tests.
 *
 * Focus: the SECURITY wiring and response contract of the route (the mutual-set
 * LOGIC outcomes are covered by
 * `services/__tests__/user.service.getMutualUserIds.test.ts`).
 *
 *  - the viewer is taken from `resolveViewerId(req)` (server-derived from the
 *    auth token) and passed to the service — there is no `:userId` param and a
 *    client-supplied `?viewerId=` query is IGNORED (anti-IDOR / anti-impersonation)
 *  - an anonymous caller (resolveViewerId → undefined) is NOT rejected: the
 *    service is still invoked (with `undefined`) and an empty `{ data: [] }` is
 *    returned
 *  - the response is the lean `{ data: string[] }` envelope (bare ids to SEED a
 *    feed) — NOT the paginated `{ data, pagination }` of `/users/:userId/mutuals`
 *  - an over-cap `?limit=` clamps to MAX_MUTUAL_IDS before hitting the service
 *
 * The router is mounted on a minimal Express app and exercised via `node:http`
 * round-trips so we hit the real route + middleware chain. Only the data source
 * (`userService.getMutualUserIds`) and the auth/resolution shims are stubbed.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { MAX_MUTUAL_IDS } from '../../utils/recommendationWeights';

const mockGetMutualUserIds = jest.fn();

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
    getMutualUserIds: mockGetMutualUserIds,
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
    data?: unknown;
    pagination?: unknown;
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
  mockGetMutualUserIds.mockReset();
});

describe('GET /users/mutual-ids', () => {
  const VIEWER = '5f000000000000000000000b';

  it('passes the server-derived viewer to the service and returns the lean ids envelope', async () => {
    currentViewerId = VIEWER;
    mockGetMutualUserIds.mockResolvedValueOnce(['m1', 'm2']);

    const res = await getJson(server, '/users/mutual-ids');

    expect(res.status).toBe(200);
    expect(mockGetMutualUserIds).toHaveBeenCalledTimes(1);
    expect(mockGetMutualUserIds).toHaveBeenCalledWith(VIEWER, { limit: MAX_MUTUAL_IDS });
    // Lean ids-only shape — no pagination envelope.
    expect(res.body.data).toEqual(['m1', 'm2']);
    expect(res.body.pagination).toBeUndefined();
  });

  it('IGNORES a client-supplied viewerId query (anti-impersonation)', async () => {
    currentViewerId = VIEWER;
    mockGetMutualUserIds.mockResolvedValueOnce([]);

    const res = await getJson(server, '/users/mutual-ids?viewerId=5f000000000000000000000a');

    expect(res.status).toBe(200);
    // The viewer is the server-derived one, NOT the attacker-supplied query.
    expect(mockGetMutualUserIds).toHaveBeenCalledWith(VIEWER, { limit: MAX_MUTUAL_IDS });
  });

  it('does not 401 for an anonymous caller — still invokes the service with undefined', async () => {
    currentViewerId = undefined;
    mockGetMutualUserIds.mockResolvedValueOnce([]);

    const res = await getJson(server, '/users/mutual-ids');

    expect(res.status).toBe(200);
    expect(mockGetMutualUserIds).toHaveBeenCalledWith(undefined, { limit: MAX_MUTUAL_IDS });
    expect(res.body.data).toEqual([]);
  });

  it('clamps an over-cap limit to MAX_MUTUAL_IDS before calling the service', async () => {
    currentViewerId = VIEWER;
    mockGetMutualUserIds.mockResolvedValueOnce([]);

    const res = await getJson(server, `/users/mutual-ids?limit=${MAX_MUTUAL_IDS * 100}`);

    expect(res.status).toBe(200);
    expect(mockGetMutualUserIds).toHaveBeenCalledWith(VIEWER, { limit: MAX_MUTUAL_IDS });
  });

  it('forwards a valid in-range limit unchanged', async () => {
    currentViewerId = VIEWER;
    mockGetMutualUserIds.mockResolvedValueOnce([]);

    const res = await getJson(server, '/users/mutual-ids?limit=100');

    expect(res.status).toBe(200);
    expect(mockGetMutualUserIds).toHaveBeenCalledWith(VIEWER, { limit: 100 });
  });

  it('rejects a negative limit with 400 (validatePagination)', async () => {
    currentViewerId = VIEWER;

    const res = await getJson(server, '/users/mutual-ids?limit=-5');

    expect(res.status).toBe(400);
    expect(mockGetMutualUserIds).not.toHaveBeenCalled();
  });
});
