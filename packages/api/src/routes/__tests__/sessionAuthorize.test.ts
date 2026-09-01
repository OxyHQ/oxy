/**
 * `POST /auth/session/authorize/:sessionToken`, against a REAL Postgres.
 *
 * The authenticated principal (bearer) is the ONLY source of "who is
 * authorising" — the pre-C2 route trusted an `x-session-id` header, so anyone
 * with a captured session id could approve a cross-app sign-in on the victim's
 * behalf. These tests pin that, plus the two branches the request model turns
 * on: a device sign-in mints a session, an OAuth authorization request does NOT
 * (its result is the code minted by `POST /auth/session/finalize`).
 *
 * The previous version mocked `models/AuthSession` and asserted that
 * `session.save()` had been called with certain in-memory mutations. Every
 * assertion here reads the `auth_sessions` row back out of Postgres, so a write
 * that was built correctly but never landed fails.
 *
 * `session.service` and the socket emitters are mocked — collaborators, not the
 * subject. Nothing about MongoDB is mocked.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

const mockCreateSession = jest.fn();
const mockEmitAuthSessionUpdate = jest.fn();
const mockBroadcastSessionAccountsChanged = jest.fn();
const mockVerifyActingAs = jest.fn();

let authenticatedUser: { _id: string; username?: string; publicKey?: string } | null = null;

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }, next: () => void) => {
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
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    getAccessToken: jest.fn(),
  },
}));
// `verifyDelegatedSubject` reaches the account graph through this service; it is
// the delegation AUTHORITY, not the subject of this suite.
jest.mock('../../services/account.service', () => ({
  __esModule: true,
  accountService: { verifyActingAs: (...args: unknown[]) => mockVerifyActingAs(...args) },
  default: { verifyActingAs: (...args: unknown[]) => mockVerifyActingAs(...args) },
}));
jest.mock('../../utils/authSessionSocket', () => ({
  emitAuthSessionUpdate: (...args: unknown[]) => mockEmitAuthSessionUpdate(...args),
  emitAuthSessionProgress: jest.fn(),
}));
jest.mock('../../utils/socket', () => ({
  broadcastSessionAccountsChanged: (...args: unknown[]) =>
    mockBroadcastSessionAccountsChanged(...args),
}));
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
import { applications } from '../../db/schema/applications';
import { authSessions } from '../../db/schema/authSessions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import authRouter from '../auth';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

let server: http.Server;

function post(path: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<JsonResponse> {
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
          ...headers,
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

async function account(fields: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb().insert(users).values(fields).returning({ id: users.id });
  return row.id;
}

async function application(fields: Partial<typeof applications.$inferInsert> = {}): Promise<string> {
  const ownerAccountId = fields.ownerAccountId ?? (await account());
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID()}`, ...fields, ownerAccountId })
    .returning({ id: applications.id });
  return row.id;
}

async function pendingRequest(
  overrides: Partial<typeof authSessions.$inferInsert> = {},
): Promise<string> {
  const applicationId = overrides.applicationId ?? (await application({ name: 'Acme Widgets' }));
  const sessionToken = `at_${randomUUID().replace(/-/g, '')}`;
  await getDb()
    .insert(authSessions)
    .values({
      sessionToken,
      authorizeCode: randomUUID().replace(/-/g, ''),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      status: 'pending',
      ...overrides,
      applicationId,
    });
  return sessionToken;
}

async function stored(sessionToken: string) {
  const [row] = await getDb()
    .select()
    .from(authSessions)
    .where(eq(authSessions.sessionToken, sessionToken))
    .limit(1);
  return row;
}

/** The all-or-nothing OAuth binding, written the way `/session/create` writes it. */
function oauthBinding(subjectAccountId: string | null) {
  return {
    purpose: 'oauth_authorization' as const,
    oauthRedirectUri: 'https://rp.example/cb',
    oauthCodeChallenge: 'x'.repeat(43),
    oauthCodeChallengeMethod: 'S256' as const,
    oauthScopes: ['user:read'],
    oauthSubjectAccountId: subjectAccountId,
  };
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

beforeEach(() => {
  jest.clearAllMocks();
  authenticatedUser = null;
  mockCreateSession.mockResolvedValue({ sessionId: 'minted-session-id' });
});

describe('POST /auth/session/authorize/:sessionToken — the bearer is the principal', () => {
  it('returns 401 with no Authorization header, even with an x-session-id', async () => {
    const sessionToken = await pendingRequest();

    const res = await post(`/auth/session/authorize/${sessionToken}`, {}, {
      'x-session-id': 'captured-session-id',
    });

    expect(res.status).toBe(401);
    // The request is untouched: still pending, still nobody's approval.
    const row = await stored(sessionToken);
    expect(row.status).toBe('pending');
    expect(row.authorizedUserId).toBeNull();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('authorizes as the BEARER principal and mints a session for a device sign-in', async () => {
    const approverId = await account({ publicKey: `02${randomUUID().replace(/-/g, '')}` });
    const [approver] = await getDb()
      .select({ publicKey: users.publicKey })
      .from(users)
      .where(eq(users.id, approverId))
      .limit(1);
    authenticatedUser = { _id: approverId, username: 'nate', publicKey: approver.publicKey ?? undefined };
    const sessionToken = await pendingRequest();

    const res = await post(`/auth/session/authorize/${sessionToken}`, {}, {
      'x-session-id': 'captured-session-id',
    });

    expect(res.status).toBe(200);
    const row = await stored(sessionToken);
    expect(row.status).toBe('authorized');
    expect(row.authorizedUserId).toBe(approverId);
    expect(row.authorizedBy).toBe(approver.publicKey);
    expect(row.authorizedSessionId).toBe('minted-session-id');
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(mockEmitAuthSessionUpdate).toHaveBeenCalledWith(
      sessionToken,
      expect.objectContaining({ status: 'authorized', userId: approverId }),
    );
    expect(mockBroadcastSessionAccountsChanged).toHaveBeenCalledWith(approverId, 0, 'login');
  });

  it('labels the minted session with the bound application name', async () => {
    authenticatedUser = { _id: await account(), username: 'nate' };
    const applicationId = await application({ name: 'Acme Widgets' });
    const sessionToken = await pendingRequest({ applicationId, deviceId: 'dev-abc' });

    await post(`/auth/session/authorize/${sessionToken}`);

    expect(mockCreateSession).toHaveBeenCalledWith(
      authenticatedUser._id,
      expect.anything(),
      expect.objectContaining({ deviceName: 'Acme Widgets App', deviceId: 'dev-abc' }),
    );
  });

  it('404s a request that is not pending, without minting anything', async () => {
    authenticatedUser = { _id: await account() };
    const sessionToken = await pendingRequest({ status: 'cancelled' });

    const res = await post(`/auth/session/authorize/${sessionToken}`);

    expect(res.status).toBe(404);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('400s an expired request and writes the expiry back', async () => {
    authenticatedUser = { _id: await account() };
    const sessionToken = await pendingRequest({ expiresAt: new Date(Date.now() - 1000) });

    const res = await post(`/auth/session/authorize/${sessionToken}`);

    expect(res.status).toBe(400);
    expect((await stored(sessionToken)).status).toBe('expired');
    expect(mockCreateSession).not.toHaveBeenCalled();
  });
});

describe('POST /auth/session/authorize/:sessionToken — an OAuth request mints NO session', () => {
  it('authorizes an OAuth-bound request without creating a session', async () => {
    const approverId = await account();
    authenticatedUser = { _id: approverId };
    const sessionToken = await pendingRequest(oauthBinding(null));

    const res = await post(`/auth/session/authorize/${sessionToken}`);

    expect(res.status).toBe(200);
    const row = await stored(sessionToken);
    expect(row.status).toBe('authorized');
    expect(row.authorizedUserId).toBe(approverId);
    // Its result is the code minted by finalize — never an access token.
    expect(row.authorizedSessionId).toBeNull();
    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(mockBroadcastSessionAccountsChanged).not.toHaveBeenCalled();
  });

  it('refuses an approval whose identity cannot act as the DELEGATED subject', async () => {
    const approverId = await account();
    authenticatedUser = { _id: approverId };
    const org = await account({ kind: 'organization' });
    const sessionToken = await pendingRequest(oauthBinding(org));
    mockVerifyActingAs.mockResolvedValue(null);

    const res = await post(`/auth/session/authorize/${sessionToken}`);

    expect(res.status).toBe(403);
    const row = await stored(sessionToken);
    expect(row.status).toBe('pending');
    expect(row.authorizedUserId).toBeNull();
  });

  it('authorizes a PERMITTED delegated subject, still without minting a session', async () => {
    const approverId = await account();
    authenticatedUser = { _id: approverId };
    const org = await account({ kind: 'organization' });
    const sessionToken = await pendingRequest(oauthBinding(org));
    mockVerifyActingAs.mockResolvedValue('admin');

    const res = await post(`/auth/session/authorize/${sessionToken}`);

    expect(res.status).toBe(200);
    const row = await stored(sessionToken);
    expect(row.status).toBe('authorized');
    expect(row.authorizedSessionId).toBeNull();
    expect(mockVerifyActingAs).toHaveBeenCalledWith(approverId, org);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('never accepts a PERSONAL account as a delegated subject', async () => {
    authenticatedUser = { _id: await account() };
    const personal = await account({ kind: 'personal' });
    const sessionToken = await pendingRequest(oauthBinding(personal));
    // Even a permissive account service cannot rescue this: assuming a human
    // login is impersonation, refused before the membership check runs.
    mockVerifyActingAs.mockResolvedValue('owner');

    const res = await post(`/auth/session/authorize/${sessionToken}`);

    expect(res.status).toBe(403);
    expect(mockVerifyActingAs).not.toHaveBeenCalled();
    expect((await stored(sessionToken)).status).toBe('pending');
  });
});
