/**
 * GET /users/:userId contract tests.
 *
 * Covers discovery gates (archived + restricted) and the viewer-relative
 * `relationship` field added to the single-profile fetch.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

import { randomBytes } from 'node:crypto';

const mockGetPublicUserById = jest.fn();
const mockGetUserStats = jest.fn();
const mockFormatUserResponse = jest.fn();
const mockGetViewerRelationship = jest.fn();

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
    getUserStats: mockGetUserStats,
    formatUserResponse: mockFormatUserResponse,
    getViewerRelationship: mockGetViewerRelationship,
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

const targetUserId = randomBytes(12).toString('hex');

interface JsonResponse {
  status: number;
  body: { message?: string; data?: Record<string, unknown> };
}

async function requestJson(server: http.Server, userId: string): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'GET',
        host: '127.0.0.1',
        port: address.port,
        path: `/users/${encodeURIComponent(userId)}`,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: raw.length > 0 ? JSON.parse(raw) : {},
            });
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

describe('GET /users/:userId', () => {
  let server: http.Server;

  beforeAll((done) => {
    const app = express();
    app.use('/users', usersRouter);
    app.use(errorHandler);
    server = app.listen(0, done);
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    currentViewerId = undefined;
    mockGetUserStats.mockResolvedValue({});
    mockFormatUserResponse.mockImplementation((user: { _id?: { toString(): string }; username?: string }) => ({
      id: user._id?.toString(),
      username: user.username,
    }));
  });

  it('returns 404 for a restricted-tier user', async () => {
    mockGetPublicUserById.mockResolvedValue({
      _id: targetUserId,
      username: 'abuser',
      accountStatus: 'active',
      reputationTier: 'restricted',
    });

    const res = await requestJson(server, targetUserId);
    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/not found/i);
    expect(mockGetViewerRelationship).not.toHaveBeenCalled();
  });

  it('returns 404 for an archived user', async () => {
    mockGetPublicUserById.mockResolvedValue({
      _id: targetUserId,
      username: 'gone',
      accountStatus: 'archived',
    });

    const res = await requestJson(server, targetUserId);
    expect(res.status).toBe(404);
    expect(mockGetViewerRelationship).not.toHaveBeenCalled();
  });

  it('omits relationship for anonymous viewers', async () => {
    mockGetPublicUserById.mockResolvedValue({
      _id: targetUserId,
      username: 'nate',
      accountStatus: 'active',
      reputationTier: 'trusted',
    });

    const res = await requestJson(server, targetUserId);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: targetUserId, username: 'nate' });
    expect(res.body.data?.relationship).toBeUndefined();
    expect(mockGetViewerRelationship).not.toHaveBeenCalled();
  });

  it('omits relationship on a self-view', async () => {
    const selfId = targetUserId;
    currentViewerId = selfId;
    mockGetPublicUserById.mockResolvedValue({
      _id: targetUserId,
      username: 'nate',
      accountStatus: 'active',
    });

    const res = await requestJson(server, selfId);
    expect(res.status).toBe(200);
    expect(res.body.data?.relationship).toBeUndefined();
    expect(mockGetViewerRelationship).not.toHaveBeenCalled();
  });

  it('includes relationship when an authenticated viewer fetches another profile', async () => {
    const viewerId = randomBytes(12).toString('hex');
    currentViewerId = viewerId;
    mockGetPublicUserById.mockResolvedValue({
      _id: targetUserId,
      username: 'nate',
      accountStatus: 'active',
    });
    mockGetViewerRelationship.mockResolvedValue({ isFollowing: true, followsYou: false });

    const res = await requestJson(server, targetUserId);
    expect(res.status).toBe(200);
    expect(res.body.data?.relationship).toEqual({ isFollowing: true, followsYou: false });
    expect(mockGetViewerRelationship).toHaveBeenCalledWith(viewerId, targetUserId);
  });
});
