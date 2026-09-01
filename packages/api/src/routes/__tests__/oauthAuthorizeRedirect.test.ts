/**
 * `POST /auth/oauth/authorize` — the redirect_uri allowlist — against a REAL
 * Postgres.
 *
 * RFC 6749 §3.1.2.4: the server MUST NOT redirect when the URI is not
 * registered, and the match is EXACT. Prefix/suffix matching is the source of
 * countless open-redirect vulnerabilities, so the negative cases here are the
 * point of the suite.
 *
 * `oauthCode.service` is mocked — the code MINT is a separate, still-Mongo
 * collaborator; what this suite pins is which requests reach it at all, and with
 * what bindings. Applications and credentials are real rows, so credential
 * usability (`revoked`, rotation grace) is exercised rather than stubbed.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

const mockIssueAuthCode = jest.fn();

let authenticatedUser: { _id: string; username?: string } | null = null;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: unknown },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (!authenticatedUser) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    req.user = authenticatedUser;
    next();
  },
  serviceAuthMiddleware: jest.fn(),
  rejectQueryToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/authUtils', () => ({
  extractTokenFromRequest: () => null,
  decodeToken: () => null,
}));
jest.mock('../../services/oauthCode.service', () => {
  const actual = jest.requireActual<typeof import('../../services/oauthCode.service')>(
    '../../services/oauthCode.service',
  );
  return {
    ...actual,
    issueAuthCode: (...args: unknown[]) => mockIssueAuthCode(...args),
    exchangeAuthCode: jest.fn(),
  };
});
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: { createSession: jest.fn(), getAccessToken: jest.fn() },
}));
jest.mock('../../utils/authSessionSocket', () => ({
  emitAuthSessionUpdate: jest.fn(),
  emitAuthSessionProgress: jest.fn(),
}));
jest.mock('../../utils/socket', () => ({ broadcastSessionAccountsChanged: jest.fn() }));
jest.mock('../../controllers/session.controller', () => ({
  SessionController: {
    register: jest.fn(),
    requestChallenge: jest.fn(),
    verifyChallenge: jest.fn(),
    getUserByPublicKey: jest.fn(),
  },
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import authRouter from '../auth';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

let server: http.Server;

function post(path: string, body: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} }),
        );
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** A third-party application with the given redirect allowlist, plus its client id. */
async function client(
  redirectUris: string[],
  credentialFields: Partial<typeof applicationCredentials.$inferInsert> = {},
): Promise<{ clientId: string; applicationId: string }> {
  const [owner] = await getDb().insert(users).values({}).returning({ id: users.id });
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      ownerAccountId: owner.id,
      type: 'third_party',
      scopes: ['user:read'],
      redirectUris,
    })
    .returning({ id: applications.id });
  const clientId = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: app.id,
      name: 'client',
      type: 'public',
      environment: 'production',
      ...credentialFields,
      publicKey: clientId,
    });
  return { clientId, applicationId: app.id };
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/auth', authRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockIssueAuthCode.mockResolvedValue({ code: 'raw-code', expiresAt: new Date() });
  const [user] = await getDb().insert(users).values({}).returning({ id: users.id });
  authenticatedUser = { _id: user.id, username: 'nate' };
});

