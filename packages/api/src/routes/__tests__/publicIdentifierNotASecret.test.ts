/**
 * A bare `oxy_dk_*` cannot authenticate anywhere a SECRET is required — the
 * route lanes, against a REAL Postgres. Issue #972, workstream 2.1.
 *
 * ## What this file is defending
 *
 * `application_credentials.public_key` (`oxy_dk_…`) is a PUBLIC identifier: it
 * is the OAuth `client_id`, it ships inside mobile apps and single-page
 * bundles, and it is handed out by `GET /auth/oauth/client/:clientId` with no
 * authentication at all. The secret is a separate value, stored only as its
 * SHA-256 (`application_credentials.secret_hash`) and shown exactly once.
 *
 * Console documentation used to present that public identifier as a bearer API
 * key. It never worked — but "it does not work today" is a fact about the
 * current code, not a property anybody had written down. These cases write it
 * down, per lane, so the shape can never start working by accident.
 *
 * ## Two lanes, and why each is here rather than one standing in for both
 *
 *   1. `POST /auth/service-token` — the client-credentials mint. Its secret
 *      check is a constant-time comparison against `secret_hash`.
 *   2. `POST /auth/oauth/token` — RFC 6749 §2.3 client authentication. Its
 *      secret check is a DIFFERENT constant-time comparison, reached through a
 *      different parsing path (`resolveClientAuthentication`), and it has an
 *      extra shape the other lane does not: a caller may legitimately present
 *      NO secret at all when it proves possession with PKCE instead.
 *
 * A single generic case could not cover both: the second lane's "no secret is
 * sometimes fine" rule is exactly where a public identifier would slip through,
 * and it does not exist in the first lane.
 *
 * ## Every rejection is paired with a POSITIVE CONTROL
 *
 * A lane that is broken for an unrelated reason — a bad fixture, a schema
 * rejection, a route that 500s on everything — rejects the public identifier
 * too, and would read as "correctly refused". So each refusal sits beside a
 * request that differs ONLY in the credential material and must succeed.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import * as nodeCrypto from 'node:crypto';
import { randomUUID } from 'node:crypto';

// `jest.setup.cjs` stubs `jsonwebtoken` globally. The service-token lane's
// success arm returns a real signed JWT, so restore the real module.
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));

process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret';

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

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import authRouter from '../auth';

const sha256 = (value: string) => nodeCrypto.createHash('sha256').update(value).digest('hex');

const REDIRECT_URI = 'https://acme.example/oauth/callback';
/** A well-formed PKCE verifier — `oauthTokenSchema` enforces 43–128 chars. */
const CODE_VERIFIER = 'a'.repeat(64);

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

let server: http.Server;

function request(path: string, body: string, contentType: string): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'content-type': contentType,
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: raw.length > 0 ? JSON.parse(raw) : {} });
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

const postServiceToken = (body: unknown): Promise<JsonResponse> =>
  request('/auth/service-token', JSON.stringify(body), 'application/json');

const postOAuthToken = (params: Record<string, string>): Promise<JsonResponse> =>
  request(
    '/auth/oauth/token',
    new URLSearchParams(params).toString(),
    'application/x-www-form-urlencoded',
  );

interface Credential {
  /** The PUBLIC identifier — the `oxy_dk_…` client id. */
  publicKey: string;
  /** The SECRET, which only this fixture and the stored hash know. */
  secret: string;
  applicationId: string;
}

/**
 * A real application plus one credential whose stored hash matches `secret`.
 *
 * `type` defaults to `service` (the first lane's requirement); the OAuth lane
 * overrides it to `confidential`. The owning application is `internal`, which
 * the service-token lane requires as its trust gate — a gate this file must
 * clear rather than test, since it is pinned in `serviceTokenCredentials`.
 */
async function credential(
  credentialFields: Partial<typeof applicationCredentials.$inferInsert> = {},
  appFields: Partial<typeof applications.$inferInsert> = {},
): Promise<Credential> {
  const [owner] = await getDb().insert(users).values({}).returning({ id: users.id });
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: `App ${randomUUID()}`,
      type: 'internal',
      isInternal: true,
      scopes: ['user:read'],
      redirectUris: [REDIRECT_URI],
      ...appFields,
      ownerAccountId: owner.id,
    })
    .returning({ id: applications.id });

  const publicKey = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  const secret = randomUUID();
  await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: app.id,
      name: 'credential',
      type: 'service',
      environment: 'production',
      secretHash: sha256(secret),
      ...credentialFields,
      publicKey,
    });

  return { publicKey, secret, applicationId: app.id };
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
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
  mockExchangeAuthCode.mockResolvedValue({
    ok: true,
    code: { userId: '', deviceId: null, operatedByUserId: null, scopes: [] },
  });
  mockCreateSession.mockResolvedValue({
    sessionId: 'sess-1',
    deviceId: 'device-1',
    accessToken: 'access-token-1',
  });
  mockFinalizeDeviceLogin.mockResolvedValue({ deviceSecret: 'device-secret-1' });
});

