/**
 * POST /users/follow-status/bulk contract tests
 *
 * Verifies the batched follow-status endpoint:
 *  - empty / missing / non-array `userIds` → 400 (validation), never queries
 *  - more than the cap (MAX_BULK_FOLLOW = 200) → 400, never queries
 *  - happy path returns `{ data: { statuses } }` from the REAL
 *    `userService.getFollowingStatuses`
 *  - registered BEFORE `/:userId`, so `follow-status` is never captured as a
 *    userId param
 *
 * The router is mounted on a minimal Express app and exercised via `node:http`
 * round-trips so we hit the real middleware + validation chain. Only the data
 * source (`userService.getFollowingStatuses`) is stubbed. `authMiddleware` is
 * mocked to inject a fixed viewer id.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const mockGetFollowingStatuses = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 'viewer-1' };
    next();
  },
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/optionalAuth', () => ({
  optionalUserOrServiceAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
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
    getFollowingStatuses: mockGetFollowingStatuses,
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
  resolveUserIdToObjectId: jest.fn(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
import usersRouter from '../users';
import { errorHandler } from '../../middleware/errorHandler';

interface JsonResponse {
  status: number;
  body: { error?: string; message?: string; data?: unknown };
}

async function requestJson(
  server: http.Server,
  method: string,
  path: string,
  payload: unknown,
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = JSON.stringify(payload ?? {});
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
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
    req.write(body);
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
  mockGetFollowingStatuses.mockReset();
});

describe('POST /users/follow-status/bulk', () => {
  it('rejects an empty userIds array with 400 and never queries', async () => {
    const res = await requestJson(server, 'POST', '/users/follow-status/bulk', { userIds: [] });

    expect(res.status).toBe(400);
    expect(mockGetFollowingStatuses).not.toHaveBeenCalled();
  });

  it('rejects a missing userIds field with 400', async () => {
    const res = await requestJson(server, 'POST', '/users/follow-status/bulk', {});

    expect(res.status).toBe(400);
    expect(mockGetFollowingStatuses).not.toHaveBeenCalled();
  });

  it('rejects a non-array userIds with 400', async () => {
    const res = await requestJson(server, 'POST', '/users/follow-status/bulk', { userIds: 'nope' });

    expect(res.status).toBe(400);
    expect(mockGetFollowingStatuses).not.toHaveBeenCalled();
  });

  it('rejects more than 200 ids with 400 and never queries', async () => {
    const userIds = Array.from({ length: 201 }, (_, i) => `id-${i}`);

    const res = await requestJson(server, 'POST', '/users/follow-status/bulk', { userIds });

    expect(res.status).toBe(400);
    expect(mockGetFollowingStatuses).not.toHaveBeenCalled();
  });

  it('returns { data: { statuses } } for valid ids, keyed off the auth viewer', async () => {
    mockGetFollowingStatuses.mockResolvedValueOnce({ u1: true, u2: false });

    const res = await requestJson(server, 'POST', '/users/follow-status/bulk', {
      userIds: ['u1', 'u2'],
    });

    expect(res.status).toBe(200);
    expect(mockGetFollowingStatuses).toHaveBeenCalledTimes(1);
    expect(mockGetFollowingStatuses).toHaveBeenCalledWith('viewer-1', ['u1', 'u2']);
    expect(res.body.data).toEqual({ statuses: { u1: true, u2: false } });
  });

  it('is NOT captured by the /:userId param route (registered first)', async () => {
    mockGetFollowingStatuses.mockResolvedValueOnce({ '000000000000000000000000': false });

    const res = await requestJson(server, 'POST', '/users/follow-status/bulk', {
      userIds: ['000000000000000000000000'],
    });

    // A 200 from the bulk handler (not a 404/405 from a param route) proves the
    // `/follow-status/bulk` literal route won the match over `/:userId`.
    expect(res.status).toBe(200);
    expect(mockGetFollowingStatuses).toHaveBeenCalledTimes(1);
  });
});
