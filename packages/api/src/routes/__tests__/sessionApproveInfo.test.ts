/**
 * `GET /auth/session/approve-info/:authorizeCode`, against a REAL Postgres.
 *
 * PUBLIC and unauthenticated: the Commons vault fetches it with only the QR's
 * `authorizeCode`, so what it returns is the whole of what a knower of a public
 * code can learn. It must render the TRUE request — server-resolved application
 * identity, the scopes approval would actually grant, the bound origin, the
 * anti-phishing `originVerified` flag, the coarse requester label, the purpose
 * and any delegated subject — and it must NEVER leak the secret `sessionToken`,
 * a token, or the PKCE binding.
 *
 * The previous version mocked `models/AuthSession` / `models/Application` /
 * `models/User`, so "never leaks the sessionToken" only held for whatever the
 * stub happened to carry. Here the row is real and the secret is really stored,
 * which is what makes that assertion mean something.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

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
  const ownerAccountId = fields.ownerAccountId ?? (await account());
  const [row] = await getDb()
    .insert(applications)
    .values({
      name: 'Acme Widgets',
      type: 'third_party',
      scopes: ['files:read', 'user:read'],
      ...fields,
      ownerAccountId,
    })
    .returning({ id: applications.id });
  return row.id;
}

interface Request_ {
  authorizeCode: string;
  sessionToken: string;
  applicationId: string;
}

/** The literal secret every test checks never escapes. */
const SECRET_MARKER = 'SECRET-do-not-leak';

async function authRequest(
  overrides: Partial<typeof authSessions.$inferInsert> = {},
): Promise<Request_> {
  const applicationId = overrides.applicationId ?? (await application());
  const sessionToken = `${SECRET_MARKER}-${randomUUID()}`;
  const authorizeCode = randomUUID().replace(/-/g, '');
  await getDb()
    .insert(authSessions)
    .values({
      sessionToken,
      authorizeCode,
      expiresAt: new Date(Date.now() + 60_000),
      status: 'pending',
      ...overrides,
      applicationId,
    });
  return { authorizeCode, sessionToken, applicationId };
}

