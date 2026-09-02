/**
 * `POST /auth/service-token` — credential resolution, the trust gate and the
 * minted JWT claims — against a REAL Postgres.
 *
 * Service tokens are bearer credentials for Oxy-to-Oxy / internal routes, so
 * three things must hold and are asserted against stored rows rather than stubs:
 * the credential must be USABLE (`active`, or `deprecated` within its rotation
 * grace), the SECRET must match its stored SHA-256 hash under a constant-time
 * comparison, and the owning application must be platform-trusted — except for
 * the narrow Oxy Pay carve-out keyed on the CREDENTIAL's own payments-only
 * scopes.
 *
 * The previous version mocked `models/ApplicationCredential` /
 * `models/Application`, so the secret comparison never ran against a real
 * `secret_hash` and the scope intersection ran against a hand-built stub.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import * as nodeCrypto from 'node:crypto';
import { randomUUID } from 'node:crypto';

// `jest.setup.cjs` stubs `jsonwebtoken` globally (sign → a fixed string). The
// claims ARE the contract here, so restore the real module for this suite.
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
import jwt from 'jsonwebtoken';

process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret';

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
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import authRouter from '../auth';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

let server: http.Server;

function post(body: unknown): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: 'POST',
        host: '127.0.0.1',
        port: address.port,
        path: '/auth/service-token',
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

const sha256 = (value: string) => nodeCrypto.createHash('sha256').update(value).digest('hex');

interface ServiceClient {
  apiKey: string;
  apiSecret: string;
  applicationId: string;
  credentialId: string;
  ownerAccountId: string;
  appName: string;
}

/**
 * A real application + service credential. The defaults describe the ordinary
 * case: an internal (platform-trusted) app with an active `service` credential
 * whose stored hash matches `apiSecret`.
 */
async function serviceClient(
  credentialFields: Partial<typeof applicationCredentials.$inferInsert> = {},
  appFields: Partial<typeof applications.$inferInsert> = {},
): Promise<ServiceClient> {
  const [owner] = await getDb().insert(users).values({}).returning({ id: users.id });
  const appName = `App ${randomUUID()}`;
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: appName,
      type: 'internal',
      isInternal: true,
      scopes: ['user:read'],
      ...appFields,
      ownerAccountId: owner.id,
    })
    .returning({ id: applications.id });

  const apiKey = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  const apiSecret = randomUUID();
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: app.id,
      name: 'service',
      type: 'service',
      environment: 'production',
      secretHash: sha256(apiSecret),
      ...credentialFields,
      publicKey: apiKey,
    })
    .returning({ id: applicationCredentials.id });

  return {
    apiKey,
    apiSecret,
    applicationId: app.id,
    credentialId: credential.id,
    ownerAccountId: owner.id,
    appName,
  };
}

interface ServiceClaims {
  type?: string;
  appId?: string;
  appName?: string;
  credentialId?: string;
  ownerAccountId?: string;
  scopes?: string[];
  environment?: string;
  iss?: string;
  aud?: string | string[];
}

