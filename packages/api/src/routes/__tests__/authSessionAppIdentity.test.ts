/**
 * Application identity on the cross-app auth surface, against a REAL Postgres.
 *
 * Covers `POST /auth/session/create` (application resolution, the browser-origin
 * gate, the `originVerified` anti-phishing signal, the QR payload),
 * `GET /auth/session/status/:sessionToken` (the embedded sanitized application)
 * and `GET /auth/oauth/client/:clientId` (public consent metadata).
 *
 * The previous version of this suite mocked `models/Application` /
 * `models/ApplicationCredential` / `models/AuthSession` and asserted on the
 * arguments the route passed to `AuthSession.create`. That proves the call was
 * BUILT as expected and never that the stored row is right — exactly the
 * distinction `originVerified` turns on. Every assertion below reads the row
 * back out of Postgres instead.
 *
 * `session.service`, the socket emitters and the auth middleware ARE mocked:
 * they are collaborators, not the subject. `validate` and `serializeApplication`
 * are REAL, so the wire shape stays pinned. Nothing about MongoDB is mocked.
 *
 * Every test mints its own users, applications and credentials with unique
 * values, so no assertion depends on a table being empty.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

const mockCreateSession = jest.fn();
const mockEmitAuthSessionUpdate = jest.fn();
const mockAuthorizeSessionWithSignedChallenge = jest.fn();

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
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    getAccessToken: jest.fn(),
  },
}));
jest.mock('../../services/authSession.service', () => {
  const actual = jest.requireActual<typeof import('../../services/authSession.service')>(
    '../../services/authSession.service',
  );
  return {
    ...actual,
    authorizeSessionWithSignedChallenge: (...args: unknown[]) =>
      mockAuthorizeSessionWithSignedChallenge(...args),
  };
});
jest.mock('../../utils/authSessionSocket', () => ({
  emitAuthSessionUpdate: (...args: unknown[]) => mockEmitAuthSessionUpdate(...args),
  emitAuthSessionProgress: jest.fn(),
}));
jest.mock('../../utils/socket', () => ({
  broadcastSessionAccountsChanged: jest.fn(),
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
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { authSessions } from '../../db/schema/authSessions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import authRouter, { matchesRegisteredOrigin, originFromRedirectUri } from '../auth';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

let server: http.Server;

function request(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          ...(payload
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }
            : {}),
          ...options.headers,
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
    if (payload) req.write(payload);
    req.end();
  });
}

/** A real `users` row — `applications.owner_account_id` carries a real FK. */
async function account(fields: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb().insert(users).values(fields).returning({ id: users.id });
  return row.id;
}

async function application(
  fields: Partial<typeof applications.$inferInsert> = {},
): Promise<typeof applications.$inferSelect> {
  const ownerAccountId = fields.ownerAccountId ?? (await account());
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `App ${randomUUID()}`, ...fields, ownerAccountId })
    .returning();
  return row;
}

