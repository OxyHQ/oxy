/**
 * GET|POST /auth/oauth/userinfo — OpenID Connect Core §5.3.
 *
 * The load-bearing test in this file is the `sub` one. `sub` is the identifier
 * relying parties store forever and key their local accounts on; Oxy usernames
 * are mutable AND case-sensitive (`Nate` and `nate` can be two accounts), so a
 * username-derived `sub` would hand one user's account to another after a
 * rename or a re-registration. It MUST be the account id, and nothing else.
 *
 * The rest pins the wire contract an OIDC client depends on: a FLAT claims
 * document, and RFC 6750 §3 `WWW-Authenticate: Bearer` challenges on failure.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const mockDecodeToken = jest.fn();
const mockValidateSessionToken = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: jest.fn(),
  serviceAuthMiddleware: jest.fn(),
  rejectQueryToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/authUtils', () => {
  const actual = jest.requireActual('../../middleware/authUtils') as Record<string, unknown>;
  return {
    ...actual,
    decodeToken: (...args: unknown[]) => mockDecodeToken(...args),
    validateSessionToken: (...args: unknown[]) => mockValidateSessionToken(...args),
  };
});

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/validate', () => ({
  validate: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));



jest.mock('../../services/authSession.service', () => ({
  claimAuthSession: jest.fn(),
  authorizeSessionWithSignedChallenge: jest.fn(),
  authorizeSessionWithBearer: jest.fn(),
}));





jest.mock('../../utils/userTransform', () => ({
  formatUserResponse: jest.fn(),
}));

jest.mock('../../utils/authSessionSocket', () => ({
  emitAuthSessionUpdate: jest.fn(),
}));

jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: { createSession: jest.fn() },
}));

jest.mock('../../services/deviceLogin.service', () => ({
  finalizeDeviceLogin: jest.fn(),
}));

jest.mock('../../services/oauthCode.service', () => ({
  issueAuthCode: jest.fn(),
  exchangeAuthCode: jest.fn(),
  AUTH_CODE_TTL_MS: 60_000,
  canonicalizeOAuthRedirectUri: (uri: string) => uri,
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

interface UserinfoResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

async function request(
  server: http.Server,
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<UserinfoResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method, host: '127.0.0.1', port: address.port, path, headers },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = raw.length > 0 ? JSON.parse(raw) : {};
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) {
      req.setHeader('Content-Type', 'application/x-www-form-urlencoded');
      req.setHeader('Content-Length', Buffer.byteLength(body));
      req.write(body);
    }
    req.end();
  });
}

/**
 * The signed-in account's permanent id. Spelled as a 24-char ObjectId hex
 * because that is what every migrated account id still is — they are preserved
 * verbatim into `users.id` (`db/MIGRATION-CONTRACT.md`); accounts created after
 * the cutover carry a uuid v7 instead, and the claim means the same thing.
 */
const USER_OBJECT_ID = '507f1f77bcf86cd799439011';
const BEARER = { authorization: 'Bearer valid-access-token' };

let server: http.Server;
let origin: string;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/auth', authRouter);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1', () => {
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDecodeToken.mockReturnValue({ sessionId: 'session-1' });
  // `validateSessionToken` returns the NORMALIZED user, whose `_id` is always the
  // account id (never the publicKey) — see `normalizeUser`.
  mockValidateSessionToken.mockResolvedValue({
    _id: USER_OBJECT_ID,
    username: 'nate',
    name: { first: 'Nate', last: 'Isern' },
    avatar: 'file-abc123',
  });
});

