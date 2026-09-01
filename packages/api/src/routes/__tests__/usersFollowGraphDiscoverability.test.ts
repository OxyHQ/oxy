/**
 * GET /users/:userId/{followers,following,mutuals} — discoverability gate.
 *
 * Archived, restricted-tier, and private-account targets must 404 on the
 * social-graph endpoints, matching GET /profiles/:userId/similar.
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
  body: { message?: string };
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
});

const TARGET = '5f000000000000000000000a';

describe.each([
  ['followers', '/followers', mockGetUserFollowers],
  ['following', '/following', mockGetUserFollowing],
  ['mutuals', '/mutuals', mockGetUserMutuals],
] as const)('GET /users/:userId/%s discoverability gate', (_label, suffix, graphMock) => {
  it('returns 404 for a restricted-tier target', async () => {
    mockGetPublicUserById.mockResolvedValueOnce({
      _id: TARGET,
      accountStatus: 'active',
      reputationTier: 'restricted',
    });

    const res = await getJson(server, `/users/${TARGET}${suffix}`);

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not found/i);
    expect(graphMock).not.toHaveBeenCalled();
  });

  it('returns 404 for an archived target', async () => {
    mockGetPublicUserById.mockResolvedValueOnce({
      _id: TARGET,
      accountStatus: 'archived',
    });

    const res = await getJson(server, `/users/${TARGET}${suffix}`);

    expect(res.status).toBe(404);
    expect(graphMock).not.toHaveBeenCalled();
  });

  it('returns 404 for a private-account target', async () => {
    mockGetPublicUserById.mockResolvedValueOnce({
      _id: TARGET,
      accountStatus: 'active',
      reputationTier: 'trusted',
      privacySettings: { isPrivateAccount: true },
    });

    const res = await getJson(server, `/users/${TARGET}${suffix}`);

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not found/i);
    expect(graphMock).not.toHaveBeenCalled();
  });
});