/** An `oxy_dk_…` client id, unique per call. */
async function credential(
  applicationId: string,
  fields: Partial<typeof applicationCredentials.$inferInsert> = {},
): Promise<string> {
  const publicKey = fields.publicKey ?? `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId,
      name: 'client',
      type: 'public',
      environment: 'production',
      ...fields,
      publicKey,
    });
  return publicKey;
}

/** The stored `auth_sessions` row for a secret token, read straight from Postgres. */
async function storedSession(sessionToken: string) {
  const [row] = await getDb()
    .select()
    .from(authSessions)
    .where(eq(authSessions.sessionToken, sessionToken))
    .limit(1);
  return row;
}

const token = () => `at_${randomUUID().replace(/-/g, '')}`;

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

describe('POST /auth/session/create — application resolution', () => {
  it('resolves a clientId and stores the canonical applicationId', async () => {
    const app = await application();
    const clientId = await credential(app.id);
    const sessionToken = token();

    const res = await request('POST', '/auth/session/create', {
      body: { sessionToken, clientId },
    });

    expect(res.status).toBe(200);
    const row = await storedSession(sessionToken);
    expect(row.applicationId).toBe(app.id);
    expect(row.status).toBe('pending');
    expect(row.purpose).toBe('device_sign_in');
  });

  it('resolves an applicationId directly', async () => {
    const app = await application();
    const sessionToken = token();

    const res = await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: app.id },
    });

    expect(res.status).toBe(200);
    expect((await storedSession(sessionToken)).applicationId).toBe(app.id);
  });

  it('returns 400 when NEITHER clientId nor applicationId is supplied', async () => {
    const res = await request('POST', '/auth/session/create', { body: { sessionToken: token() } });
    expect(res.status).toBe(400);
  });

  it('returns 400 for an unknown clientId', async () => {
    const sessionToken = token();
    const res = await request('POST', '/auth/session/create', {
      body: { sessionToken, clientId: 'oxy_dk_nope' },
    });
    expect(res.status).toBe(400);
    expect(await storedSession(sessionToken)).toBeUndefined();
  });

  it('returns 400 for an applicationId that names no row', async () => {
    const sessionToken = token();
    const res = await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: randomUUID() },
    });
    expect(res.status).toBe(400);
    expect(await storedSession(sessionToken)).toBeUndefined();
  });

  it('returns the SAME 400 for a malformed applicationId — a text id just matches no row', async () => {
    // The `isValidObjectId` format guard is deleted: Postgres text ids raise no
    // CastError, and the guard would have rejected every uuid v7 id minted
    // after the cutover. The observable outcome is unchanged.
    const sessionToken = token();
    const res = await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: 'not-an-id-at-all' },
    });
    expect(res.status).toBe(400);
    expect(await storedSession(sessionToken)).toBeUndefined();
  });

  it.each(['suspended', 'deleted', 'pending_review'] as const)(
    'returns 403 for a %s app',
    async (status) => {
      const app = await application({ status });
      const sessionToken = token();
      const res = await request('POST', '/auth/session/create', {
        body: { sessionToken, applicationId: app.id },
      });
      expect(res.status).toBe(403);
      expect(await storedSession(sessionToken)).toBeUndefined();
    },
  );

  it('refuses to reuse a sessionToken, without disclosing that it exists', async () => {
    const app = await application();
    const sessionToken = token();
    const first = await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: app.id },
    });
    expect(first.status).toBe(200);

    const other = await application();
    const second = await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: other.id },
    });

    expect(second.status).toBe(400);
    expect(second.body).toMatchObject({ message: 'Unable to create session' });
    // The original row is untouched — a second create never repoints a live
    // request at a different application.
    expect((await storedSession(sessionToken)).applicationId).toBe(app.id);
  });
});

describe('POST /auth/session/create — browser origin gate', () => {
  const registered = 'https://accounts.example';

  it('permits a trusted app from one of its OWN registered redirect origins', async () => {
    const app = await application({
      isOfficial: true,
      redirectUris: [`${registered}/callback`],
    });
    const sessionToken = token();

    const res = await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: app.id },
      headers: { origin: registered },
    });

    expect(res.status).toBe(200);
    const row = await storedSession(sessionToken);
    expect(row.boundOrigin).toBe(registered);
    expect(row.originVerified).toBe(true);
  });

  it('rejects a trusted app from an UNREGISTERED browser origin', async () => {
    const app = await application({
      isOfficial: true,
      redirectUris: [`${registered}/callback`],
    });
    const sessionToken = token();

    const res = await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: app.id },
      headers: { origin: 'https://evil.example' },
    });

    expect(res.status).toBe(403);
    expect(await storedSession(sessionToken)).toBeUndefined();
  });

  it('rejects a trusted app in a Referer-only browser context', async () => {
    const app = await application({
      isOfficial: true,
      redirectUris: [`${registered}/callback`],
    });
    const sessionToken = token();

    const res = await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: app.id },
      headers: { referer: `${registered}/page` },
    });

    // A Referer alone is a browser context with no provable Origin.
    expect(res.status).toBe(403);
    expect(await storedSession(sessionToken)).toBeUndefined();
  });

  it('accepts a NATIVE caller (no Origin, no Referer) and leaves originVerified false', async () => {
    const app = await application({
      isOfficial: true,
      redirectUris: [`${registered}/callback`],
    });
    const sessionToken = token();

    const res = await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: app.id },
    });

    expect(res.status).toBe(200);
    const row = await storedSession(sessionToken);
    expect(row.boundOrigin).toBeNull();
    expect(row.originVerified).toBe(false);
  });

  it('leaves originVerified false for a third-party app even on a present Origin', async () => {
    const app = await application({
      type: 'third_party',
      redirectUris: [`${registered}/callback`],
    });
    const sessionToken = token();

    const res = await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: app.id },
      headers: { origin: registered },
    });

    expect(res.status).toBe(200);
    const row = await storedSession(sessionToken);
    expect(row.boundOrigin).toBe(registered);
    expect(row.originVerified).toBe(false);
  });

  it('lets a trusted app START the flow from a LOOPBACK origin, still unverified', async () => {
    const app = await application({
      isOfficial: true,
      redirectUris: [`${registered}/callback`],
    });
    const sessionToken = token();

    const res = await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: app.id },
      headers: { origin: 'http://localhost:8081' },
    });

    expect(res.status).toBe(200);
    const row = await storedSession(sessionToken);
    expect(row.boundOrigin).toBe('http://localhost:8081');
    // Loopback opens the gate; it never asserts the app's identity.
    expect(row.originVerified).toBe(false);
  });

  // Commons' REAL registered redirect surface. It is native-only, so these two
  // custom-scheme deep links are its whole `redirectUris` list
  // (`scripts/seedOxyApplicationsSpecs.ts`), and both serialize to the opaque
  // origin. The `registered` https fixture the rest of this describe uses cannot
  // reach the defect at all, which is why these two tests carry their own.
  const commonsRedirectUris = ['commons://', 'oxycommons://'];

  it('refuses a literal Origin: null against custom-scheme redirect URIs', async () => {
    const app = await application({ type: 'first_party', redirectUris: commonsRedirectUris });
    const sessionToken = token();

    const res = await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: app.id },
      headers: { origin: 'null' },
    });

    // `new URL('commons://').origin` is the literal string "null", which is also
    // what a browser sends as `Origin` from every opaque browsing context. The
    // two used to compare equal, opening the gate and setting `originVerified`.
    expect(res.status).toBe(403);
    expect(await storedSession(sessionToken)).toBeUndefined();
  });

  it('binds an OAuth request on a custom-scheme redirect URI to NO origin', async () => {
    const app = await application({ type: 'first_party', redirectUris: commonsRedirectUris });
    const clientId = await credential(app.id);
    const sessionToken = token();

    const res = await request('POST', '/auth/session/create', {
      body: {
        sessionToken,
        clientId,
        oauth: {
          redirectUri: 'commons://',
          codeChallenge: 'a'.repeat(43),
          codeChallengeMethod: 'S256',
        },
      },
    });

    // A registered redirect URI is exact-matched before this, so the request is
    // legitimate — but `commons://` proves no origin, and the approver must not
    // be shown a verified one. The row records the absence rather than the
    // literal string "null", which also kept `origin=null` out of the QR payload.
    expect(res.status).toBe(200);
    const row = await storedSession(sessionToken);
    expect(row.boundOrigin).toBeNull();
    expect(row.originVerified).toBe(false);
    expect((res.body.data as Record<string, string>).qrPayload).not.toContain('origin=null');
  });

  it('does NOT treat https://localhost as loopback', async () => {
    const app = await application({
      isOfficial: true,
      redirectUris: [`${registered}/callback`],
    });
    const sessionToken = token();

    const res = await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: app.id },
      headers: { origin: 'https://localhost:8081' },
    });

    expect(res.status).toBe(403);
    expect(await storedSession(sessionToken)).toBeUndefined();
  });
});

