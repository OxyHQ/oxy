/**
 * `POST /auth/session/claim` — the device-flow token exchange — against a REAL
 * Postgres.
 *
 * The 128-bit `sessionToken` (held only by the originating client, never echoed
 * to observers) IS the credential, exactly as in RFC 8628 §3.4. The exchange is
 * SINGLE-USE: an `authorized` row transitions to `consumed`, so a replay is
 * rejected. Every failure mode collapses to one generic 401 `invalid_grant`
 * (RFC 6749 §5.2) so nothing enumerates which precondition failed.
 *
 * `claimAuthSession` runs FOR REAL here against the throwaway database, which
 * is the only way the single-use claim is actually tested — the previous suite
 * mocked it and asserted on the arguments it was handed.
 *
 * `session.service` (token minting) and `deviceSession.service` (the deviceSecret
 * mint) are mocked: collaborators, not the subject. Nothing about MongoDB is
 * mocked.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

const mockGetAccessToken = jest.fn();
const mockIssueDeviceSecret = jest.fn();
const mockAddDeviceAccount = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  serviceAuthMiddleware: jest.fn(),
  rejectQueryToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: {
    createSession: jest.fn(),
    getAccessToken: (...args: unknown[]) => mockGetAccessToken(...args),
  },
}));
jest.mock('../../services/deviceSession.service', () => {
  const service = {
    addAccount: (...args: unknown[]) => mockAddDeviceAccount(...args),
    issueDeviceSecret: (...args: unknown[]) => mockIssueDeviceSecret(...args),
  };
  return { __esModule: true, default: service, deviceSessionService: service };
});
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
import { applications } from '../../db/schema/applications';
import { authSessions } from '../../db/schema/authSessions';
import { sessions } from '../../db/schema/sessions';
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

const claim = (sessionToken: string) => post('/auth/session/claim', { sessionToken });

interface Fixture {
  sessionToken: string;
  userId: string;
  sessionId: string;
  deviceId: string;
}

/**
 * An APPROVED request plus the session it was approved into. Every id is unique
 * per call, so no assertion depends on a table being empty.
 */
