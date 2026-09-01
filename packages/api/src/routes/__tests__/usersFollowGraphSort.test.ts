/**
 * GET /users/:userId/{followers,following,mutuals} — the `sort` query param.
 *
 * Pins down that the ordering a client asks for actually reaches the service,
 * that an unsupported ordering is REJECTED rather than silently coerced to the
 * default (a client asking for something we do not implement must find out),
 * and that omitting `sort` leaves the historical `recent` default in force.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const mockGetPublicUserById = jest.fn();
const mockGetUserFollowers = jest.fn();
const mockGetUserFollowing = jest.fn();
const mockGetUserMutuals = jest.fn();

let currentViewerId: string | undefined;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

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
    getUserFollowers: mockGetUserFollowers,
    getUserFollowing: mockGetUserFollowing,
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
  body: { message?: string; error?: string };
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

const TARGET = '5f000000000000000000000a';
const VIEWER = '5f000000000000000000000b';

const emptyPage = { data: [], total: 0, hasMore: false, limit: 50, offset: 0 };

beforeEach(() => {
  jest.clearAllMocks();
  currentViewerId = VIEWER;
  mockGetPublicUserById.mockResolvedValue({
    _id: TARGET,
    accountStatus: 'active',
    reputationTier: 'active',
    privacySettings: { isPrivateAccount: false },
  });
  mockGetUserFollowers.mockResolvedValue(emptyPage);
  mockGetUserFollowing.mockResolvedValue(emptyPage);
  mockGetUserMutuals.mockResolvedValue(emptyPage);
});

describe.each([
  ['followers', '/followers', () => mockGetUserFollowers],
  ['following', '/following', () => mockGetUserFollowing],
  ['mutuals', '/mutuals', () => mockGetUserMutuals],
] as const)('GET /users/:userId/%s sort', (_label, suffix, getMock) => {
  /** The params object the route handed the service, whatever its arity. */
  const paramsArg = (mock: jest.Mock): Record<string, unknown> => {
    const call = mock.mock.calls[0];
    return call[call.length - 1] as Record<string, unknown>;
  };

  it.each(['recent', 'oldest'] as const)('forwards sort=%s to the service', async (sort) => {
    const mock = getMock();
    const res = await getJson(server, `/users/${TARGET}${suffix}?sort=${sort}`);

    expect(res.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(paramsArg(mock).sort).toBe(sort);
  });

  it('leaves sort undefined when the client omits it, keeping the server default', async () => {
    const mock = getMock();
    const res = await getJson(server, `/users/${TARGET}${suffix}`);

    expect(res.status).toBe(200);
    expect(paramsArg(mock).sort).toBeUndefined();
  });

  it.each([
    ['alphabetical', 'an ordering we do not implement'],
    ['RECENT', 'the right word in the wrong case'],
    ['', 'an empty value'],
    ['createdAt', 'a raw Mongo field name'],
  ])('rejects sort=%s (%s) with 400 INVALID_SORT', async (sort) => {
    const mock = getMock();
    const res = await getJson(server, `/users/${TARGET}${suffix}?sort=${encodeURIComponent(sort)}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_SORT');
    expect(res.body.message).toBe('sort must be one of: recent, oldest');
    // The request must not reach the service at all.
    expect(mock).not.toHaveBeenCalled();
  });

  it('still honours limit and offset alongside sort', async () => {
    const mock = getMock();
    const res = await getJson(server, `/users/${TARGET}${suffix}?limit=10&offset=30&sort=oldest`);

    expect(res.status).toBe(200);
    expect(paramsArg(mock)).toMatchObject({ limit: 10, offset: 30, sort: 'oldest' });
  });
});
