/**
 * POST /auth/session/deliver/:authorizeCode
 * POST /auth/session/opened/:authorizeCode
 * GET  /auth/session/status/:sessionToken  (delivery-progress projection)
 *
 * Phase 4 automatic Commons delivery, exercised end to end through the REAL
 * route, the REAL delivery service and a REAL Postgres, with only the push
 * TRANSPORT (`exp.host`) and the socket emitter mocked.
 *
 * The security contract these tests exist to pin:
 *
 *  - `deliver` REQUIRES a bearer, and the bearer is the control, not a
 *    convenience: the delivery target is the AUTHENTICATED user, never anything
 *    from the request body or the bound request. Oxy can therefore never be made
 *    to push a sign-in prompt at someone by typing their username into an
 *    unauthenticated browser. Proving that needs a SECOND identity with its own
 *    capable install actually stored — which is why the installs here are rows,
 *    not stubs.
 *  - Only installs of an `Application` carrying the staff-controlled
 *    `identity:approval` capability are targeted. No capable install ⇒ zero
 *    targets, no send, and a 200 (the client falls back to QR).
 *  - The response is counts only, and the push payload is exactly
 *    `{ type, approvalUrl }`.
 *  - `opened` needs no bearer (the public approval handle is the credential), is
 *    idempotent, pending-only, and never moves `status`.
 *  - Progress travels as TIMESTAMPS on the status endpoint; the socket emission
 *    is a payload-free wake signal.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const mockSendPushToTokens = jest.fn();
const mockEmitAuthSessionUpdate = jest.fn();
const mockEmitAuthSessionProgress = jest.fn();

/** Identity the mocked bearer middleware resolves for an authenticated request. */
const mockBearerUser = { current: '' };

jest.mock('../../middleware/auth', () => ({
  // Behaves like the real middleware for the one property under test: without an
  // Authorization header there is no authenticated principal and the request is
  // rejected before the handler runs.
  authMiddleware: (
    req: { headers: Record<string, string | undefined>; user?: unknown },
    res: { status: (code: number) => { json: (body: unknown) => void } },
    next: () => void,
  ) => {
    if (!req.headers.authorization) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }
    req.user = { _id: mockBearerUser.current, username: 'ada', publicKey: 'pk-1' };
    next();
  },
  serviceAuthMiddleware: jest.fn(),
  rejectQueryToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../services/push.service', () => ({
  __esModule: true,
  pushService: { sendPushToTokens: mockSendPushToTokens, sendPushNotification: jest.fn() },
  default: { sendPushToTokens: mockSendPushToTokens, sendPushNotification: jest.fn() },
}));
jest.mock('../../utils/authSessionSocket', () => ({
  emitAuthSessionUpdate: (...args: unknown[]) => mockEmitAuthSessionUpdate(...args),
  emitAuthSessionProgress: (...args: unknown[]) => mockEmitAuthSessionProgress(...args),
}));

