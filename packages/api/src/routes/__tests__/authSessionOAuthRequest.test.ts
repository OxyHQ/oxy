/**
 * The OAuth BINDING on a cross-app auth request, against a REAL Postgres.
 *
 * `POST /auth/session/create` may attach an `oauth` block, which turns the
 * request from a device sign-in into an OAuth authorization request that
 * finalizes into a single-use `AuthCode`. Two schema-level invariants now carry
 * what the Mongoose sub-schema achieved by staying `undefined`, and both are
 * asserted against the stored row here:
 *
 *  - `auth_sessions_oauth_binding_check` — every `oauth_*` column is NULL
 *    together or present together. There is no half-bound request.
 *  - `auth_sessions_oauth_purpose_check` — the binding exists if and only if
 *    `purpose = 'oauth_authorization'`.
 *
 * `POST /auth/session/finalize/:sessionToken` is a thin mapping over
 * `finalizeOAuthAuthorization`, which is a separate file's port; only the
 * mapping is asserted here.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

const mockFinalizeOAuthAuthorization = jest.fn();
const mockAuthMiddleware = jest.fn(
  (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { _id: 'bearer-user' };
    next();
  },
);

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (...args: unknown[]) =>
    (mockAuthMiddleware as unknown as (...a: unknown[]) => void)(...args),
  serviceAuthMiddleware: jest.fn(),
  rejectQueryToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../services/authSession.service', () => {
  const actual = jest.requireActual<typeof import('../../services/authSession.service')>(
    '../../services/authSession.service',
  );
  return {
    ...actual,
    finalizeOAuthAuthorization: (...args: unknown[]) => mockFinalizeOAuthAuthorization(...args),
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
import { authSessions } from '../../db/schema/authSessions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import authRouter from '../auth';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

const REDIRECT_URI = 'https://rp.example/oauth/callback';
const CODE_CHALLENGE = 'x'.repeat(43);

let server: http.Server;

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
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

async function client(
  appFields: Partial<typeof applications.$inferInsert> = {},
): Promise<{ clientId: string; applicationId: string }> {
  const ownerAccountId = await account();
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      type: 'third_party',
      scopes: ['user:read', 'files:read'],
      redirectUris: [REDIRECT_URI],
      ...appFields,
      ownerAccountId,
    })
    .returning({ id: applications.id });
  const clientId = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  await getDb().insert(applicationCredentials).values({
    applicationId: app.id,
    name: 'client',
    publicKey: clientId,
    type: 'public',
    environment: 'production',
  });
  return { clientId, applicationId: app.id };
}

async function stored(sessionToken: string) {
  const [row] = await getDb()
    .select()
    .from(authSessions)
    .where(eq(authSessions.sessionToken, sessionToken))
    .limit(1);
  return row;
}

const token = () => `at_${randomUUID().replace(/-/g, '')}`;

function oauthBody(overrides: Record<string, unknown> = {}) {
  return {
    redirectUri: REDIRECT_URI,
    codeChallenge: CODE_CHALLENGE,
    codeChallengeMethod: 'S256',
    scope: 'user:read files:read',
    ...overrides,
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
});

describe('POST /auth/session/create — the OAuth binding', () => {
  it('writes the binding and the purpose TOGETHER', async () => {
    const { clientId, applicationId } = await client();
    const sessionToken = token();

    const res = await post('/auth/session/create', {
      sessionToken,
      clientId,
      oauth: oauthBody(),
    });

    expect(res.status).toBe(200);
    const row = await stored(sessionToken);
    expect(row.purpose).toBe('oauth_authorization');
    expect(row.oauthRedirectUri).toBe(REDIRECT_URI);
    expect(row.oauthCodeChallenge).toBe(CODE_CHALLENGE);
    expect(row.oauthCodeChallengeMethod).toBe('S256');
    expect(row.oauthScopes).toEqual(['user:read', 'files:read']);
    expect(row.oauthSubjectAccountId).toBeNull();
    expect(row.applicationId).toBe(applicationId);
  });

  it('leaves a device sign-in with the WHOLE binding NULL', async () => {
    const { clientId } = await client();
    const sessionToken = token();

    await post('/auth/session/create', { sessionToken, clientId });

    const row = await stored(sessionToken);
    expect(row.purpose).toBe('device_sign_in');
    // NULL as a whole — an empty object would read as truthy on the device path.
    expect(row.oauthRedirectUri).toBeNull();
    expect(row.oauthCodeChallenge).toBeNull();
    expect(row.oauthCodeChallengeMethod).toBeNull();
    expect(row.oauthScopes).toBeNull();
    expect(row.oauthSubjectAccountId).toBeNull();
  });

  it('normalizes an ABSENT scope to an empty set, still fully bound', async () => {
    const { clientId } = await client();
    const sessionToken = token();

    const res = await post('/auth/session/create', {
      sessionToken,
      clientId,
      oauth: oauthBody({ scope: undefined }),
    });

    expect(res.status).toBe(200);
    const row = await stored(sessionToken);
    // `{}` is a bound request with no scopes — distinct from NULL, which is
    // "not an OAuth request at all".
    expect(row.oauthScopes).toEqual([]);
    expect(row.purpose).toBe('oauth_authorization');
  });

  it('rejects an unregistered redirect_uri with 403 and NO redirect', async () => {
    const { clientId } = await client();
    const sessionToken = token();

    const res = await post('/auth/session/create', {
      sessionToken,
      clientId,
      oauth: oauthBody({ redirectUri: 'https://evil.example/cb' }),
    });

    // 403 rather than a redirect: per RFC 6749 §3.1.2.4 the server MUST NOT
    // redirect to an unregistered URI, so the error surfaces to the caller.
    expect(res.status).toBe(403);
    expect(await stored(sessionToken)).toBeUndefined();
  });

  it('rejects a trailing-slash variation of a registered redirect_uri', async () => {
    const { clientId } = await client();
    const sessionToken = token();

    const res = await post('/auth/session/create', {
      sessionToken,
      clientId,
      oauth: oauthBody({ redirectUri: `${REDIRECT_URI}/` }),
    });

    expect(res.status).toBe(403);
    expect(await stored(sessionToken)).toBeUndefined();
  });

  it('rejects a non-S256 code challenge method', async () => {
    const { clientId } = await client();
    const sessionToken = token();

    const res = await post('/auth/session/create', {
      sessionToken,
      clientId,
      oauth: oauthBody({ codeChallengeMethod: 'plain' }),
    });

    expect(res.status).toBe(400);
    expect(await stored(sessionToken)).toBeUndefined();
  });

  it('rejects an OAuth binding identified only by applicationId', async () => {
    const { applicationId } = await client();
    const sessionToken = token();

    const res = await post('/auth/session/create', {
      sessionToken,
      applicationId,
      oauth: oauthBody(),
    });

    // The redirect allowlist belongs to the OAuth CLIENT, so the request must
    // name a client_id.
    expect(res.status).toBe(400);
    expect(await stored(sessionToken)).toBeUndefined();
  });

  it('rejects a subjectAccountId that names no account', async () => {
    const { clientId } = await client();
    const sessionToken = token();

    const res = await post('/auth/session/create', {
      sessionToken,
      clientId,
      oauth: oauthBody({ subjectAccountId: randomUUID() }),
    });

    // `oauth_subject_account_id` carries a real FK now, so an id naming no
    // account is refused at the edge with the documented 400 instead of
    // surfacing as a constraint violation.
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ message: 'Invalid subjectAccountId' });
    expect(await stored(sessionToken)).toBeUndefined();
  });

  it('binds a DELEGATED subject that does exist', async () => {
    const { clientId } = await client();
    const org = await account({ kind: 'organization' });
    const sessionToken = token();

    const res = await post('/auth/session/create', {
      sessionToken,
      clientId,
      oauth: oauthBody({ subjectAccountId: org }),
    });

    expect(res.status).toBe(200);
    expect((await stored(sessionToken)).oauthSubjectAccountId).toBe(org);
  });

  it('binds boundOrigin to the RELYING PARTY redirect origin, not the caller', async () => {
    const { clientId } = await client();
    const sessionToken = token();

    // The IdP shell (auth.oxy.so) starts the flow; the approver must see the RP.
    const res = await post(
      '/auth/session/create',
      { sessionToken, clientId, oauth: oauthBody() },
      { origin: 'https://auth.oxy.so' },
    );

    expect(res.status).toBe(200);
    expect((await stored(sessionToken)).boundOrigin).toBe('https://rp.example');
  });

  it('lets an OAuth-bound request from the IdP shell through the trusted-origin gate', async () => {
    // An OAuth-bound request skips the browser-origin gate: the redirect_uri was
    // already exact-matched, and the caller may legitimately be the IdP rather
    // than one of the app's own registered origins.
    const { clientId } = await client({ isOfficial: true, type: 'first_party' });
    const sessionToken = token();

    const res = await post(
      '/auth/session/create',
      { sessionToken, clientId, oauth: oauthBody() },
      { origin: 'https://auth.oxy.so' },
    );

    expect(res.status).toBe(200);
  });

  it('still rejects a trusted DEVICE sign-in from an unregistered browser origin', async () => {
    const { clientId } = await client({ isOfficial: true, type: 'first_party' });
    const sessionToken = token();

    const res = await post(
      '/auth/session/create',
      { sessionToken, clientId },
      { origin: 'https://auth.oxy.so' },
    );

    expect(res.status).toBe(403);
  });
});

describe('POST /auth/session/finalize/:sessionToken', () => {
  it('returns the authorization code, its redirect target and the TTL', async () => {
    mockFinalizeOAuthAuthorization.mockResolvedValueOnce({
      ok: true,
      code: 'raw-authorization-code',
      redirectUri: REDIRECT_URI,
      expiresIn: 60,
    });

    const res = await post('/auth/session/finalize/tok-oauth-approve', {});

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      code: 'raw-authorization-code',
      redirectUri: REDIRECT_URI,
      expiresIn: 60,
    });
    expect(mockFinalizeOAuthAuthorization).toHaveBeenCalledWith({
      sessionToken: 'tok-oauth-approve',
    });
  });

  it('needs NO bearer token — the secret sessionToken IS the credential', async () => {
    mockFinalizeOAuthAuthorization.mockResolvedValueOnce({
      ok: true,
      code: 'raw-authorization-code',
      redirectUri: REDIRECT_URI,
      expiresIn: 60,
    });

    const res = await post('/auth/session/finalize/tok-oauth-approve', {});

    expect(res.status).toBe(200);
    expect(mockAuthMiddleware).not.toHaveBeenCalled();
  });

  it.each([
    'not_found',
    'wrong_purpose',
    'not_authorized',
    'expired',
    'already_finalized',
    'delegation_denied',
    'application_unavailable',
    'redirect_uri_unregistered',
    'issue_failed',
  ])('collapses the %s rejection to one generic invalid_grant', async (reason) => {
    mockFinalizeOAuthAuthorization.mockResolvedValueOnce({ ok: false, reason });

    const res = await post('/auth/session/finalize/tok-oauth-approve', {});

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ message: 'invalid_grant' });
    // Nothing enumerates which precondition failed (RFC 6749 §5.2).
    expect(JSON.stringify(res.body)).not.toContain(reason);
  });
});
