/**
 * `POST /auth/oauth/token` — RFC 6749 §4.1.3 authorization-code exchange,
 * against a REAL Postgres.
 *
 * Pins two contracts at once:
 *
 *   1. THE STANDARD. A form-encoded request with `grant_type=authorization_code`,
 *      client authentication by `client_secret_post` or `client_secret_basic`,
 *      a FLAT §5.1 success body sent `no-store`, and §5.2 error documents with
 *      the right status codes. These are what make the endpoint usable by an
 *      off-the-shelf OAuth client.
 *
 *   2. THE SECURITY PROPERTIES the standardization must not cost us:
 *        - the client secret is verified in constant time BEFORE the code is
 *          exchanged, so a caller without it cannot reach the exchange at all;
 *        - a caller with neither a secret nor a PKCE verifier is rejected
 *          before any credential lookup;
 *        - the PKCE verifier reaches `exchangeAuthCode` unaltered (the S256
 *          comparison itself is pinned in
 *          `services/__tests__/oauthCode.service.test.ts`);
 *        - every code-binding failure collapses to ONE `invalid_grant` body, so
 *          the endpoint cannot be used as an oracle for which check failed.
 *
 * What is real here and what is mocked follows what the port actually changed:
 * the CLIENT resolution (credential row, usability, constant-time secret check),
 * the user read and the `applications.last_used_at` write all run against
 * Postgres; `exchangeAuthCode` (`auth_codes` is a separate port),
 * `session.service` and `deviceLogin.service` are mocked collaborators. The
 * previous version mocked `models/ApplicationCredential` and `models/Application`
 * and therefore never exercised the secret comparison against a stored hash.
 *
 * ORDERING PROOFS. The Mongo version asserted "rejected before any lookup" by
 * watching an `ApplicationCredential.findOne` mock. There is no such mock here,
 * so those cases claim an UNREGISTERED client id instead: reaching the lookup
 * would answer `invalid_client`, so an `invalid_request` verdict is only
 * reachable when the request-shape check ran first. That is an observable of
 * the wire rather than of a collaborator, and it fails if the order is swapped.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import * as nodeCrypto from 'node:crypto';
import { randomUUID } from 'node:crypto';

const mockExchangeAuthCode = jest.fn();
const mockCreateSession = jest.fn();
const mockFinalizeDeviceLogin = jest.fn();

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  serviceAuthMiddleware: jest.fn(),
  rejectQueryToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/authUtils', () => ({
  extractTokenFromRequest: () => null,
  extractOAuthUserinfoToken: () => null,
  decodeToken: () => null,
  validateSessionToken: jest.fn(),
}));
jest.mock('../../services/oauthCode.service', () => {
  const actual = jest.requireActual<typeof import('../../services/oauthCode.service')>(
    '../../services/oauthCode.service',
  );
  return {
    ...actual,
    issueAuthCode: jest.fn(),
    exchangeAuthCode: (...args: unknown[]) => mockExchangeAuthCode(...args),
  };
});
jest.mock('../../services/session.service', () => ({
  __esModule: true,
  default: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    getAccessToken: jest.fn(),
  },
}));
jest.mock('../../services/deviceLogin.service', () => ({
  finalizeDeviceLogin: (...args: unknown[]) => mockFinalizeDeviceLogin(...args),
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

interface TokenResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

const REDIRECT_URI = 'https://acme.example/oauth/callback';
/** A well-formed PKCE verifier — `oauthTokenSchema` enforces 43–128 chars. */
const CODE_VERIFIER = 'a'.repeat(64);

/**
 * A client id no `application_credentials` row carries. Used by the ordering
 * proofs described in the file header: if the route reached the lookup, the
 * answer would be `invalid_client`.
 */
const UNREGISTERED_CLIENT_ID = 'oxy_dk_unregistered_client';

/** The single description every code-binding failure must report (no oracle). */
const INVALID_GRANT_DESCRIPTION =
  'The authorization code is invalid, expired, already used, or was not issued for this client and redirect URI.';

let server: http.Server;
/** An active public client, seeded once — the default subject of these tests. */
let defaultClientId: string;
let defaultApplicationId: string;
/** A real `users` row the default exchange result resolves to. */
let defaultSubjectId: string;

function requestRaw(
  body: string,
  contentType: string,
  headers: Record<string, string> = {},
): Promise<TokenResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path: '/auth/oauth/token',
        headers: {
          'content-type': contentType,
          'content-length': Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: raw.length > 0 ? JSON.parse(raw) : {},
            });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * POST an RFC-shaped token request: `application/x-www-form-urlencoded`, the
 * only encoding §4.1.3 allows.
 */