function decodeServiceJwt(token: string): ServiceClaims {
  return jwt.verify(token, process.env.ACCESS_TOKEN_SECRET as string) as ServiceClaims;
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

describe('POST /auth/service-token — credential usability', () => {
  it('mints a token for an ACTIVE service credential with the correct secret', async () => {
    const client = await serviceClient();

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ expiresIn: 3600, appName: client.appName });
  });

  it('accepts a DEPRECATED credential still inside its rotation grace', async () => {
    const client = await serviceClient({
      status: 'deprecated',
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    expect(res.status).toBe(200);
  });

  it('rejects a deprecated credential with NO grace expiry', async () => {
    const client = await serviceClient({ status: 'deprecated' });

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    expect(res.status).toBe(401);
  });

  it('rejects a deprecated credential whose grace has elapsed', async () => {
    const client = await serviceClient({
      status: 'deprecated',
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    expect(res.status).toBe(401);
  });

  it('rejects an ACTIVE credential whose explicit expiresAt has passed', async () => {
    const client = await serviceClient({ expiresAt: new Date(Date.now() - 1000) });

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    expect(res.status).toBe(401);
  });

  it('rejects a REVOKED credential immediately', async () => {
    const client = await serviceClient({ status: 'revoked' });

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    expect(res.status).toBe(401);
  });

  it('rejects an unknown apiKey', async () => {
    const res = await post({ apiKey: 'oxy_dk_unknown', apiSecret: 'anything' });
    expect(res.status).toBe(401);
  });

  it('rejects when the owning application is no longer active', async () => {
    const client = await serviceClient({}, { status: 'suspended' });

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    expect(res.status).toBe(401);
  });
});

describe('POST /auth/service-token — the secret and the credential type', () => {
  it('rejects a WRONG secret', async () => {
    const client = await serviceClient();

    const res = await post({ apiKey: client.apiKey, apiSecret: 'not-the-secret' });

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ message: 'Invalid credentials' });
  });

  it('rejects a credential that stores NO secret hash', async () => {
    const client = await serviceClient({ secretHash: null });

    const res = await post({ apiKey: client.apiKey, apiSecret: 'anything' });

    expect(res.status).toBe(401);
  });

  it('rejects a NON-service credential with 403', async () => {
    const client = await serviceClient({ type: 'confidential' });

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    expect(res.status).toBe(403);
  });
});

describe('POST /auth/service-token — the trust gate and the Oxy Pay carve-out', () => {
  it('rejects a NON-trusted application', async () => {
    const client = await serviceClient(
      { scopes: ['user:read'] },
      { type: 'third_party', isInternal: false, isOfficial: false, scopes: ['user:read'] },
    );

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    expect(res.status).toBe(403);
  });

  it('mints for a non-trusted app from a PAYMENTS-ONLY credential', async () => {
    const client = await serviceClient(
      { scopes: ['payments:read', 'payments:write'] },
      {
        type: 'third_party',
        isInternal: false,
        isOfficial: false,
        scopes: ['payments:read', 'payments:write'],
      },
    );

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    expect(res.status).toBe(200);
    const claims = decodeServiceJwt((res.body.data as { token: string }).token);
    expect([...(claims.scopes ?? [])].sort()).toEqual(['payments:read', 'payments:write']);
  });

  it('still rejects a non-trusted app whose credential holds ANY non-payments scope', async () => {
    const client = await serviceClient(
      { scopes: ['payments:read', 'user:read'] },
      {
        type: 'third_party',
        isInternal: false,
        isOfficial: false,
        scopes: ['payments:read', 'user:read'],
      },
    );

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    expect(res.status).toBe(403);
  });

  it('never applies the carve-out to a SCOPELESS credential', async () => {
    // A scopeless credential falls back to the app's FULL granted set, so it
    // must never qualify — only an explicit payments-only credential does.
    const client = await serviceClient(
      { scopes: [] },
      {
        type: 'third_party',
        isInternal: false,
        isOfficial: false,
        scopes: ['payments:read', 'user:read'],
      },
    );

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    expect(res.status).toBe(403);
  });

  it('leaves a TRUSTED application unaffected by the carve-out', async () => {
    const client = await serviceClient({ scopes: ['user:read'] });

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    expect(res.status).toBe(200);
  });
});

describe('POST /auth/service-token — the minted claims', () => {
  it('embeds appId, appName, credentialId, ownerAccountId, environment and iss/aud', async () => {
    const client = await serviceClient({ environment: 'staging' });

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    const claims = decodeServiceJwt((res.body.data as { token: string }).token);
    expect(claims.type).toBe('service');
    // The claim name `appId` is a WIRE CONTRACT — it is the Application id, and
    // `@oxyhq/core`'s service-token verification reads it under this name.
    expect(claims.appId).toBe(client.applicationId);
    expect(claims.appName).toBe(client.appName);
    expect(claims.credentialId).toBe(client.credentialId);
    expect(claims.environment).toBe('staging');
    expect(claims.iss).toBe('oxy-auth');
    expect(claims.aud).toBe('oxy-api');
    // ADR 0007: the financially responsible account, resolved server-side from
    // the credential's application. Asserted against the row the fixture
    // inserted, not against a value echoed back by the endpoint.
    expect(claims.ownerAccountId).toBe(client.ownerAccountId);
  });

  /**
   * The negative direction of the assertion above. `ownerAccountId` is what a
   * verifier will charge, so it must come from the APPLICATION's owner row and
   * from nowhere else — not from the request, and not from whoever happens to
   * have created the application.
   */
  it('resolves ownerAccountId from the application row, never from the request body', async () => {
    const [impostor] = await getDb().insert(users).values({}).returning({ id: users.id });
    const client = await serviceClient();

    const res = await post({
      apiKey: client.apiKey,
      apiSecret: client.apiSecret,
      ownerAccountId: impostor.id,
      accountId: impostor.id,
    });

    const claims = decodeServiceJwt((res.body.data as { token: string }).token);
    expect(claims.ownerAccountId).toBe(client.ownerAccountId);
    expect(claims.ownerAccountId).not.toBe(impostor.id);
  });

  it('follows the application when its owner account changes', async () => {
    // The control for the test above: the claim is a live read of
    // `applications.owner_account_id`, so it tracks a transfer rather than
    // being frozen at credential-creation time.
    const client = await serviceClient();
    const [newOwner] = await getDb().insert(users).values({}).returning({ id: users.id });
    await getDb()
      .update(applications)
      .set({ ownerAccountId: newOwner.id })
      .where(eq(applications.id, client.applicationId));

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    const claims = decodeServiceJwt((res.body.data as { token: string }).token);
    expect(claims.ownerAccountId).toBe(newOwner.id);
    expect(claims.ownerAccountId).not.toBe(client.ownerAccountId);
  });

  /**
   * `intersectScopes` runs at MINT time, not at credential-creation time, so a
   * scope the application has since lost disappears from the next token even
   * though the credential row still names it. Distinct from the fixtures that
   * create the mismatch up front: here the credential was legitimately granted
   * the scope and the grant was withdrawn afterwards.
   */
  it('drops a scope the application has SINCE lost', async () => {
    const client = await serviceClient(
      { scopes: ['user:read', 'files:write'] },
      { scopes: ['user:read', 'files:write'] },
    );

    const before = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });
    expect(decodeServiceJwt((before.body.data as { token: string }).token).scopes).toEqual([
      'user:read',
      'files:write',
    ]);

    await getDb()
      .update(applications)
      .set({ scopes: ['user:read'] })
      .where(eq(applications.id, client.applicationId));

    const after = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });
    expect(decodeServiceJwt((after.body.data as { token: string }).token).scopes).toEqual([
      'user:read',
    ]);
  });

  it('INTERSECTS credential scopes with app scopes — a scope the app lacks is stripped', async () => {
    const client = await serviceClient(
      { scopes: ['user:read', 'federation:write'] },
      { scopes: ['user:read'] },
    );

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    const claims = decodeServiceJwt((res.body.data as { token: string }).token);
    expect(claims.scopes).toEqual(['user:read']);
  });

  it('preserves a privileged scope when BOTH the credential and the app hold it', async () => {
    const client = await serviceClient(
      { scopes: ['federation:write'] },
      { scopes: ['user:read', 'federation:write'] },
    );

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    const claims = decodeServiceJwt((res.body.data as { token: string }).token);
    expect(claims.scopes).toEqual(['federation:write']);
  });

  it('falls back to the app scopes when the credential requested none', async () => {
    const client = await serviceClient({ scopes: [] }, { scopes: ['user:read', 'files:read'] });

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    const claims = decodeServiceJwt((res.body.data as { token: string }).token);
    expect([...(claims.scopes ?? [])].sort()).toEqual(['files:read', 'user:read']);
  });

  it('never lets a legacy scopeless credential inherit privileged app scopes', async () => {
    const client = await serviceClient(
      { scopes: [] },
      { scopes: ['user:read', 'acting-as:offline', 'accounts:act-as-session'] },
    );

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    const claims = decodeServiceJwt((res.body.data as { token: string }).token);
    expect(claims.scopes).toEqual(['user:read']);
  });

  /**
   * The inference escalation (#972 workstream 3), asserted at the MINT rather
   * than only on `intersectScopes`: `inference:providers:write` is staff-gated
   * because it manages provider/BYOK connections, so a credential naming it on
   * an application that was never granted it must come back without it. The
   * credential row itself is legal — the CHECK is a vocabulary, not an
   * authorization — which is exactly why the intersection has to be the thing
   * that refuses.
   */
  it('strips inference:providers:write from a credential whose app was never granted it', async () => {
    const client = await serviceClient(
      { scopes: ['inference:invoke', 'inference:providers:write'] },
      { scopes: ['inference:invoke', 'inference:providers:read'] },
    );

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    const claims = decodeServiceJwt((res.body.data as { token: string }).token);
    expect(claims.scopes).toEqual(['inference:invoke']);
  });

  it('mints inference:providers:write when the application genuinely holds it', async () => {
    // The control for the assertion above: the scope is mintable, so the
    // stripping there is the intersection and not an inference scope being
    // unreachable through this endpoint.
    const client = await serviceClient(
      { scopes: ['inference:providers:write'] },
      { scopes: ['inference:invoke', 'inference:providers:write'] },
    );

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    const claims = decodeServiceJwt((res.body.data as { token: string }).token);
    expect(claims.scopes).toEqual(['inference:providers:write']);
  });

  it('mints nothing at all for a REVOKED credential holding inference scopes', async () => {
    // Revocation outranks the grant: the credential and its application both
    // hold the scope, and the mint still refuses, so no inference authority
    // survives a revoke.
    const client = await serviceClient(
      { status: 'revoked', scopes: ['inference:invoke'] },
      { scopes: ['inference:invoke'] },
    );

    const res = await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    expect(res.status).toBe(401);
    expect(res.body.data).toBeUndefined();
  });
});

describe('POST /auth/service-token — bookkeeping', () => {
  it('stamps last_used_at on BOTH the credential and the application', async () => {
    const client = await serviceClient();

    await post({ apiKey: client.apiKey, apiSecret: client.apiSecret });

    const [credential] = await getDb()
      .select({ lastUsedAt: applicationCredentials.lastUsedAt })
      .from(applicationCredentials)
      .where(eq(applicationCredentials.id, client.credentialId))
      .limit(1);
    const [app] = await getDb()
      .select({ lastUsedAt: applications.lastUsedAt })
      .from(applications)
      .where(eq(applications.id, client.applicationId))
      .limit(1);

    expect(credential.lastUsedAt).toBeInstanceOf(Date);
    expect(app.lastUsedAt).toBeInstanceOf(Date);
  });

  it('records nothing when the secret is wrong', async () => {
    const client = await serviceClient();

    await post({ apiKey: client.apiKey, apiSecret: 'wrong' });

    const [credential] = await getDb()
      .select({ lastUsedAt: applicationCredentials.lastUsedAt })
      .from(applicationCredentials)
      .where(eq(applicationCredentials.id, client.credentialId))
      .limit(1);
    expect(credential.lastUsedAt).toBeNull();
  });
});
