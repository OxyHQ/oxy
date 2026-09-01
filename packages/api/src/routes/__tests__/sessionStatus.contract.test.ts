/**
 * PRODUCER drift-guard for `GET /auth/session/status/:sessionToken`, against a
 * REAL Postgres.
 *
 * The API is the FAITHFUL PRODUCER of `@oxyhq/contracts`'s
 * `sessionStatusSchema`. These tests exercise the REAL route over real rows and
 * assert that the `{ data: ... }` inner object PARSES against the shared
 * contract, so a port that quietly changes a field's nullability is caught here
 * rather than in an app's zod parse weeks later.
 *
 * The class of bug that motivated this contract: the auth app's LOCAL schema
 * typed `sessionId` as `z.string().optional()`. The producer emits
 * `sessionId: authorizedSessionId || null`, so a PENDING device request carries
 * `sessionId: null` — `.optional()` permits `undefined` but REJECTS `null`, and
 * the whole response collapsed to `null`. The PENDING case below is that EXACT
 * shape and MUST parse.
 *
 * Two port-specific hazards this now also covers: `authorized_session_id` /
 * `authorized_user_id` are NULLABLE columns (not absent fields), and `purpose`
 * is `NOT NULL DEFAULT 'device_sign_in'` — the `?? 'device_sign_in'` fallback for
 * pre-field Mongo documents does not travel.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { sessionStatusSchema, safeParseContract } from '@oxyhq/contracts';

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
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import authRouter from '../auth';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

let server: http.Server;

function get(path: string): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request({ method: 'GET', host: '127.0.0.1', port: address.port, path }, (res) => {
      let raw = '';
      res.on('data', (chunk) => {
        raw += chunk;
      });
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: raw.length ? JSON.parse(raw) : {} }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function account(fields: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb().insert(users).values(fields).returning({ id: users.id });
  return row.id;
}

async function application(fields: Partial<typeof applications.$inferInsert> = {}): Promise<string> {
  const ownerAccountId = await account();
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      type: 'first_party',
      isOfficial: true,
      scopes: ['user:read'],
      ...fields,
      ownerAccountId,
    })
    .returning({ id: applications.id });
  return row.id;
}

async function authRequest(
  overrides: Partial<typeof authSessions.$inferInsert> = {},
): Promise<string> {
  const applicationId = overrides.applicationId ?? (await application());
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

describe('GET /auth/session/status/:sessionToken — @oxyhq/contracts sessionStatusSchema', () => {
  it('parses a PENDING device request (sessionId / publicKey / userId all null)', async () => {
    const sessionToken = await authRequest();

    const res = await get(`/auth/session/status/${sessionToken}`);

    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, unknown>;
    // The exact shape the auth app's drifted local schema used to reject.
    expect(data.sessionId).toBeNull();
    expect(data.publicKey).toBeNull();
    expect(data.userId).toBeNull();
    expect(safeParseContract(sessionStatusSchema, data)).not.toBeNull();
  });

  it('parses an AUTHORIZED request (string sessionId / publicKey / userId)', async () => {
    const approver = await account({ publicKey: `02${randomUUID().replace(/-/g, '')}` });
    const [row] = await getDb()
      .select({ publicKey: users.publicKey })
      .from(users)
      .where(eq(users.id, approver))
      .limit(1);
    const sessionToken = await authRequest({
      status: 'authorized',
      authorizedUserId: approver,
      authorizedBy: row.publicKey,
      authorizedSessionId: `sess-${randomUUID()}`,
    });

    const res = await get(`/auth/session/status/${sessionToken}`);

    const data = res.body.data as Record<string, unknown>;
    expect(data.authorized).toBe(true);
    expect(typeof data.sessionId).toBe('string');
    expect(data.userId).toBe(approver);
    expect(data.publicKey).toBe(row.publicKey);
    expect(safeParseContract(sessionStatusSchema, data)).not.toBeNull();
  });

  it('carries the consent screen legal links and the developer attribution', async () => {
    // These three travelled through `serializePublicApplication` before the port
    // and must still: `privacyPolicyUrl` / `termsUrl` are rendered as legal
    // links on the consent screen, and `developerName` is the owner attribution
    // shown for a non-official app.
    const owner = await account({
      username: `ada${randomUUID().slice(0, 8)}`,
      nameFirst: 'Ada',
      nameLast: 'Lovelace',
    });
    const applicationId = await application({
      name: 'Acme Widgets',
      type: 'third_party',
      isOfficial: false,
      privacyPolicyUrl: 'https://acme.example/privacy',
      termsUrl: 'https://acme.example/terms',
      createdByUserId: owner,
    });
    const sessionToken = await authRequest({ applicationId });

    const res = await get(`/auth/session/status/${sessionToken}`);

    const parsed = safeParseContract(sessionStatusSchema, res.body.data);
    expect(parsed).not.toBeNull();
    expect(parsed?.application?.id).toBe(applicationId);
    expect(parsed?.application?.privacyPolicyUrl).toBe('https://acme.example/privacy');
    expect(parsed?.application?.termsUrl).toBe('https://acme.example/terms');
    expect(parsed?.application?.developerName).toBe('Ada Lovelace');
  });

  it('omits an absent optional rather than emitting null', async () => {
    // `serializePublicApplication` drops undefined/null optionals entirely, and
    // Drizzle hands it `null` where Mongoose handed it `undefined` — so this is
    // exactly where the port could have started emitting `termsUrl: null`.
    const applicationId = await application({ privacyPolicyUrl: null, termsUrl: null });
    const sessionToken = await authRequest({ applicationId });

    const res = await get(`/auth/session/status/${sessionToken}`);

    const app = (res.body.data as { application: Record<string, unknown> }).application;
    expect(app).not.toHaveProperty('privacyPolicyUrl');
    expect(app).not.toHaveProperty('termsUrl');
    expect(app).not.toHaveProperty('description');
  });

  it('parses application:null when the bound app is no longer active', async () => {
    const applicationId = await application();
    const sessionToken = await authRequest({ applicationId });
    await getDb()
      .update(applications)
      .set({ status: 'suspended' })
      .where(eq(applications.id, applicationId));

    const res = await get(`/auth/session/status/${sessionToken}`);

    const data = res.body.data as Record<string, unknown>;
    expect(data.application).toBeNull();
    expect(safeParseContract(sessionStatusSchema, data)).not.toBeNull();
  });

  it('emits purpose for an OAuth-bound request, and parses', async () => {
    const sessionToken = await authRequest({
      purpose: 'oauth_authorization',
      oauthRedirectUri: 'https://rp.example/cb',
      oauthCodeChallenge: 'x'.repeat(43),
      oauthCodeChallengeMethod: 'S256',
      oauthScopes: ['user:read'],
    });

    const res = await get(`/auth/session/status/${sessionToken}`);

    const data = res.body.data as Record<string, unknown>;
    expect(data.purpose).toBe('oauth_authorization');
    expect(safeParseContract(sessionStatusSchema, data)).not.toBeNull();
  });

  it('emits purpose device_sign_in from the column DEFAULT, not a serializer fallback', async () => {
    const sessionToken = await authRequest();

    const res = await get(`/auth/session/status/${sessionToken}`);

    expect((res.body.data as { purpose: string }).purpose).toBe('device_sign_in');
  });

  it('parses the delivery-progress timestamps in both directions', async () => {
    const withProgress = await authRequest({
      pushSentAt: new Date('2026-07-27T10:00:00.000Z'),
      openedAt: new Date('2026-07-27T10:00:05.000Z'),
    });
    const withoutProgress = await authRequest();

    const a = (await get(`/auth/session/status/${withProgress}`)).body.data as Record<string, unknown>;
    const b = (await get(`/auth/session/status/${withoutProgress}`)).body.data as Record<string, unknown>;

    expect(a.pushSentAt).toBe('2026-07-27T10:00:00.000Z');
    expect(a.openedAt).toBe('2026-07-27T10:00:05.000Z');
    expect(b.pushSentAt).toBeNull();
    expect(b.openedAt).toBeNull();
    expect(safeParseContract(sessionStatusSchema, a)).not.toBeNull();
    expect(safeParseContract(sessionStatusSchema, b)).not.toBeNull();
  });

  it('echoes the presented sessionToken and nothing else secret', async () => {
    const sessionToken = await authRequest();

    const res = await get(`/auth/session/status/${sessionToken}`);

    // `auth_sessions.session_token` is a protected column and the handler never
    // selects it — the value here is the one the caller already held.
    expect((res.body.data as { sessionToken: string }).sessionToken).toBe(sessionToken);
  });
});