/**
 * The opaque-origin guard's two halves, each driven where the other cannot reach
 * it. With the derive side in place nothing ever hands the match side a `"null"`
 * to refuse, so a test driving only the route would measure the derive side
 * twice and the match side never — and deleting the match side would stay green.
 */
describe('the opaque-origin guard', () => {
  it('derives NO origin from a custom-scheme redirect URI', () => {
    expect(originFromRedirectUri('commons://')).toBeNull();
    expect(originFromRedirectUri('oxycommons://')).toBeNull();
    // Same serialization, same refusal: every scheme the URL standard leaves
    // non-special collapses to the one opaque origin.
    expect(originFromRedirectUri('exp://localhost:8081')).toBeNull();
    expect(originFromRedirectUri('file:///index.html')).toBeNull();
    // Positive control: a real web origin still derives, or the assertions above
    // would also pass against a function that returned null unconditionally.
    expect(originFromRedirectUri('https://rp.example/callback')).toBe('https://rp.example');
  });

  it('matches nothing against the opaque origin, however the set was built', () => {
    // A set that CONTAINS the opaque origin — the shape the derive side no
    // longer produces, and the reason this half exists.
    expect(matchesRegisteredOrigin(new Set(['null']), 'null')).toBe(false);
    expect(matchesRegisteredOrigin(new Set(['https://rp.example', 'null']), 'null')).toBe(false);
    // Positive control: an ordinary origin in that same set still matches.
    expect(matchesRegisteredOrigin(new Set(['https://rp.example', 'null']), 'https://rp.example'))
      .toBe(true);
  });
});

