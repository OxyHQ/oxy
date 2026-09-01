/**
 * `POST /auth/session/deny/:authorizeCode`, against a REAL Postgres.
 *
 * The Commons vault never holds the secret `sessionToken`, so it denies by the
 * PUBLIC `authorizeCode`. Only a PENDING request may be cancelled — a knower of
 * the public code must not be able to cancel an already-authorized one — and the
 * waiting originator is notified on its own secret channel, WITHOUT the reason.
 *
 * Absorbs the former `sessionDenyReason.test.ts`, which asserted on
 * `session.save()` call counts against a mocked Mongoose document. That proved
 * a write was ATTEMPTED, never that the row ended up carrying the reason; here
 * the row is read back out of Postgres. The rate-limiter prefix uniqueness it
 * also checked is covered globally by the limiter registry, not by re-mocking
 * the factory per suite.
 *
 * Every test mints its own application and request, so no assertion depends on
 * a table being empty.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

const mockEmitAuthSessionUpdate = jest.fn();
const mockWarn = jest.fn();

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
  default: { createSession: jest.fn(), getAccessToken: jest.fn() },
}));
jest.mock('../../utils/authSessionSocket', () => ({
  emitAuthSessionUpdate: (...args: unknown[]) => mockEmitAuthSessionUpdate(...args),
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
  logger: {
    warn: (...args: unknown[]) => mockWarn(...args),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
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

function post(path: string, body: unknown = {}): Promise<JsonResponse> {
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

/** A pending request with a known secret token and public approval handle. */
async function pendingRequest(
  overrides: Partial<typeof authSessions.$inferInsert> = {},
): Promise<{ sessionToken: string; authorizeCode: string; applicationId: string }> {
  const [owner] = await getDb().insert(users).values({}).returning({ id: users.id });
  const [app] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID()}`, ownerAccountId: owner.id })
    .returning({ id: applications.id });
  const sessionToken = `at_${randomUUID().replace(/-/g, '')}`;
  const authorizeCode = randomUUID().replace(/-/g, '');
  await getDb()
    .insert(authSessions)
    .values({
      sessionToken,
      authorizeCode,
      applicationId: app.id,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      status: 'pending',
      ...overrides,
    });
  return { sessionToken, authorizeCode, applicationId: app.id };
}

async function storedByCode(authorizeCode: string) {
  const [row] = await getDb()
    .select()
    .from(authSessions)
    .where(eq(authSessions.authorizeCode, authorizeCode))
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
});

describe('POST /auth/session/deny/:authorizeCode', () => {
  it('cancels a pending request and notifies the originator on the SECRET channel', async () => {
    const { sessionToken, authorizeCode } = await pendingRequest();

    const res = await post(`/auth/session/deny/${authorizeCode}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ success: true });
    expect((await storedByCode(authorizeCode)).status).toBe('cancelled');
    expect(mockEmitAuthSessionUpdate).toHaveBeenCalledWith(sessionToken, { status: 'cancelled' });
  });

  it('returns 404 for an unknown authorizeCode', async () => {
    const res = await post(`/auth/session/deny/${randomUUID().replace(/-/g, '')}`);
    expect(res.status).toBe(404);
    expect(mockEmitAuthSessionUpdate).not.toHaveBeenCalled();
  });

  it('does NOT cancel an already-authorized request, and emits nothing', async () => {
    const { authorizeCode } = await pendingRequest({ status: 'authorized' });

    const res = await post(`/auth/session/deny/${authorizeCode}`);

    expect(res.status).toBe(200);
    expect((await storedByCode(authorizeCode)).status).toBe('authorized');
    expect(mockEmitAuthSessionUpdate).not.toHaveBeenCalled();
  });

  it('emits exactly once when two denials race the same code', async () => {
    const { sessionToken, authorizeCode } = await pendingRequest();

    const [first, second] = await Promise.all([
      post(`/auth/session/deny/${authorizeCode}`),
      post(`/auth/session/deny/${authorizeCode}`),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // The cancel is conditioned on `status = 'pending'`, so only one update
    // matches — the second is an idempotent success that emits nothing.
    expect(mockEmitAuthSessionUpdate).toHaveBeenCalledTimes(1);
    expect(mockEmitAuthSessionUpdate).toHaveBeenCalledWith(sessionToken, { status: 'cancelled' });
  });
});