function requestForm(
  params: Record<string, string>,
  headers: Record<string, string> = {},
): Promise<TokenResponse> {
  return requestRaw(
    new URLSearchParams(params).toString(),
    'application/x-www-form-urlencoded',
    headers,
  );
}

function basicHeader(clientId: string, clientSecret: string): Record<string, string> {
  const encoded = Buffer.from(
    `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
  ).toString('base64');
  return { authorization: `Basic ${encoded}` };
}

/** The minimal valid public-client (PKCE) request against the default client. */
function pkceParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    grant_type: 'authorization_code',
    code: 'auth-code-1',
    redirect_uri: REDIRECT_URI,
    client_id: defaultClientId,
    code_verifier: CODE_VERIFIER,
    ...overrides,
  };
}

const sha256 = (value: string) => nodeCrypto.createHash('sha256').update(value).digest('hex');

/**
 * An OFFICIAL Oxy application. The default fixture is `third_party`, which is
 * now the ISOLATED lane (issue #937, Phase 6) — a case that needs the shared
 * device session has to ask for a trusted client explicitly.
 */
const OFFICIAL_APP: Partial<typeof applications.$inferInsert> = {
  type: 'first_party',
  isOfficial: true,
};

async function client(
  credentialFields: Partial<typeof applicationCredentials.$inferInsert> = {},
  appFields: Partial<typeof applications.$inferInsert> = {},
): Promise<{ clientId: string; applicationId: string }> {
  const [owner] = await getDb().insert(users).values({}).returning({ id: users.id });
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      type: 'third_party',
      redirectUris: [REDIRECT_URI],
      ...appFields,
      ownerAccountId: owner.id,
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

/** The subject of the grant — a real `users` row the exchange resolves. */
async function subject(fields: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb().insert(users).values(fields).returning({ id: users.id });
  return row.id;
}

/** The exchange result the route receives for a successful code redemption. */
function grant(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    code: {
      userId: defaultSubjectId,
      deviceId: null,
      operatedByUserId: null,
      scopes: [],
      ...overrides,
    },
  };
}

beforeAll(async () => {
  await connectPostgres();
  const seeded = await client();
  defaultClientId = seeded.clientId;
  defaultApplicationId = seeded.applicationId;
  defaultSubjectId = await subject({ nameFirst: 'Ada', nameLast: 'Lovelace' });

  const app = express();
  app.use(express.json());
  // Mirrors `server.ts`: the token endpoint is reachable only because the app
  // parses urlencoded bodies.
  app.use(express.urlencoded({ extended: true }));
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
  mockExchangeAuthCode.mockResolvedValue(grant());
  mockCreateSession.mockResolvedValue({
    sessionId: 'sess-1',
    deviceId: 'device-1',
    accessToken: 'access-token-1',
  });
  mockFinalizeDeviceLogin.mockResolvedValue({ deviceSecret: 'device-secret-1' });
});

describe('POST /auth/oauth/token — RFC 6749 §5.1 success response', () => {
  it('returns a FLAT token document (no `data` wrapper) for a PKCE public client', async () => {
    const res = await requestForm(pkceParams());

    expect(res.status).toBe(200);
    // The point of the change: the standard members sit at the TOP LEVEL.
    expect(res.body).toMatchObject({
      access_token: 'access-token-1',
      token_type: 'Bearer',
      expires_in: 900,
      session_id: 'sess-1',
    });
    expect(res.body).not.toHaveProperty('data');
    // The zero-cookie transport hands out no refresh token.
    expect(res.body).not.toHaveProperty('refresh_token');

    const user = res.body.user as { id: string; name: { displayName?: string } };
    expect(user.id).toBe(defaultSubjectId);
    expect(user.name.displayName).toBe('Ada Lovelace');
  });

  it('sends the credentials with `Cache-Control: no-store` (§5.1)', async () => {
    const res = await requestForm(pkceParams());

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
  });

  it('reports the granted scope as a space-delimited string', async () => {
    mockExchangeAuthCode.mockResolvedValueOnce(
      grant({ scopes: ['profile:read', 'email:read'] }),
    );

    const res = await requestForm(pkceParams());

    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('profile:read email:read');
  });

  it('omits `scope` entirely when the grant carries none', async () => {
    const res = await requestForm(pkceParams());

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('scope');
  });

  it('forwards the exchange the app id, redirect URI and PKCE verifier', async () => {
    const res = await requestForm(pkceParams());

    expect(res.status).toBe(200);
    expect(mockExchangeAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({
        rawCode: 'auth-code-1',
        appId: defaultApplicationId,
        redirectUri: REDIRECT_URI,
        clientSecretProvided: false,
        // Dropping or rewriting the verifier here would disable PKCE for every
        // public client; the S256 comparison itself is pinned in
        // `services/__tests__/oauthCode.service.test.ts`.
        codeVerifier: CODE_VERIFIER,
      }),
    );
  });

  it('stamps applications.last_used_at', async () => {
    const { clientId, applicationId } = await client();
    await getDb()
      .update(applications)
      .set({ lastUsedAt: null })
      .where(eq(applications.id, applicationId));

    await requestForm(pkceParams({ client_id: clientId }));

    const [app] = await getDb()
      .select({ lastUsedAt: applications.lastUsedAt })
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);
    expect(app.lastUsedAt).toBeInstanceOf(Date);
  });

  it('threads the originating device and the delegated operator onto a TRUSTED app session', async () => {
    const { clientId } = await client({}, OFFICIAL_APP);
    const org = await subject({ kind: 'organization' });
    const operator = await subject();
    mockExchangeAuthCode.mockResolvedValueOnce(
      grant({ userId: org, deviceId: '  dev-shared  ', operatedByUserId: operator }),
    );

    await requestForm(pkceParams({ client_id: clientId }));

    expect(mockCreateSession).toHaveBeenCalledWith(
      org,
      expect.anything(),
      expect.objectContaining({ deviceId: 'dev-shared', operatedByUserId: operator }),
    );
  });

  it('never serializes a protected user column into the token response', async () => {
    const userId = await subject({ phone: '+15550001111', refreshToken: 'user-refresh-token' });
    mockExchangeAuthCode.mockResolvedValueOnce(grant({ userId }));

    const res = await requestForm(pkceParams());

    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('+15550001111');
    expect(serialized).not.toContain('user-refresh-token');
  });
});

describe('POST /auth/oauth/token — request validation (RFC 6749 §5.2)', () => {
  it('rejects a request with no grant_type as unsupported_grant_type', async () => {
    const params = pkceParams();
    delete params.grant_type;

    const res = await requestForm(params);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'unsupported_grant_type',
      error_description: expect.any(String),
    });
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });

  it('rejects a grant_type this endpoint does not implement', async () => {
    const res = await requestForm(pkceParams({ grant_type: 'refresh_token' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('unsupported_grant_type');
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });

  it('rejects a JSON body — §4.1.3 fixes the encoding as form-urlencoded', async () => {
    const res = await requestRaw(
      JSON.stringify(pkceParams({ client_id: UNREGISTERED_CLIENT_ID })),
      'application/json',
    );

    // `invalid_request`, not `invalid_client`: the encoding is refused before
    // the unregistered client id is ever looked up.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });

  it('rejects a request missing `code`', async () => {
    const params = pkceParams();
    delete params.code;

    const res = await requestForm(params);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });

  it('rejects a request missing `redirect_uri`', async () => {
    const params = pkceParams();
    delete params.redirect_uri;

    const res = await requestForm(params);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });

  it('rejects a request that names no client at all', async () => {
    const params = pkceParams();
    delete params.client_id;

    const res = await requestForm(params);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });
});

describe('POST /auth/oauth/token — client authentication (RFC 6749 §2.3)', () => {
  it('accepts client_secret_basic and exchanges as a confidential client', async () => {
    const secret = randomUUID();
    const { clientId, applicationId } = await client({
      type: 'confidential',
      secretHash: sha256(secret),
    });

    const res = await requestForm(
      { grant_type: 'authorization_code', code: 'auth-code-1', redirect_uri: REDIRECT_URI },
      basicHeader(clientId, secret),
    );

    expect(res.status).toBe(200);
    // The client id came from the Basic header, not the body.
    expect(mockExchangeAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({ appId: applicationId, clientSecretProvided: true }),
    );
  });

  it('accepts client_secret_post', async () => {
    const secret = randomUUID();
    const { clientId } = await client({ type: 'confidential', secretHash: sha256(secret) });

    const res = await requestForm({
      grant_type: 'authorization_code',
      code: 'auth-code-1',
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      client_secret: secret,
    });

    expect(res.status).toBe(200);
    expect(mockExchangeAuthCode).toHaveBeenCalledWith(
      expect.objectContaining({ clientSecretProvided: true }),
    );
  });

  it('rejects using Basic AND a body client_secret at once (§2.3)', async () => {
    const res = await requestForm(
      {
        grant_type: 'authorization_code',
        code: 'auth-code-1',
        redirect_uri: REDIRECT_URI,
        client_secret: 'some-secret',
      },
      basicHeader(UNREGISTERED_CLIENT_ID, 'some-secret'),
    );

    // Self-contradictory request → `invalid_request`, decided before the
    // unregistered client id could yield `invalid_client`.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });

  it('rejects a body client_id that contradicts the Basic header', async () => {
    const res = await requestForm(
      {
        grant_type: 'authorization_code',
        code: 'auth-code-1',
        redirect_uri: REDIRECT_URI,
        client_id: 'oxy_dk_someone_else',
      },
      basicHeader(UNREGISTERED_CLIENT_ID, 'some-secret'),
    );

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });

  it('rejects an Authorization scheme other than Basic, with a challenge', async () => {
    const res = await requestForm(pkceParams(), { authorization: 'Bearer some-token' });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect(res.headers['www-authenticate']).toContain('Basic');
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });

  it('answers an unknown client with 401 invalid_client and a Basic challenge', async () => {
    const res = await requestForm(pkceParams({ client_id: UNREGISTERED_CLIENT_ID }));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: 'invalid_client',
      error_description: expect.any(String),
    });
    expect(res.headers['www-authenticate']).toContain('Basic');
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });

  it('answers 401 invalid_client for a REVOKED credential', async () => {
    const { clientId } = await client({ status: 'revoked' });

    const res = await requestForm(pkceParams({ client_id: clientId }));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });

  it('answers 401 invalid_client when the application is no longer active', async () => {
    const { clientId } = await client({}, { status: 'suspended' });

    const res = await requestForm(pkceParams({ client_id: clientId }));

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });
});

describe('POST /auth/oauth/token — security properties', () => {
  it('verifies the client secret BEFORE the code exchange: a wrong secret never reaches it', async () => {
    const { clientId } = await client({
      type: 'confidential',
      secretHash: sha256(randomUUID()),
    });

    const res = await requestForm({
      grant_type: 'authorization_code',
      code: 'auth-code-1',
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      client_secret: 'wrong-secret',
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    // The load-bearing assertion: an attacker without the secret cannot probe
    // the code-binding outcomes, because the exchange never runs.
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('rejects a secret asserted against a credential that has none', async () => {
    const res = await requestForm({
      grant_type: 'authorization_code',
      code: 'auth-code-1',
      redirect_uri: REDIRECT_URI,
      client_id: defaultClientId,
      client_secret: 'anything',
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });

  it('rejects a caller that presents neither a client secret nor a PKCE verifier', async () => {
    const params = pkceParams({ client_id: UNREGISTERED_CLIENT_ID });
    delete params.code_verifier;

    const res = await requestForm(params);

    // Again `invalid_request` and not `invalid_client`: rejected before any
    // credential lookup, so the code is never touched.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });

  it('rejects a PKCE verifier shorter than the RFC 7636 minimum', async () => {
    const res = await requestForm(pkceParams({ code_verifier: 'too-short' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });

  it('collapses every code-binding failure into one indistinguishable invalid_grant', async () => {
    mockExchangeAuthCode.mockResolvedValue({ ok: false, reason: 'invalid_grant' });

    const unknownCode = await requestForm(pkceParams({ code: 'never-issued' }));
    const replayedCode = await requestForm(pkceParams({ code: 'already-used' }));
    const otherRedirect = await requestForm(
      pkceParams({ redirect_uri: 'https://acme.example/other' }),
    );

    for (const res of [unknownCode, replayedCode, otherRedirect]) {
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'invalid_grant',
        error_description: INVALID_GRANT_DESCRIPTION,
      });
    }
    // Byte-identical bodies: the response cannot tell the causes apart.
    expect(replayedCode.body).toEqual(unknownCode.body);
    expect(otherRedirect.body).toEqual(unknownCode.body);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('reports a code with neither PKCE nor client secret as invalid_client', async () => {
    mockExchangeAuthCode.mockResolvedValueOnce({ ok: false, reason: 'invalid_client' });

    const res = await requestForm(pkceParams());

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('returns invalid_grant when the code resolves to a user that no longer exists', async () => {
    mockExchangeAuthCode.mockResolvedValueOnce(grant({ userId: randomUUID() }));

    const res = await requestForm(pkceParams());

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('fails closed with server_error when deviceSecret minting fails', async () => {
    // Only an application that actually joins the device mints one, so the
    // subject of this case has to be a trusted client.
    const { clientId } = await client({}, OFFICIAL_APP);
    mockFinalizeDeviceLogin.mockResolvedValueOnce({});

    const res = await requestForm(pkceParams({ client_id: clientId }));

    expect(res.status).toBe(500);
    // Still RFC-shaped, and still says nothing about what broke internally.
    expect(res.body).toEqual({
      error: 'server_error',
      error_description: expect.any(String),
    });
    expect(res.body).not.toHaveProperty('access_token');
  });
});

/**
 * Issue #937, Phase 6 — a third-party exchange yields an ISOLATED session, not
 * a share of the user's device.
 *
 * The three properties are one decision and only work together, so each is
 * asserted against the same default `third_party` fixture and contrasted with
 * a trusted client that keeps the old behaviour verbatim.
 */
describe('POST /auth/oauth/token — third-party isolation', () => {
  it('returns a deviceSecret for the third party OWN device, never the shared one', async () => {
    // The danger was never that a third party holds a `deviceSecret` — it is
    // WHICH device the secret unlocks. Handed the shared one, a leaked
    // third-party token mints bearers for every account on that device and can
    // change what every official Oxy app there is signed in as. Bound to its
    // own per-(user, client) device, it reaches exactly one session: its own.
    //
    // #937 asks for the pair to be omitted outright. That is the end state and
    // it is not this: `exchangeOAuthCode` in `@oxyhq/core` throws without both
    // fields, so omitting them breaks every third-party sign-in through the SDK
    // until core ships a release that tolerates a device-less session. This test
    // therefore pins the property that actually protects the user, and the
    // omission is tracked separately.
    mockExchangeAuthCode.mockResolvedValueOnce(grant({ deviceId: 'dev-shared' }));

    const res = await requestForm(pkceParams());

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('access_token');
    expect(res.body).toHaveProperty('deviceSecret');
    expect(res.body.deviceId).not.toBe('dev-shared');
  });

  it('registers a third-party session onto its OWN device, not the shared one', async () => {
    mockExchangeAuthCode.mockResolvedValueOnce(grant({ deviceId: 'dev-shared' }));

    await requestForm(pkceParams());

    expect(mockFinalizeDeviceLogin).toHaveBeenCalledTimes(1);
    const finalized = mockFinalizeDeviceLogin.mock.calls[0][0] as {
      session: { deviceId: string };
    };
    expect(finalized.session.deviceId).not.toBe('dev-shared');
  });

  it('binds a third-party session to its application, credential and granted scopes', async () => {
    mockExchangeAuthCode.mockResolvedValueOnce(grant({ scopes: ['profile:read'] }));

    await requestForm(pkceParams());

    expect(mockCreateSession).toHaveBeenCalledWith(
      defaultSubjectId,
      expect.anything(),
      expect.objectContaining({
        application: {
          applicationId: defaultApplicationId,
          clientId: defaultClientId,
          scopes: ['profile:read'],
        },
      }),
    );
  });

  it('keeps a third-party session OFF the shared device id the code carried', async () => {
    // The code's `deviceId` is the user's central device. Reusing it would put
    // the third party's session where `createSession`'s reuse lookup finds the
    // device's own first-party session. A stable per-(user, client) key keeps
    // the client reusing ITS OWN session across exchanges instead.
    mockExchangeAuthCode.mockResolvedValueOnce(grant({ deviceId: 'dev-shared' }));

    await requestForm(pkceParams());

    const options = mockCreateSession.mock.calls[0][2] as Record<string, unknown>;
    expect(options.deviceId).toBeUndefined();
    expect(options.stableDeviceKey).toBe(`oauth:${defaultClientId}`);
  });

  it('still hands an OFFICIAL application the shared device credential', async () => {
    // The contrast case. Without it, "no deviceSecret" would pass just as well
    // against a route that stopped minting one for anybody.
    const { clientId } = await client({}, OFFICIAL_APP);

    const res = await requestForm(pkceParams({ client_id: clientId }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deviceId: 'device-1', deviceSecret: 'device-secret-1' });
    expect(mockFinalizeDeviceLogin).toHaveBeenCalled();
  });

  it('leaves an OFFICIAL application session unbound to any single application', async () => {
    // An official app joins the SHARED device session, which belongs to no one
    // application — so it gets no `azp`, and the device lane keeps serving it.
    const { clientId } = await client({}, OFFICIAL_APP);

    await requestForm(pkceParams({ client_id: clientId }));

    const options = mockCreateSession.mock.calls[0][2] as Record<string, unknown>;
    expect(options.application).toBeUndefined();
    expect(options.stableDeviceKey).toBeUndefined();
  });
});