describe('lane 1 — POST /auth/service-token', () => {
  it('REFUSES the credential public key presented as its own secret', async () => {
    const cred = await credential();

    const res = await postServiceToken({ apiKey: cred.publicKey, apiSecret: cred.publicKey });

    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('token');
  });

  it('REFUSES a request that names the public key and omits the secret entirely', async () => {
    const cred = await credential();

    const res = await postServiceToken({ apiKey: cred.publicKey });

    // Rejected before any credential lookup — a public identifier alone is not
    // a partially-complete credential, it is no credential.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toHaveProperty('token');
  });

  it('POSITIVE CONTROL: the same credential mints a token when the real secret is sent', async () => {
    const cred = await credential();

    const res = await postServiceToken({ apiKey: cred.publicKey, apiSecret: cred.secret });

    expect(res.status).toBe(200);
    const data = res.body.data as { token?: unknown };
    expect(typeof data.token).toBe('string');
  });
});

describe('lane 2 — POST /auth/oauth/token', () => {
  /**
   * A confidential client: it has a secret, so it may NOT authenticate by
   * naming itself. This is the shape the wrong documentation described.
   */
  const confidential = () => credential({ type: 'confidential' }, { type: 'third_party' });

  it('REFUSES the client id presented as the client_secret', async () => {
    const cred = await confidential();

    const res = await postOAuthToken({
      grant_type: 'authorization_code',
      code: 'auth-code-1',
      redirect_uri: REDIRECT_URI,
      client_id: cred.publicKey,
      client_secret: cred.publicKey,
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect(res.body).not.toHaveProperty('access_token');
    // The exchange must not have been attempted: the secret is checked first,
    // so a caller without it cannot probe code-binding outcomes.
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });

  it('REFUSES the client id as the secret EVEN when a valid PKCE verifier is also present', async () => {
    const cred = await confidential();

    const res = await postOAuthToken({
      grant_type: 'authorization_code',
      code: 'auth-code-1',
      redirect_uri: REDIRECT_URI,
      client_id: cred.publicKey,
      client_secret: cred.publicKey,
      code_verifier: CODE_VERIFIER,
    });

    // The presence of a legitimate second factor must not make a WRONG secret
    // ignorable — otherwise the public identifier rides along unchecked.
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });

  it('REFUSES a request whose only credential is the client id itself', async () => {
    const cred = await confidential();

    const res = await postOAuthToken({
      grant_type: 'authorization_code',
      code: 'auth-code-1',
      redirect_uri: REDIRECT_URI,
      client_id: cred.publicKey,
    });

    // Neither a secret nor a PKCE verifier: nothing has been proven.
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });

  it('REFUSES the client id sent as the password half of HTTP Basic', async () => {
    const cred = await confidential();
    const encoded = Buffer.from(
      `${encodeURIComponent(cred.publicKey)}:${encodeURIComponent(cred.publicKey)}`,
    ).toString('base64');

    const address = server.address() as AddressInfo;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: 'auth-code-1',
      redirect_uri: REDIRECT_URI,
    }).toString();

    const res = await new Promise<JsonResponse>((resolve, reject) => {
      const req = http.request(
        {
          method: 'POST',
          host: '127.0.0.1',
          port: address.port,
          path: '/auth/oauth/token',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'content-length': Buffer.byteLength(body),
            authorization: `Basic ${encoded}`,
          },
        },
        (response) => {
          let raw = '';
          response.on('data', (chunk) => {
            raw += chunk;
          });
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              body: raw.length > 0 ? JSON.parse(raw) : {},
            }),
          );
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    // `client_secret_basic` is the method standard OAuth libraries reach for by
    // default, so it needs its own case — the parsing path differs from
    // `client_secret_post` even though the comparison that follows is shared.
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_client');
    expect(mockExchangeAuthCode).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: the same client authenticates when the real secret is sent', async () => {
    const cred = await confidential();
    const [subject] = await getDb().insert(users).values({}).returning({ id: users.id });
    mockExchangeAuthCode.mockResolvedValue({
      ok: true,
      code: { userId: subject.id, deviceId: null, operatedByUserId: null, scopes: [] },
    });

    const res = await postOAuthToken({
      grant_type: 'authorization_code',
      code: 'auth-code-1',
      redirect_uri: REDIRECT_URI,
      client_id: cred.publicKey,
      client_secret: cred.secret,
    });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBe('access-token-1');
    // The exchange WAS reached this time — which is what proves the rejections
    // above were the secret check and not an unrelated failure earlier on.
    expect(mockExchangeAuthCode).toHaveBeenCalledTimes(1);
  });
});