describe('GET /auth/oauth/userinfo — claims', () => {
  it('returns a FLAT claims document with the standard OIDC claims', async () => {
    const res = await request(server, 'GET', '/auth/oauth/userinfo', BEARER);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sub: USER_OBJECT_ID,
      preferred_username: 'nate',
      name: 'Nate Isern',
      picture: `${origin}/assets/file-abc123/stream`,
    });
    expect(res.body).not.toHaveProperty('data');
  });

  it('uses the permanent account id as `sub`, NEVER the username', async () => {
    mockValidateSessionToken.mockResolvedValueOnce({
      _id: USER_OBJECT_ID,
      username: 'Nate',
    });

    const res = await request(server, 'GET', '/auth/oauth/userinfo', BEARER);

    expect(res.status).toBe(200);
    expect(res.body.sub).toBe(USER_OBJECT_ID);
    // A username-derived `sub` would collide across renames and across the
    // case-distinct accounts `Nate` / `nate`, handing one user's identity to
    // another in every relying party.
    expect(res.body.sub).not.toBe('Nate');
    expect(res.body.sub).not.toBe('nate');
    expect(res.body.preferred_username).toBe('Nate');
  });

  it('keeps `sub` stable when the username changes', async () => {
    const before = await request(server, 'GET', '/auth/oauth/userinfo', BEARER);

    mockValidateSessionToken.mockResolvedValueOnce({
      _id: USER_OBJECT_ID,
      username: 'renamed-handle',
    });
    const after = await request(server, 'GET', '/auth/oauth/userinfo', BEARER);

    expect(after.body.sub).toBe(before.body.sub);
    expect(after.body.preferred_username).not.toBe(before.body.preferred_username);
  });

  it('omits `name` for an account with no real name — it is never synthesized from the handle', async () => {
    mockValidateSessionToken.mockResolvedValueOnce({
      _id: USER_OBJECT_ID,
      username: 'handle-only',
    });

    const res = await request(server, 'GET', '/auth/oauth/userinfo', BEARER);

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('name');
    expect(res.body.preferred_username).toBe('handle-only');
  });

  it('prefers an explicit displayName over the composed first/last name', async () => {
    mockValidateSessionToken.mockResolvedValueOnce({
      _id: USER_OBJECT_ID,
      username: 'nate',
      name: { first: 'Nate', last: 'Isern', displayName: 'Lady' },
    });

    const res = await request(server, 'GET', '/auth/oauth/userinfo', BEARER);

    expect(res.body.name).toBe('Lady');
  });

  it('omits `picture` for an account with no avatar', async () => {
    mockValidateSessionToken.mockResolvedValueOnce({
      _id: USER_OBJECT_ID,
      username: 'nate',
    });

    const res = await request(server, 'GET', '/auth/oauth/userinfo', BEARER);

    expect(res.body).not.toHaveProperty('picture');
  });

  it('passes an already-absolute avatar URL through unchanged (federated accounts)', async () => {
    mockValidateSessionToken.mockResolvedValueOnce({
      _id: USER_OBJECT_ID,
      username: 'remote',
      avatar: 'https://remote.example/avatars/remote.png',
    });

    const res = await request(server, 'GET', '/auth/oauth/userinfo', BEARER);

    expect(res.body.picture).toBe('https://remote.example/avatars/remote.png');
  });

  it('answers POST as well, as OIDC Core §5.3.1 requires', async () => {
    const res = await request(server, 'POST', '/auth/oauth/userinfo', BEARER);

    expect(res.status).toBe(200);
    expect(res.body.sub).toBe(USER_OBJECT_ID);
  });

  it('accepts POST with access_token in the form body', async () => {
    const res = await request(
      server,
      'POST',
      '/auth/oauth/userinfo',
      {},
      'access_token=valid-access-token',
    );

    expect(res.status).toBe(200);
    expect(res.body.sub).toBe(USER_OBJECT_ID);
    expect(mockValidateSessionToken).toHaveBeenCalledWith('valid-access-token');
  });

  it('sends the claims `no-store`', async () => {
    const res = await request(server, 'GET', '/auth/oauth/userinfo', BEARER);

    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('GET /auth/oauth/userinfo — RFC 6750 failures', () => {
  it('rejects an invalid token with a Bearer challenge', async () => {
    mockValidateSessionToken.mockResolvedValueOnce(null);

    const res = await request(server, 'GET', '/auth/oauth/userinfo', {
      authorization: 'Bearer expired-or-revoked',
    });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: 'invalid_token',
      error_description: expect.any(String),
    });
    expect(res.headers['www-authenticate']).toContain('Bearer');
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('answers a request with no Authorization header identically', async () => {
    mockDecodeToken.mockReturnValueOnce(null);

    const res = await request(server, 'GET', '/auth/oauth/userinfo');

    expect(res.status).toBe(401);
    // Same body and same challenge as an invalid token: the response never
    // confirms whether a presented token was recognised.
    expect(res.body.error).toBe('invalid_token');
    expect(res.headers['www-authenticate']).toContain('error="invalid_token"');
  });

  it('refuses a token passed in the query string', async () => {
    const res = await request(
      server,
      'GET',
      '/auth/oauth/userinfo?access_token=leaked-into-the-url',
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    // Never even attempted: a URL token must not be honoured, only refused.
    expect(mockValidateSessionToken).not.toHaveBeenCalled();
  });
});