async function approvedRequest(
  overrides: Partial<typeof authSessions.$inferInsert> = {},
  userFields: Partial<typeof users.$inferInsert> = {},
): Promise<Fixture> {
  const [user] = await getDb()
    .insert(users)
    .values({ username: `u${randomUUID().replace(/-/g, '').slice(0, 20)}`, ...userFields })
    .returning({ id: users.id });
  const [app] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID()}`, ownerAccountId: user.id })
    .returning({ id: applications.id });

  const sessionId = `sess-${randomUUID()}`;
  const deviceId = `dev-${randomUUID()}`;
  await getDb().insert(sessions).values({
    sessionId,
    userId: user.id,
    deviceId,
    deviceType: 'desktop',
    platform: 'web',
    // `sessions.access_token` / `.refresh_token` are UNIQUE, so a shared
    // literal would make the SECOND fixture in the run fail on the constraint
    // rather than on anything this suite is about.
    accessToken: `stored-access-${sessionId}`,
    refreshToken: `stored-refresh-${sessionId}`,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  const sessionToken = `at_${randomUUID().replace(/-/g, '')}`;
  await getDb()
    .insert(authSessions)
    .values({
      sessionToken,
      authorizeCode: randomUUID().replace(/-/g, ''),
      applicationId: app.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      status: 'authorized',
      authorizedUserId: user.id,
      authorizedSessionId: sessionId,
      ...overrides,
    });

  return { sessionToken, userId: user.id, sessionId, deviceId };
}

async function stored(sessionToken: string) {
  const [row] = await getDb()
    .select()
    .from(authSessions)
    .where(eq(authSessions.sessionToken, sessionToken))
    .limit(1);
  return row;
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
  mockGetAccessToken.mockResolvedValue({
    accessToken: 'fresh-access-token',
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  mockAddDeviceAccount.mockResolvedValue({ state: { accounts: [] }, changed: false });
  mockIssueDeviceSecret.mockResolvedValue(null);
});

describe('POST /auth/session/claim — every rejection is one generic invalid_grant', () => {
  it('rejects a missing sessionToken at the edge', async () => {
    const res = await post('/auth/session/claim', {});
    expect(res.status).toBe(400);
  });

  it('rejects an unknown sessionToken', async () => {
    const res = await claim(`at_${randomUUID().replace(/-/g, '')}`);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ message: 'invalid_grant' });
  });

  it.each(['pending', 'cancelled', 'consumed'] as const)(
    'rejects a %s request and leaves it as it found it',
    async (status) => {
      const { sessionToken } = await approvedRequest({ status });

      const res = await claim(sessionToken);

      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ message: 'invalid_grant' });
      expect((await stored(sessionToken)).status).toBe(status);
    },
  );

  it('rejects an EXPIRED authorized request', async () => {
    const { sessionToken } = await approvedRequest({ expiresAt: new Date(Date.now() - 1000) });

    const res = await claim(sessionToken);

    expect(res.status).toBe(401);
    expect((await stored(sessionToken)).status).toBe('authorized');
  });

  it('refuses to hand an OAuth authorization request an access token', async () => {
    const { sessionToken } = await approvedRequest({
      purpose: 'oauth_authorization',
      oauthRedirectUri: 'https://rp.example/cb',
      oauthCodeChallenge: 'x'.repeat(43),
      oauthCodeChallengeMethod: 'S256',
      oauthScopes: ['user:read'],
    });

    const res = await claim(sessionToken);

    expect(res.status).toBe(401);
    expect(mockGetAccessToken).not.toHaveBeenCalled();
    // Still authorized — its result is the code minted by finalize.
    expect((await stored(sessionToken)).status).toBe('authorized');
  });

  it('rejects when no access token can be resolved for the claimed session', async () => {
    const { sessionToken } = await approvedRequest();
    mockGetAccessToken.mockResolvedValueOnce(null);

    const res = await claim(sessionToken);

    expect(res.status).toBe(401);
  });

  it('rejects when the underlying session row has disappeared', async () => {
    const { sessionToken, sessionId } = await approvedRequest();
    await getDb().delete(sessions).where(eq(sessions.sessionId, sessionId));

    const res = await claim(sessionToken);

    expect(res.status).toBe(401);
  });
});

describe('POST /auth/session/claim — the happy path', () => {
  it('returns the access token, session, device and user, and SPENDS the request', async () => {
    const { sessionToken, userId, sessionId, deviceId } = await approvedRequest(
      {},
      { nameFirst: 'Ada', nameLast: 'Lovelace' },
    );

    const res = await claim(sessionToken);

    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, unknown>;
    expect(data.accessToken).toBe('fresh-access-token');
    expect(data.sessionId).toBe(sessionId);
    expect(data.deviceId).toBe(deviceId);
    expect(typeof data.expiresAt).toBe('string');

    // The wire contract every ecosystem app parses with zod.
    const user = data.user as { id: string; name: { displayName?: string } };
    expect(user.id).toBe(userId);
    expect(user.name.displayName).toBe('Ada Lovelace');

    // Single-use: the row is spent, with the moment recorded.
    const row = await stored(sessionToken);
    expect(row.status).toBe('consumed');
    expect(row.consumedAt).toBeInstanceOf(Date);
  });

  // Defence in depth on the RESPONSE, not a guard on the read: `publicColumns`
  // is what keeps the protected columns out of the query, and the thing that
  // fails when the read regresses to a bare `select()` is the repo-wide scan in
  // `db/schema/__tests__/protectedColumns.test.ts`, which names the file:line.
  // Mutation-checked: swapping `publicColumns(users)` for `select()` leaves
  // THIS test green (the serializer builds an explicit DTO either way) and turns
  // that gate red. Do not read this case as covering the select.
  it('serializes no protected user value into the response', async () => {
    const { sessionToken } = await approvedRequest(
      {},
      { phone: '+15551234567', refreshToken: 'user-refresh-token' },
    );

    const res = await claim(sessionToken);

    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('+15551234567');
    expect(serialized).not.toContain('user-refresh-token');
    expect(serialized).not.toContain('hashedEmail');
    expect(serialized).not.toContain('hashedPhone');
  });

  it('rejects a REPLAY of a successful claim', async () => {
    const { sessionToken } = await approvedRequest();

    const first = await claim(sessionToken);
    const second = await claim(sessionToken);

    expect(first.status).toBe(200);
    expect(second.status).toBe(401);
    expect(second.body).toMatchObject({ message: 'invalid_grant' });
  });

  it('lets exactly ONE of two concurrent claims succeed', async () => {
    const { sessionToken } = await approvedRequest();

    const results = await Promise.all([claim(sessionToken), claim(sessionToken)]);
    const statuses = results.map((res) => res.status).sort();

    expect(statuses).toEqual([200, 401]);
    expect((await stored(sessionToken)).status).toBe('consumed');
  });

  it('includes a rotating deviceSecret when one could be minted', async () => {
    const { sessionToken, userId, sessionId, deviceId } = await approvedRequest();
    mockIssueDeviceSecret.mockResolvedValueOnce('rotating-device-secret');

    const res = await claim(sessionToken);

    expect(res.status).toBe(200);
    expect(mockAddDeviceAccount).toHaveBeenCalledWith(
      deviceId,
      { accountId: userId, sessionId },
      { activate: 'if-empty' },
    );
    expect(mockIssueDeviceSecret).toHaveBeenCalledWith(deviceId);
    expect((res.body.data as { deviceSecret: string }).deviceSecret).toBe('rotating-device-secret');
  });

  it('still succeeds, without a deviceSecret, when the mint throws', async () => {
    const { sessionToken } = await approvedRequest();
    mockIssueDeviceSecret.mockRejectedValueOnce(new Error('valkey down'));

    const res = await claim(sessionToken);

    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('deviceSecret');
  });
});