// Remaining static imports of routes/auth.ts — mocked so this suite loads the
// route without standing up the whole auth service graph behind it.
jest.mock('../../services/authSession.service', () => ({
  claimAuthSession: jest.fn(),
  authorizeSessionWithSignedChallenge: jest.fn(),
  authorizeSessionWithBearer: jest.fn(),
  finalizeOAuthAuthorization: jest.fn(),
  resolveOAuthContext: jest.fn(() => null),
  verifyDelegatedSubject: jest.fn(),
}));
jest.mock('../../services/session.service', () => ({ __esModule: true, default: { createSession: jest.fn() } }));
jest.mock('../../services/oauthCode.service', () => ({ issueAuthCode: jest.fn(), exchangeAuthCode: jest.fn(), AUTH_CODE_TTL_MS: 60_000 }));
jest.mock('../../services/signature.service', () => ({ __esModule: true, default: { verifyChallengeResponse: jest.fn(), isValidPublicKey: jest.fn() } }));
jest.mock('../../utils/userTransform', () => ({ formatUserResponse: jest.fn() }));
jest.mock('../../controllers/session.controller', () => ({
  SessionController: {
    register: jest.fn(), signUp: jest.fn(), signIn: jest.fn(), requestChallenge: jest.fn(),
    verifyChallenge: jest.fn(), requestPasswordReset: jest.fn(), verifyRecoveryCode: jest.fn(),
    resetPassword: jest.fn(), getUserByPublicKey: jest.fn(),
  },
}));
jest.mock('../../utils/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import authRouter from '../auth';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications as applicationsTable } from '../../db/schema/applications';
import { authSessions } from '../../db/schema/authSessions';
import { pushTokens } from '../../db/schema/pushTokens';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { IDENTITY_APPROVAL_CAPABILITY } from '../../utils/applicationCapabilities';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  options: { bearer?: string; payload?: Record<string, unknown> } = {},
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = JSON.stringify(options.payload ?? {});
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  };
  if (options.bearer) {
    headers.authorization = `Bearer ${options.bearer}`;
  }

  return new Promise((resolve, reject) => {
    const req = http.request({ method, host: '127.0.0.1', port: address.port, path, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

let server: http.Server;
let USER_ID: string;
let VICTIM_ID: string;
let VAULT_APP_ID: string;

/** The literal secret every case checks never reaches the client. */
const SECRET_MARKER = 'SECRET-session-token-do-not-leak';

async function insertUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  return row.id;
}

async function insertApplication(
  fields: Partial<typeof applicationsTable.$inferInsert> = {},
): Promise<string> {
  const ownerAccountId = fields.ownerAccountId ?? (await insertUser());
  const [row] = await getDb()
    .insert(applicationsTable)
    .values({ name: `App ${randomUUID()}`, ...fields, ownerAccountId })
    .returning({ id: applicationsTable.id });
  return row.id;
}

async function insertInstall(userId: string, token: string, applicationId: string | null) {
  await getDb().insert(pushTokens).values({ userId, token, platform: 'ios', applicationId });
}

interface StoredRequest {
  authorizeCode: string;
  sessionToken: string;
}

async function storedPendingRequest(
  overrides: Partial<typeof authSessions.$inferInsert> = {},
): Promise<StoredRequest> {
  const applicationId = overrides.applicationId ?? VAULT_APP_ID;
  const sessionToken = `${SECRET_MARKER}-${randomUUID()}`;
  const authorizeCode = randomUUID().replace(/-/g, '');
  await getDb()
    .insert(authSessions)
    .values({
      sessionToken,
      authorizeCode,
      expiresAt: new Date(Date.now() + 3_600_000),
      status: 'pending',
      ...overrides,
      applicationId,
    });
  return { authorizeCode, sessionToken };
}

async function storedRow(authorizeCode: string) {
  const [row] = await getDb()
    .select({
      status: authSessions.status,
      pushSentAt: authSessions.pushSentAt,
      openedAt: authSessions.openedAt,
    })
    .from(authSessions)
    .where(eq(authSessions.authorizeCode, authorizeCode))
    .limit(1);
  return row;
}

/** The tokens the push transport was handed. */
function pushedTokens(): string[] {
  return (mockSendPushToTokens.mock.calls[0]?.[0] as { tokens: string[] } | undefined)?.tokens ?? [];
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
  mockSendPushToTokens.mockResolvedValue({ targeted: 1, accepted: 1 });
  USER_ID = await insertUser();
  VICTIM_ID = await insertUser();
  mockBearerUser.current = USER_ID;
  VAULT_APP_ID = await insertApplication({ capabilities: [IDENTITY_APPROVAL_CAPABILITY] });
});

describe('POST /auth/session/deliver/:authorizeCode — bearer is the control', () => {
  it('rejects an unauthenticated caller before any lookup', async () => {
    const { authorizeCode } = await storedPendingRequest();

    const res = await request('POST', `/auth/session/deliver/${authorizeCode}`);

    expect(res.status).toBe(401);
    expect(mockSendPushToTokens).not.toHaveBeenCalled();
    expect((await storedRow(authorizeCode)).pushSentAt).toBeNull();
  });

  it('targets the AUTHENTICATED identity, never a user named in the body', async () => {
    // Both identities own a capable install. Naming the victim in the body must
    // change nothing: their token must not be pushed.
    await insertInstall(USER_ID, 'tok-mine', VAULT_APP_ID);
    await insertInstall(VICTIM_ID, 'tok-victim', VAULT_APP_ID);
    const { authorizeCode } = await storedPendingRequest();

    const res = await request('POST', `/auth/session/deliver/${authorizeCode}`, {
      bearer: 'token',
      payload: { userId: VICTIM_ID, username: 'victim', identityUserId: VICTIM_ID },
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ delivered: true, targets: 1 });
    expect(pushedTokens()).toEqual(['tok-mine']);
    expect(mockSendPushToTokens.mock.calls[0][0]).toMatchObject({ userId: USER_ID });
  });
});

describe('POST /auth/session/deliver/:authorizeCode — capability-scoped targeting', () => {
  it("delivers to the identity's capable installs and answers with counts only", async () => {
    await insertInstall(USER_ID, 'tok-vault-1', VAULT_APP_ID);
    await insertInstall(USER_ID, 'tok-vault-2', VAULT_APP_ID);
    mockSendPushToTokens.mockResolvedValue({ targeted: 2, accepted: 2 });
    const { authorizeCode } = await storedPendingRequest();

    const res = await request('POST', `/auth/session/deliver/${authorizeCode}`, { bearer: 'token' });

    expect(res.status).toBe(200);
    // COUNTS ONLY — no token, no device, no application identity.
    expect(res.body.data).toEqual({ delivered: true, targets: 2 });

    const push = mockSendPushToTokens.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(push.data).toEqual({
      type: 'oxy_commons_auth_request',
      approvalUrl: `oxycommons://approve?v=1&code=${authorizeCode}`,
    });

    // The secret sessionToken is never exposed to the client on this path, and
    // it really is stored, so the assertion is not vacuous.
    expect(JSON.stringify(res.body)).not.toContain(SECRET_MARKER);
  });

  it('yields zero targets and sends nothing when the install lacks the capability', async () => {
    // The user HAS a vault-shaped install, but its application carries no
    // capability — so the registry, not the app's identity, decides.
    const plain = await insertApplication();
    await insertInstall(USER_ID, 'tok-plain', plain);
    const { authorizeCode } = await storedPendingRequest();

    const res = await request('POST', `/auth/session/deliver/${authorizeCode}`, { bearer: 'token' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ delivered: false, targets: 0 });
    expect(mockSendPushToTokens).not.toHaveBeenCalled();
    expect(mockEmitAuthSessionProgress).not.toHaveBeenCalled();
  });

  it('yields zero targets when this identity has no capable install of its own', async () => {
    await insertInstall(VICTIM_ID, 'tok-someone-else', VAULT_APP_ID);
    const { authorizeCode } = await storedPendingRequest();

    const res = await request('POST', `/auth/session/deliver/${authorizeCode}`, { bearer: 'token' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ delivered: false, targets: 0 });
    expect(mockSendPushToTokens).not.toHaveBeenCalled();
  });
});

describe('POST /auth/session/deliver/:authorizeCode — failures never break the flow', () => {
  it('answers 200 with a well-formed body when the push transport fails', async () => {
    await insertInstall(USER_ID, 'tok-vault', VAULT_APP_ID);
    mockSendPushToTokens.mockRejectedValue(new Error('expo unreachable'));
    const { authorizeCode } = await storedPendingRequest();

    const res = await request('POST', `/auth/session/deliver/${authorizeCode}`, { bearer: 'token' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ delivered: false, targets: 1 });
    expect(mockEmitAuthSessionProgress).not.toHaveBeenCalled();
  });

  it('404s an unknown authorizeCode', async () => {
    const res = await request('POST', `/auth/session/deliver/${randomUUID().replace(/-/g, '')}`, {
      bearer: 'token',
    });

    expect(res.status).toBe(404);
    expect(mockSendPushToTokens).not.toHaveBeenCalled();
  });

  it('400s a request that is no longer pending', async () => {
    await insertInstall(USER_ID, 'tok-vault', VAULT_APP_ID);
    const { authorizeCode } = await storedPendingRequest({ status: 'authorized' });

    const res = await request('POST', `/auth/session/deliver/${authorizeCode}`, { bearer: 'token' });

    expect(res.status).toBe(400);
    expect(mockSendPushToTokens).not.toHaveBeenCalled();
  });
});

describe('POST /auth/session/deliver/:authorizeCode — progress signalling', () => {
  it('wakes the waiting originator with a payload-free signal on its secret channel', async () => {
    await insertInstall(USER_ID, 'tok-vault', VAULT_APP_ID);
    const { authorizeCode, sessionToken } = await storedPendingRequest();

    await request('POST', `/auth/session/deliver/${authorizeCode}`, { bearer: 'token' });

    expect(mockEmitAuthSessionProgress).toHaveBeenCalledTimes(1);
    expect(mockEmitAuthSessionProgress).toHaveBeenCalledWith(sessionToken);
    // Progress never travels as a status on the socket.
    expect(mockEmitAuthSessionUpdate).not.toHaveBeenCalled();
  });

  it('records pushSentAt as a timestamp, leaving status untouched', async () => {
    await insertInstall(USER_ID, 'tok-vault', VAULT_APP_ID);
    const { authorizeCode } = await storedPendingRequest();

    await request('POST', `/auth/session/deliver/${authorizeCode}`, { bearer: 'token' });

    const row = await storedRow(authorizeCode);
    expect(row.pushSentAt).toBeInstanceOf(Date);
    expect(row.status).toBe('pending');
  });
});

describe('POST /auth/session/opened/:authorizeCode', () => {
  it('needs no bearer — the public approval handle is the credential', async () => {
    const { authorizeCode, sessionToken } = await storedPendingRequest();

    const res = await request('POST', `/auth/session/opened/${authorizeCode}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ success: true });
    expect(mockEmitAuthSessionProgress).toHaveBeenCalledWith(sessionToken);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_MARKER);
  });

  it('writes openedAt once, pending-only and unexpired-only, never status', async () => {
    const { authorizeCode } = await storedPendingRequest();

    await request('POST', `/auth/session/opened/${authorizeCode}`);

    const row = await storedRow(authorizeCode);
    expect(row.openedAt).toBeInstanceOf(Date);
    expect(row.status).toBe('pending');
  });

  it('is idempotent: a repeat call succeeds, emits nothing and keeps the first instant', async () => {
    const { authorizeCode } = await storedPendingRequest();
    await request('POST', `/auth/session/opened/${authorizeCode}`);
    const first = (await storedRow(authorizeCode)).openedAt;
    mockEmitAuthSessionProgress.mockClear();

    const res = await request('POST', `/auth/session/opened/${authorizeCode}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ success: true });
    expect(mockEmitAuthSessionProgress).not.toHaveBeenCalled();
    expect((await storedRow(authorizeCode)).openedAt).toEqual(first);
  });

  it('records nothing for an already-authorized request', async () => {
    const { authorizeCode } = await storedPendingRequest({ status: 'authorized' });

    const res = await request('POST', `/auth/session/opened/${authorizeCode}`);

    expect(res.status).toBe(200);
    const row = await storedRow(authorizeCode);
    expect(row.openedAt).toBeNull();
    expect(row.status).toBe('authorized');
  });

  it('404s an unknown authorizeCode', async () => {
    const res = await request('POST', `/auth/session/opened/${randomUUID().replace(/-/g, '')}`);

    expect(res.status).toBe(404);
  });
});

describe('GET /auth/session/status/:sessionToken — delivery progress projection', () => {
  it('exposes pushSentAt and openedAt while leaving the status machine alone', async () => {
    const pushSentAt = new Date('2026-07-27T10:00:00.000Z');
    const openedAt = new Date('2026-07-27T10:00:05.000Z');
    const { authorizeCode, sessionToken } = await storedPendingRequest({ pushSentAt, openedAt });

    const res = await request('GET', `/auth/session/status/${sessionToken}`);

    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, unknown>;
    // Progress is TIMESTAMPS beside the state machine, never inside it: neither
    // "pushed" nor "opened" is a status a waiting client could misread as an
    // authorization.
    expect(data.status).toBe('pending');
    expect(data.authorized).toBe(false);
    expect(data.pushSentAt).toBe('2026-07-27T10:00:00.000Z');
    expect(data.openedAt).toBe('2026-07-27T10:00:05.000Z');
    // …and the stored row still says pending too.
    expect((await storedRow(authorizeCode)).status).toBe('pending');
  });

  it('emits null timestamps for a request that was never pushed or opened', async () => {
    const { sessionToken } = await storedPendingRequest();

    const res = await request('GET', `/auth/session/status/${sessionToken}`);

    const data = res.body.data as Record<string, unknown>;
    expect(data.pushSentAt).toBeNull();
    expect(data.openedAt).toBeNull();
  });
});