/** The all-or-nothing OAuth binding, as `/session/create` writes it. */
function oauthBinding(
  scopes: string[],
  subjectAccountId: string | null = null,
): Partial<typeof authSessions.$inferInsert> {
  return {
    purpose: 'oauth_authorization',
    oauthRedirectUri: 'https://rp.example/cb',
    oauthCodeChallenge: 'challenge-that-must-not-leak-0000000000000',
    oauthCodeChallengeMethod: 'S256',
    oauthScopes: scopes,
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

describe('GET /auth/session/approve-info/:authorizeCode', () => {
  it('returns the resolved sanitized app, scopes, origin and status', async () => {
    const owner = await account({
      username: `ada${randomUUID().slice(0, 8)}`,
      nameFirst: 'Ada',
      nameLast: 'Lovelace',
    });
    const applicationId = await application({ createdByUserId: owner });
    const { authorizeCode } = await authRequest({
      applicationId,
      boundOrigin: 'https://acme.example',
    });

    const res = await get(`/auth/session/approve-info/${authorizeCode}`);

    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, unknown>;
    expect(data.application).toMatchObject({
      id: applicationId,
      name: 'Acme Widgets',
      developerName: 'Ada Lovelace',
    });
    expect(data.scopes).toEqual(['files:read', 'user:read']);
    expect(data.boundOrigin).toBe('https://acme.example');
    expect(data.status).toBe('pending');
    expect(data.purpose).toBe('device_sign_in');
    expect(data.subjectAccount).toBeNull();
  });

  it('NEVER leaks the secret sessionToken', async () => {
    const { authorizeCode } = await authRequest();

    const res = await get(`/auth/session/approve-info/${authorizeCode}`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_MARKER);
  });

  it('NEVER leaks the PKCE binding of an OAuth-bound request', async () => {
    const { authorizeCode } = await authRequest(oauthBinding(['user:read']));

    const res = await get(`/auth/session/approve-info/${authorizeCode}`);

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('challenge-that-must-not-leak');
    expect(serialized).not.toContain('https://rp.example/cb');
  });

  it('surfaces the persisted originVerified flag', async () => {
    const verified = await authRequest({ originVerified: true });
    const unverified = await authRequest({ originVerified: false });

    const a = await get(`/auth/session/approve-info/${verified.authorizeCode}`);
    const b = await get(`/auth/session/approve-info/${unverified.authorizeCode}`);

    expect((a.body.data as { originVerified: boolean }).originVerified).toBe(true);
    expect((b.body.data as { originVerified: boolean }).originVerified).toBe(false);
  });

  it('exposes the coarse requester label, or null', async () => {
    const labelled = await authRequest({ requesterLabel: 'Chrome on Windows' });
    const native = await authRequest();

    const a = await get(`/auth/session/approve-info/${labelled.authorizeCode}`);
    const b = await get(`/auth/session/approve-info/${native.authorizeCode}`);

    expect((a.body.data as { requesterLabel: string | null }).requesterLabel).toBe(
      'Chrome on Windows',
    );
    expect((b.body.data as { requesterLabel: string | null }).requesterLabel).toBeNull();
  });

  it('leaks nothing beyond the documented fields — no UA, no deviceId, no code', async () => {
    const { authorizeCode } = await authRequest({
      requesterLabel: 'Chrome on Windows',
      deviceId: 'dev-originating',
      challengeNonce: 'nonce-value',
    });

    const res = await get(`/auth/session/approve-info/${authorizeCode}`);

    expect(Object.keys(res.body.data as object).sort()).toEqual([
      'application',
      'boundOrigin',
      'expiresAt',
      'originVerified',
      'purpose',
      'requesterLabel',
      'scopes',
      'status',
      'subjectAccount',
    ]);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('dev-originating');
    expect(serialized).not.toContain('nonce-value');
  });

  it('narrows the requested scopes to what the app is REGISTERED for', async () => {
    const applicationId = await application({ scopes: ['user:read'] });
    const { authorizeCode } = await authRequest({
      applicationId,
      ...oauthBinding(['user:read', 'files:read']),
    });

    const res = await get(`/auth/session/approve-info/${authorizeCode}`);

    // An app can never receive more than it is registered for, so the approval
    // screen must not promise more either.
    expect((res.body.data as { scopes: string[] }).scopes).toEqual(['user:read']);
  });

  it('falls back to the app scopes for a device sign-in (no per-request set)', async () => {
    const applicationId = await application({ scopes: ['user:read', 'files:read'] });
    const { authorizeCode } = await authRequest({ applicationId });

    const res = await get(`/auth/session/approve-info/${authorizeCode}`);

    expect((res.body.data as { scopes: string[] }).scopes).toEqual(['user:read', 'files:read']);
  });

  it('resolves a DELEGATED subject server-side and sanitizes it', async () => {
    const org = await account({
      username: `oxycollective${randomUUID().slice(0, 6)}`,
      nameFirst: 'The Oxy Collective',
      kind: 'organization',
    });
    const { authorizeCode } = await authRequest(oauthBinding(['user:read'], org));

    const res = await get(`/auth/session/approve-info/${authorizeCode}`);

    const subject = (res.body.data as {
      subjectAccount: { id: string; username: string; displayName: string };
    }).subjectAccount;
    expect(subject.id).toBe(org);
    expect(subject.displayName).toBe('The Oxy Collective');
    // Id + handle + display name and NOTHING else: never kind, membership,
    // owner or status on a public endpoint.
    expect(Object.keys(subject).sort()).toEqual(['displayName', 'id', 'username']);
  });

  it('reports application:null once the bound app is no longer active', async () => {
    const applicationId = await application();
    const { authorizeCode } = await authRequest({ applicationId });
    await getDb()
      .update(applications)
      .set({ status: 'suspended' })
      .where(eq(applications.id, applicationId));

    const res = await get(`/auth/session/approve-info/${authorizeCode}`);

    const data = res.body.data as { application: unknown; scopes: string[] };
    expect(data.application).toBeNull();
    expect(data.scopes).toEqual([]);
  });

  it('flips a PENDING request past its deadline to expired, and writes that back', async () => {
    const { authorizeCode } = await authRequest({ expiresAt: new Date(Date.now() - 1000) });

    const res = await get(`/auth/session/approve-info/${authorizeCode}`);

    expect((res.body.data as { status: string }).status).toBe('expired');
    const [row] = await getDb()
      .select({ status: authSessions.status })
      .from(authSessions)
      .where(eq(authSessions.authorizeCode, authorizeCode))
      .limit(1);
    expect(row.status).toBe('expired');
  });

  it('leaves a non-pending request alone even past its deadline', async () => {
    const { authorizeCode } = await authRequest({
      status: 'consumed',
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await get(`/auth/session/approve-info/${authorizeCode}`);

    expect((res.body.data as { status: string }).status).toBe('consumed');
  });

  it('returns 404 for an unknown authorizeCode', async () => {
    const res = await get(`/auth/session/approve-info/${randomUUID().replace(/-/g, '')}`);
    expect(res.status).toBe(404);
  });
});