describe('POST /auth/session/cancel/:sessionToken — the originator withdraws', () => {
  it('cancels by the SECRET token and notifies the waiting client', async () => {
    const { sessionToken, authorizeCode } = await pendingRequest();

    const res = await post(`/auth/session/cancel/${sessionToken}`);

    expect(res.status).toBe(200);
    expect((await storedByCode(authorizeCode)).status).toBe('cancelled');
    expect(mockEmitAuthSessionUpdate).toHaveBeenCalledWith(sessionToken, { status: 'cancelled' });
  });

  it('cancels UNCONDITIONALLY — possession of the secret is the ownership proof', async () => {
    const { sessionToken, authorizeCode } = await pendingRequest({ status: 'authorized' });

    const res = await post(`/auth/session/cancel/${sessionToken}`);

    expect(res.status).toBe(200);
    // Unlike deny (public code, pending-only), the originator may withdraw a
    // request it has already had approved but not yet claimed.
    expect((await storedByCode(authorizeCode)).status).toBe('cancelled');
  });

  it('returns 404 for an unknown sessionToken, emitting nothing', async () => {
    const res = await post(`/auth/session/cancel/at_${randomUUID().replace(/-/g, '')}`);

    expect(res.status).toBe(404);
    expect(mockEmitAuthSessionUpdate).not.toHaveBeenCalled();
  });
});

describe('POST /auth/session/deny/:authorizeCode — the closed reason set', () => {
  it('records a "not_me" denial on the row', async () => {
    const { authorizeCode } = await pendingRequest();

    const res = await post(`/auth/session/deny/${authorizeCode}`, { reason: 'not_me' });

    expect(res.status).toBe(200);
    const row = await storedByCode(authorizeCode);
    expect(row.status).toBe('cancelled');
    expect(row.deniedReason).toBe('not_me');
  });

  it('records an ordinary "declined" denial distinctly from "not_me"', async () => {
    const { authorizeCode } = await pendingRequest();

    await post(`/auth/session/deny/${authorizeCode}`, { reason: 'declined' });

    expect((await storedByCode(authorizeCode)).deniedReason).toBe('declined');
  });

  it('leaves the reason NULL when none is given', async () => {
    const { authorizeCode } = await pendingRequest();

    await post(`/auth/session/deny/${authorizeCode}`);

    const row = await storedByCode(authorizeCode);
    expect(row.status).toBe('cancelled');
    expect(row.deniedReason).toBeNull();
  });

  it('rejects a reason outside the closed set BEFORE the handler runs', async () => {
    const { authorizeCode } = await pendingRequest();

    const res = await post(`/auth/session/deny/${authorizeCode}`, { reason: 'because i said so' });

    expect(res.status).toBe(400);
    // Nothing was written: the request is still pending and still approvable.
    const row = await storedByCode(authorizeCode);
    expect(row.status).toBe('pending');
    expect(row.deniedReason).toBeNull();
  });

  it('flags a "not_me" denial in the log with no identifying detail', async () => {
    const { authorizeCode, applicationId } = await pendingRequest();

    await post(`/auth/session/deny/${authorizeCode}`, { reason: 'not_me' });

    const flagged = mockWarn.mock.calls.find(
      (call) => call[0] === 'Auth session denied as not-me',
    );
    expect(flagged).toBeDefined();
    const detail = flagged?.[1] as Record<string, unknown>;
    expect(detail).toEqual({
      authorizeCode: `${authorizeCode.substring(0, 8)}...`,
      applicationId,
    });
    // The whole log record: no User-Agent, no IP, no location, no full handle.
    const serialized = JSON.stringify(mockWarn.mock.calls);
    expect(serialized).not.toContain(authorizeCode);
  });

  it('never broadcasts the reason back to the waiting relying party', async () => {
    const { sessionToken, authorizeCode } = await pendingRequest();

    await post(`/auth/session/deny/${authorizeCode}`, { reason: 'not_me' });

    // A hostile RP must not learn it was suspected.
    expect(mockEmitAuthSessionUpdate).toHaveBeenCalledWith(sessionToken, { status: 'cancelled' });
    expect(JSON.stringify(mockEmitAuthSessionUpdate.mock.calls)).not.toContain('not_me');
  });

  it('does not record a reason against an already-authorized request', async () => {
    const { authorizeCode } = await pendingRequest({ status: 'authorized' });

    await post(`/auth/session/deny/${authorizeCode}`, { reason: 'not_me' });

    const row = await storedByCode(authorizeCode);
    expect(row.status).toBe('authorized');
    expect(row.deniedReason).toBeNull();
  });
});
