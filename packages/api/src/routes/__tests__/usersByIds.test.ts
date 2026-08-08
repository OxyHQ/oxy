/**
 * POST /users/by-ids contract tests (A1)
 *
 * Verifies the bulk user-resolution endpoint:
 *  - empty `ids` → 400 (validation)
 *  - more than the cap (100) → 400 (validation)
 *  - happy path returns `{ data: [...] }` of public DTOs produced by the
 *    REAL `userService.getUsersByIds` (so the response shape — including
 *    canonical `name.displayName` and `_count` — is the one Mention consumes)
 *  - the dual-auth middleware is wired so a service-token caller is accepted
 *  - registered BEFORE `/:userId`, so `by-ids` is never captured as a userId
 *
 * The router is mounted on a minimal Express app and exercised via `node:http`
 * round-trips so we hit the real middleware + validation chain. Only the data
 * source (`userService.getUsersByIds`) is stubbed.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const mockGetUsersByIds = jest.fn();
const mockGetUserById = jest.fn();
const mockGetUserStats = jest.fn();
const mockFormatUserResponse = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Dual-auth: simulate a valid service-token caller (sets req.serviceApp). The
// route does not gate on scope, so this proves a server-to-server caller is
// accepted by the mounted middleware chain.
jest.mock('../../middleware/optionalAuth', () => ({
  optionalUserOrServiceAuth: (
    req: { serviceApp?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    req.serviceApp = {
      type: 'service',
      appId: 'app-1',
      appName: 'mention',
      scopes: ['user:read'],
    };
    next();
  },
}));

jest.mock('../../services/email.service', () => ({
  emailService: { deleteAllUserData: jest.fn() },
}));
jest.mock('../../services/federation.service', () => ({
  federationService: { scheduleAvatarRefresh: jest.fn() },
}));
jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: { ensureOwnedAssetPublic: jest.fn().mockResolvedValue(undefined) },
  s3Service: {},
}));
jest.mock('../../services/user.service', () => ({
  userService: {
    getUsersByIds: mockGetUsersByIds,
    getUserById: mockGetUserById,
    getUserStats: mockGetUserStats,
    formatUserResponse: mockFormatUserResponse,
  },
}));
// usersRouter now imports the signed-export service (which pulls in the identity
// model graph). Stub it — this suite does not exercise GET /users/me/export.
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
  mockGetUsersByIds.mockReset();
});

describe('POST /users/by-ids (A1)', () => {
  it('rejects an empty ids array with 400 and never queries', async () => {
    const res = await requestJson(server, 'POST', '/users/by-ids', { ids: [] });

    expect(res.status).toBe(400);
    expect(mockGetUsersByIds).not.toHaveBeenCalled();
  });

  it('rejects more than 100 ids with 400 and never queries', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);

    const res = await requestJson(server, 'POST', '/users/by-ids', { ids });

    expect(res.status).toBe(400);
    expect(mockGetUsersByIds).not.toHaveBeenCalled();
  });

  it('rejects a missing ids field with 400', async () => {
    const res = await requestJson(server, 'POST', '/users/by-ids', {});

    expect(res.status).toBe(400);
    expect(mockGetUsersByIds).not.toHaveBeenCalled();
  });

  it('returns { data: [...] } of public DTOs for valid ids', async () => {
    const dto = {
      id: 'u1',
      username: 'alice',
      name: { displayName: 'Alice', full: 'Alice', first: 'Alice' },
      avatar: 'file-1',
      _count: { followers: 12, following: 3 },
    };
    mockGetUsersByIds.mockResolvedValueOnce([dto]);

    const res = await requestJson(server, 'POST', '/users/by-ids', {
      ids: ['u1', 'u2'],
    });

    expect(res.status).toBe(200);
    expect(mockGetUsersByIds).toHaveBeenCalledTimes(1);
    expect(mockGetUsersByIds).toHaveBeenCalledWith(['u1', 'u2']);
    expect(res.body.data).toEqual([dto]);
    // Canonical, server-owned display name + counts ride along in the DTO.
    const data = res.body.data as Array<{ name: { displayName: string }; _count: unknown }>;
    expect(data[0].name.displayName).toBe('Alice');
    expect(data[0]._count).toEqual({ followers: 12, following: 3 });
  });

  it('is NOT captured by the /:userId param route (registered first)', async () => {
    mockGetUsersByIds.mockResolvedValueOnce([]);

    const res = await requestJson(server, 'POST', '/users/by-ids', {
      ids: ['000000000000000000000000'],
    });

    // A 200 from the bulk handler (not a 404/405 from a param route) proves the
    // `/by-ids` literal route won the match over `/:userId`.
    expect(res.status).toBe(200);
    expect(mockGetUsersByIds).toHaveBeenCalledTimes(1);
  });
});
