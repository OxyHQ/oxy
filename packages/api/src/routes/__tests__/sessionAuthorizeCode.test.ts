/**
 * /auth/session/authorize-code/:authorizeCode route tests.
 *
 * Bearer-authed sibling of `/auth/session/authorize/:sessionToken` (see
 * `sessionAuthorize.test.ts`), keyed on the PUBLIC `authorizeCode` instead of
 * the secret `sessionToken` — for an approver (e.g. the auth.oxy.so passkey
 * hub) that authenticates via bearer token but never holds the secret.
 *
 * The actual claim/mint logic (atomic burn, origin-verified audit log) lives
 * in `authorizeSessionWithBearer` and is unit-tested in
 * `services/__tests__/authorizeSessionWithBearer.test.ts` — this file only
 * covers the route's plumbing: bearer-required, and outcome -> status-code
 * mapping.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const mockAuthMiddleware = jest.fn();
const mockAuthorizeSessionWithBearer = jest.fn();
const mockEmitAuthSessionUpdate = jest.fn();
const mockAuthSessionFindOne = jest.fn();
const mockApplicationFindOne = jest.fn();
const mockApplicationCredentialFindOne = jest.fn();
const mockAuthCodeCreate = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (...args: unknown[]) => mockAuthMiddleware(...args),
  serviceAuthMiddleware: jest.fn(),
  rejectQueryToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/validate', () => ({
  validate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// This route only touches AuthSession through the mocked service below; the
// bare default-export is required so sibling routes in the same module load.
jest.mock('../../services/authSession.service', () => ({
  claimAuthSession: jest.fn(),
  authorizeSessionWithSignedChallenge: jest.fn(),
  authorizeSessionWithBearer: (...args: unknown[]) => mockAuthorizeSessionWithBearer(...args),
}));

jest.mock('../../utils/userTransform', () => ({
  formatUserResponse: jest.fn(),
}));

jest.mock('../../utils/authSessionSocket', () => ({
  emitAuthSessionUpdate: mockEmitAuthSessionUpdate,
}));

jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: { createSession: jest.fn() },
}));

jest.mock('../../services/oauthCode.service', () => ({
  issueAuthCode: jest.fn(),
  exchangeAuthCode: jest.fn(),
  AUTH_CODE_TTL_MS: 60_000,
}));

jest.mock('../../services/signature.service', () => ({
  __esModule: true,
  default: {
    isValidPublicKey: jest.fn(),
    verifyChallengeResponse: jest.fn(),
    verifyRegistrationSignature: jest.fn(),
    verifySignature: jest.fn(),
    generateChallenge: jest.fn(),
    shortenPublicKey: jest.fn(),
  },
}));

jest.mock('../../controllers/session.controller', () => ({
  SessionController: {
    register: jest.fn(),
    signUp: jest.fn(),
    signIn: jest.fn(),
    requestChallenge: jest.fn(),
    verifyChallenge: jest.fn(),
    requestPasswordReset: jest.fn(),
    verifyRecoveryCode: jest.fn(),
    resetPassword: jest.fn(),
    getUserByPublicKey: jest.fn(),
  },
}));

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import authRouter from '../auth';
import { errorHandler } from '../../middleware/errorHandler';

interface JsonResponse {
  status: number;
  body: { error?: string; message?: string };
}

async function requestJson(
  server: http.Server,
  method: string,
  path: string,
  payload: unknown,
  headers: Record<string, string> = {}
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
          ...headers,
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
      }
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
  app.use('/auth', authRouter);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1', done);
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
});

function authenticateAs(userId: string, over: Record<string, unknown> = {}) {
  mockAuthMiddleware.mockImplementationOnce(
    (req: { user?: unknown }, _res: unknown, next: () => void) => {
      req.user = { _id: { toString: () => userId }, username: 'someone', ...over };
      next();
    }
  );
}

describe('POST /auth/session/authorize-code/:authorizeCode', () => {
  it('returns 401 when no Authorization header is present — the service is never invoked', async () => {
    mockAuthMiddleware.mockImplementationOnce(
      (_req: unknown, res: { status: (n: number) => { json: (v: unknown) => unknown } }) => {
        res.status(401).json({ error: 'Authentication required', message: 'Invalid or missing authorization header' });
      }
    );

    const res = await requestJson(server, 'POST', '/auth/session/authorize-code/code-abc', {});

    expect(res.status).toBe(401);
    expect(mockAuthorizeSessionWithBearer).not.toHaveBeenCalled();
  });

  it('authorizes on success and wakes the waiting originator on its (secret) sessionToken channel', async () => {
    authenticateAs('user-1');
    mockAuthorizeSessionWithBearer.mockResolvedValueOnce({
      ok: true,
      sessionToken: 'secret-only-the-opener-holds',
      sessionId: 'sess-1',
    });

    const res = await requestJson(
      server,
      'POST',
      '/auth/session/authorize-code/code-abc',
      {},
      { Authorization: 'Bearer valid-bearer-token' },
    );

    expect(res.status).toBe(200);
    expect(mockAuthorizeSessionWithBearer).toHaveBeenCalledWith(
      expect.objectContaining({ authorizeCode: 'code-abc', authenticatedUserId: 'user-1' }),
    );
    expect(mockEmitAuthSessionUpdate).toHaveBeenCalledWith(
      'secret-only-the-opener-holds',
      expect.objectContaining({ status: 'authorized', sessionId: 'sess-1' }),
    );
  });

  it('maps a 404 outcome (unknown/already-processed code) straight through', async () => {
    authenticateAs('user-1');
    mockAuthorizeSessionWithBearer.mockResolvedValueOnce({
      ok: false,
      status: 404,
      message: 'Auth session not found or already processed',
    });

    const res = await requestJson(
      server,
      'POST',
      '/auth/session/authorize-code/unknown-code',
      {},
      { Authorization: 'Bearer valid-bearer-token' },
    );

    expect(res.status).toBe(404);
    expect(mockEmitAuthSessionUpdate).not.toHaveBeenCalled();
  });

  it('maps a 400 outcome (expired code) straight through', async () => {
    authenticateAs('user-1');
    mockAuthorizeSessionWithBearer.mockResolvedValueOnce({
      ok: false,
      status: 400,
      message: 'Auth session has expired',
    });

    const res = await requestJson(
      server,
      'POST',
      '/auth/session/authorize-code/expired-code',
      {},
      { Authorization: 'Bearer valid-bearer-token' },
    );

    expect(res.status).toBe(400);
    expect(mockEmitAuthSessionUpdate).not.toHaveBeenCalled();
  });
});