describe('POST /auth/oauth/authorize — redirect_uri allowlist', () => {
  it('accepts an EXACTLY registered redirect_uri and mints a code', async () => {
    const { clientId, applicationId } = await client(['https://acme.example/oauth/callback']);

    const res = await post('/auth/oauth/authorize', {
      clientId,
      redirectUri: 'https://acme.example/oauth/callback',
      state: 'st',
      scope: 'user:read',
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      code: 'raw-code',
      state: 'st',
      redirectUri: 'https://acme.example/oauth/callback',
    });
    expect(mockIssueAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: authenticatedUser?._id,
        appId: applicationId,
        redirectUri: 'https://acme.example/oauth/callback',
        scopes: ['user:read'],
      }),
    );
  });

  it('rejects a redirect_uri differing only by a trailing slash on a PATH', async () => {
    const { clientId } = await client(['https://acme.example/oauth/callback']);

    const res = await post('/auth/oauth/authorize', {
      clientId,
      redirectUri: 'https://acme.example/oauth/callback/',
    });

    expect(res.status).toBe(403);
    expect(mockIssueAuthCode).not.toHaveBeenCalled();
  });

  it('rejects an unrelated redirect_uri', async () => {
    const { clientId } = await client(['https://acme.example/oauth/callback']);

    const res = await post('/auth/oauth/authorize', {
      clientId,
      redirectUri: 'https://evil.example/steal',
    });

    expect(res.status).toBe(403);
    expect(mockIssueAuthCode).not.toHaveBeenCalled();
  });

  it('rejects a PREFIX of a registered redirect_uri', async () => {
    const { clientId } = await client(['https://acme.example/oauth/callback']);

    const res = await post('/auth/oauth/authorize', {
      clientId,
      redirectUri: 'https://acme.example/oauth',
    });

    expect(res.status).toBe(403);
    expect(mockIssueAuthCode).not.toHaveBeenCalled();
  });

  it('accepts any ONE of several registered redirect URIs', async () => {
    const { clientId } = await client([
      'https://acme.example/a',
      'https://acme.example/b',
      'https://acme.example/c',
    ]);

    const res = await post('/auth/oauth/authorize', {
      clientId,
      redirectUri: 'https://acme.example/b',
    });

    expect(res.status).toBe(200);
  });

  it('accepts a registered localhost callback', async () => {
    const { clientId } = await client(['http://localhost:8081/callback']);

    const res = await post('/auth/oauth/authorize', {
      clientId,
      redirectUri: 'http://localhost:8081/callback',
    });

    expect(res.status).toBe(200);
  });

  it('rejects everything when the app registered NO redirect URIs', async () => {
    const { clientId } = await client([]);

    const res = await post('/auth/oauth/authorize', {
      clientId,
      redirectUri: 'https://acme.example/oauth/callback',
    });

    expect(res.status).toBe(403);
    expect(mockIssueAuthCode).not.toHaveBeenCalled();
  });
});

describe('POST /auth/oauth/authorize — client resolution', () => {
  it('rejects an unknown client with 400 and no code', async () => {
    const res = await post('/auth/oauth/authorize', {
      clientId: 'oxy_dk_unknown',
      redirectUri: 'https://acme.example/oauth/callback',
    });

    expect(res.status).toBe(400);
    expect(mockIssueAuthCode).not.toHaveBeenCalled();
  });

  it('rejects a REVOKED credential with 400', async () => {
    const { clientId } = await client(['https://acme.example/cb'], { status: 'revoked' });

    const res = await post('/auth/oauth/authorize', {
      clientId,
      redirectUri: 'https://acme.example/cb',
    });

    expect(res.status).toBe(400);
    expect(mockIssueAuthCode).not.toHaveBeenCalled();
  });

  it('rejects a deprecated credential whose rotation grace has elapsed', async () => {
    const { clientId } = await client(['https://acme.example/cb'], {
      status: 'deprecated',
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await post('/auth/oauth/authorize', {
      clientId,
      redirectUri: 'https://acme.example/cb',
    });

    expect(res.status).toBe(400);
  });

  it('ACCEPTS a deprecated credential still inside its rotation grace', async () => {
    const { clientId } = await client(['https://acme.example/cb'], {
      status: 'deprecated',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await post('/auth/oauth/authorize', {
      clientId,
      redirectUri: 'https://acme.example/cb',
    });

    expect(res.status).toBe(200);
  });

  it('rejects when the owning application is no longer active', async () => {
    const { clientId, applicationId } = await client(['https://acme.example/cb']);
    await getDb()
      .update(applications)
      .set({ status: 'suspended' })
      .where(eq(applications.id, applicationId));

    const res = await post('/auth/oauth/authorize', {
      clientId,
      redirectUri: 'https://acme.example/cb',
    });

    expect(res.status).toBe(400);
    expect(mockIssueAuthCode).not.toHaveBeenCalled();
  });

  it('rejects a non-S256 PKCE method before anything is minted', async () => {
    const { clientId } = await client(['https://acme.example/cb']);

    const res = await post('/auth/oauth/authorize', {
      clientId,
      redirectUri: 'https://acme.example/cb',
      codeChallenge: 'x'.repeat(43),
      codeChallengeMethod: 'plain',
    });

    expect(res.status).toBe(400);
    expect(mockIssueAuthCode).not.toHaveBeenCalled();
  });
});