describe('POST /auth/session/create — the public QR handle', () => {
  it('returns a public authorizeCode + qrPayload and persists the pair', async () => {
    const app = await application({ redirectUris: ['https://rp.example/cb'] });
    const sessionToken = token();

    const res = await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: app.id },
      headers: { origin: 'https://rp.example' },
    });

    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, string>;
    expect(data.sessionToken).toBe(sessionToken);
    expect(data.authorizeCode).toMatch(/^[0-9a-f]{32}$/);
    expect(data.qrPayload).toContain(`oxycommons://approve?v=1&code=${data.authorizeCode}`);
    expect(data.qrPayload).toContain(`app=${app.id}`);
    // The SECRET never travels in the QR.
    expect(data.qrPayload).not.toContain(sessionToken);

    const row = await storedSession(sessionToken);
    expect(row.authorizeCode).toBe(data.authorizeCode);
    expect(row.challengeNonce).toMatch(/^[0-9a-f]{16}$/);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('GET /auth/session/status/:sessionToken — embedded application', () => {
  it('embeds sanitized metadata for an official app and omits developerName', async () => {
    const owner = await account({ username: `dev${randomUUID().slice(0, 8)}`, nameFirst: 'Ada' });
    const app = await application({
      name: 'Oxy Accounts',
      isOfficial: true,
      type: 'first_party',
      scopes: ['user:read'],
      websiteUrl: 'https://accounts.oxy.so',
      createdByUserId: owner,
    });
    const sessionToken = token();
    await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: app.id },
    });

    const res = await request('GET', `/auth/session/status/${sessionToken}`);

    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, unknown>;
    expect(data.status).toBe('pending');
    expect(data.authorized).toBe(false);
    expect(data.sessionToken).toBe(sessionToken);
    expect(data.purpose).toBe('device_sign_in');
    expect(data.application).toEqual({
      id: app.id,
      name: 'Oxy Accounts',
      type: 'first_party',
      isOfficial: true,
      isInternal: false,
      scopes: ['user:read'],
      websiteUrl: 'https://accounts.oxy.so',
    });
  });

  it('embeds developerName for a third-party app, preferring a real display name', async () => {
    const owner = await account({
      username: `handle${randomUUID().slice(0, 8)}`,
      nameFirst: 'Ada',
      nameLast: 'Lovelace',
    });
    const app = await application({
      name: 'Acme Widgets',
      type: 'third_party',
      scopes: ['files:read'],
      createdByUserId: owner,
    });
    const sessionToken = token();
    await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: app.id },
    });

    const res = await request('GET', `/auth/session/status/${sessionToken}`);

    expect(
      (res.body.data as { application: { developerName: string } }).application.developerName,
    ).toBe('Ada Lovelace');
  });

  it('falls back to the owner username when they have no real name', async () => {
    const username = `handle${randomUUID().slice(0, 8)}`;
    const owner = await account({ username });
    const app = await application({ type: 'third_party', createdByUserId: owner });
    const sessionToken = token();
    await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: app.id },
    });

    const res = await request('GET', `/auth/session/status/${sessionToken}`);

    expect(
      (res.body.data as { application: { developerName: string } }).application.developerName,
    ).toBe(username);
  });

  it('returns application:null once the bound app is no longer active', async () => {
    const app = await application();
    const sessionToken = token();
    await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: app.id },
    });

    // `auth_sessions.application_id` CASCADEs, so a hard delete takes the
    // request with it. The surviving "null application" case is an app that is
    // merely no longer ACTIVE.
    await getDb()
      .update(applications)
      .set({ status: 'suspended' })
      .where(eq(applications.id, app.id));

    const res = await request('GET', `/auth/session/status/${sessionToken}`);

    expect(res.status).toBe(200);
    expect((res.body.data as { application: unknown }).application).toBeNull();
  });

  it('reports an expired request as expired and writes that back', async () => {
    const app = await application();
    const sessionToken = token();
    await request('POST', '/auth/session/create', {
      body: { sessionToken, applicationId: app.id },
    });
    await getDb()
      .update(authSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSessions.sessionToken, sessionToken));

    const res = await request('GET', `/auth/session/status/${sessionToken}`);

    expect((res.body.data as { status: string }).status).toBe('expired');
    expect((await storedSession(sessionToken)).status).toBe('expired');
  });

  it('returns 404 for an unknown sessionToken', async () => {
    const res = await request('GET', `/auth/session/status/${token()}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /auth/oauth/client/:clientId — public metadata lookup', () => {
  it('returns sanitized metadata for an active app', async () => {
    const app = await application({
      name: 'Acme',
      type: 'third_party',
      scopes: ['user:read'],
      webhookSecret: 'never-leaks',
      redirectUris: ['https://acme.example/cb'],
    });
    const clientId = await credential(app.id);

    const res = await request('GET', `/auth/oauth/client/${clientId}`);

    expect(res.status).toBe(200);
    const publicApp = (res.body.data as { application: Record<string, unknown> }).application;
    expect(publicApp.id).toBe(app.id);
    expect(publicApp.name).toBe('Acme');
    // The sanitized projection carries no secret, no webhook, no redirect list.
    expect(JSON.stringify(publicApp)).not.toContain('never-leaks');
    expect(publicApp).not.toHaveProperty('redirectUris');
    expect(publicApp).not.toHaveProperty('webhookSecret');
  });

  it('removes legacy credential query parameters from the public icon projection', async () => {
    const app = await application({
      icon:
        'https://cdn.example.test/homiio.svg?size=64&token=secret-marker&access_token=second-marker&authorization=third-marker#app',
    });
    const clientId = await credential(app.id);

    const res = await request('GET', `/auth/oauth/client/${clientId}`);

    expect(res.status).toBe(200);
    const publicApp = (res.body.data as { application: Record<string, unknown> }).application;
    expect(publicApp.icon).toBe('https://cdn.example.test/homiio.svg?size=64#app');
    expect(JSON.stringify(publicApp)).not.toContain('secret-marker');
    expect(JSON.stringify(publicApp)).not.toContain('second-marker');
    expect(JSON.stringify(publicApp)).not.toContain('third-marker');
  });

  it('returns 404 for an unknown clientId', async () => {
    const res = await request('GET', '/auth/oauth/client/oxy_dk_missing');
    expect(res.status).toBe(404);
  });

  it('returns 404 for a REVOKED credential', async () => {
    const app = await application();
    const clientId = await credential(app.id, { status: 'revoked' });
    const res = await request('GET', `/auth/oauth/client/${clientId}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 when the credential is usable but the app is inactive', async () => {
    const app = await application({ status: 'suspended' });
    const clientId = await credential(app.id);
    const res = await request('GET', `/auth/oauth/client/${clientId}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a deprecated credential whose rotation grace has elapsed', async () => {
    const app = await application();
    const clientId = await credential(app.id, {
      status: 'deprecated',
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await request('GET', `/auth/oauth/client/${clientId}`);
    expect(res.status).toBe(404);
  });

  it('ACCEPTS a deprecated credential still inside its rotation grace', async () => {
    const app = await application();
    const clientId = await credential(app.id, {
      status: 'deprecated',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await request('GET', `/auth/oauth/client/${clientId}`);
    expect(res.status).toBe(200);
  });
});

describe('POST /auth/session/authorize-signed/:authorizeCode — outcome mapping', () => {
  it('maps an ok outcome to 200 and notifies the originator on the SECRET channel', async () => {
    mockAuthorizeSessionWithSignedChallenge.mockResolvedValueOnce({
      ok: true,
      sessionToken: 'secret-channel',
      sessionId: 'sess-1',
      userId: 'user-1',
      username: 'nate',
      publicKey: '02aa',
    });

    const res = await request('POST', '/auth/session/authorize-signed/abc', {
      body: { publicKey: '02aa', challenge: 'c', signature: 's', timestamp: Date.now() },
    });

    expect(res.status).toBe(200);
    expect(mockEmitAuthSessionUpdate).toHaveBeenCalledWith('secret-channel', {
      status: 'authorized',
      sessionId: 'sess-1',
      publicKey: '02aa',
      userId: 'user-1',
      username: 'nate',
    });
  });

  it.each([
    [401, 'Invalid signature'],
    [404, 'Auth session not found or already processed'],
    [403, 'Not authorized to act as the requested account'],
  ] as const)('maps a %s failure outcome without emitting', async (status, message) => {
    mockAuthorizeSessionWithSignedChallenge.mockResolvedValueOnce({ ok: false, status, message });

    const res = await request('POST', '/auth/session/authorize-signed/abc', {
      body: { publicKey: '02aa', challenge: 'c', signature: 's', timestamp: Date.now() },
    });

    expect(res.status).toBe(status);
    expect(mockEmitAuthSessionUpdate).not.toHaveBeenCalled();
  });
});
