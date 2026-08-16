/**
 * `/inference/provider-connections` — the scope gate, cross-account isolation
 * and the refusal path, against a REAL Postgres (issue #972 workstream 10).
 *
 * Three claims, and each has a POSITIVE CONTROL beside it, because each of these
 * checks would also pass if the route simply never worked:
 *
 *  - `inference:providers:write` is required to mutate. A credential without it
 *    is refused; a credential WITH it, on the same request, succeeds.
 *  - An account cannot reach another account's connection. The owner, on the
 *    same connection, can.
 *  - With no secret backend the credential-accepting routes refuse before
 *    reading the body. The routes that need no credential still work.
 *
 * The service token is minted here rather than through `POST /auth/service-token`
 * so a case can hold exactly one scope: the point is the GATE, not the mint,
 * which `serviceTokenCredentials.test.ts` already covers.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';

// `jest.setup.cjs` stubs `jsonwebtoken` globally (sign → a fixed string). The
// service-token claims ARE the gate here, so restore the real module.
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
import jwt from 'jsonwebtoken';

process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret';

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { inferenceProviderConnections } from '../../db/schema/inferenceProviderConnections';
import { inferenceProviders } from '../../db/schema/inferenceProviders';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import providerConnectionRouter from '../inferenceProviderConnections';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

let server: http.Server;

function request(
  method: 'GET' | 'POST',
  path: string,
  token: string,
  body?: unknown
): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method,
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          authorization: `Bearer ${token}`,
          ...(payload === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {},
            raw,
          });
        });
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/inference/provider-connections', providerConnectionRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  await closePostgres();
});

const ORIGINAL_STORE = process.env.INFERENCE_PROVIDER_SECRET_STORE;

afterEach(() => {
  if (ORIGINAL_STORE === undefined) delete process.env.INFERENCE_PROVIDER_SECRET_STORE;
  else process.env.INFERENCE_PROVIDER_SECRET_STORE = ORIGINAL_STORE;
});

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

function serviceToken(input: {
  appId: string;
  ownerAccountId: string;
  scopes: string[];
}): string {
  return jwt.sign(
    {
      type: 'service',
      appId: input.appId,
      appName: 'Fixture App',
      credentialId: `cred-${suffix()}`,
      ownerAccountId: input.ownerAccountId,
      environment: 'production',
      scopes: input.scopes,
    },
    process.env.ACCESS_TOKEN_SECRET as string,
    { expiresIn: '1h' }
  );
}

async function insertAccount(): Promise<string> {
  const tag = suffix();
  const [row] = await getDb()
    .insert(users)
    .values({ username: `byokr-${tag}`, email: `byokr-${tag}@example.test` })
    .returning({ id: users.id });
  return row.id;
}

async function insertApplication(ownerAccountId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `BYOKR ${suffix()}`, ownerAccountId })
    .returning({ id: applications.id });
  return row.id;
}

async function insertProvider(): Promise<string> {
  const slug = `prvr${suffix()}`;
  await getDb()
    .insert(inferenceProviders)
    .values({
      slug,
      displayName: 'Fixture Provider',
      kind: 'customer_byok',
      retainsPayloads: false,
      retentionDays: 0,
      trainsOnCustomerData: false,
      zeroDataRetentionAvailable: true,
    });
  return slug;
}

/**
 * A stored connection, written directly.
 *
 * Deliberately NOT via the create route: with no secret backend configured that
 * route refuses, which is the behaviour under test elsewhere in this file. The
 * row is built to the same partition rule the service builds it to.
 */
async function seedConnection(ownerAccountId: string, provider: string): Promise<string> {
  const id = uuidv7();
  await getDb()
    .insert(inferenceProviderConnections)
    .values({
      id,
      provider,
      ownerAccountId,
      scopeKind: 'account',
      environment: 'production',
      status: 'pending_validation',
      secretRef: `secretsmanager:oxy/inference/byok/production/${ownerAccountId}/${id}`,
      keyPrefix: 'sk-live-1234',
      fingerprint: 'b'.repeat(64),
      validationState: 'unvalidated',
    });
  return id;
}

/* -------------------------------------------------------------------------- */

describe('the `inference:providers:write` scope gate', () => {
  it('refuses a mutation from a credential that does not carry it', async () => {
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();
    const connection = await seedConnection(account, provider);

    // Holds the READ scope, which is not staff-gated. It must not be enough.
    const token = serviceToken({
      appId: application,
      ownerAccountId: account,
      scopes: ['inference:providers:read'],
    });

    const response = await request(
      'POST',
      `/inference/provider-connections/${connection}/disable`,
      token,
      {}
    );
    expect(response.status).toBe(403);
    expect(response.body.message).toContain('inference:providers:write');

    // …and nothing moved.
    const [row] = await getDb()
      .select({ status: inferenceProviderConnections.status })
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.id, connection));
    expect(row.status).toBe('pending_validation');
  });

  it('POSITIVE CONTROL: the same mutation succeeds with the scope', async () => {
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();
    const connection = await seedConnection(account, provider);

    const token = serviceToken({
      appId: application,
      ownerAccountId: account,
      scopes: ['inference:providers:read', 'inference:providers:write'],
    });

    const response = await request(
      'POST',
      `/inference/provider-connections/${connection}/disable`,
      token,
      {}
    );
    expect(response.status).toBe(200);

    const [row] = await getDb()
      .select({ status: inferenceProviderConnections.status })
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.id, connection));
    expect(row.status).toBe('disabled');
  });

  it('refuses a READ from a credential carrying neither scope', async () => {
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();
    const connection = await seedConnection(account, provider);

    const token = serviceToken({
      appId: application,
      ownerAccountId: account,
      scopes: ['inference:invoke'],
    });

    const response = await request(
      'GET',
      `/inference/provider-connections/${connection}`,
      token
    );
    expect(response.status).toBe(403);
  });

  it('POSITIVE CONTROL: the same read succeeds with `inference:providers:read`', async () => {
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();
    const connection = await seedConnection(account, provider);

    const token = serviceToken({
      appId: application,
      ownerAccountId: account,
      scopes: ['inference:providers:read'],
    });

    const response = await request(
      'GET',
      `/inference/provider-connections/${connection}`,
      token
    );
    expect(response.status).toBe(200);
    const data = response.body.data as Record<string, unknown>;
    expect(data.connectionId).toBe(connection);
  });
});

describe('cross-account isolation', () => {
  it('does not let one account READ another’s connection', async () => {
    const owner = await insertAccount();
    const provider = await insertProvider();
    const connection = await seedConnection(owner, provider);

    const stranger = await insertAccount();
    const strangerApp = await insertApplication(stranger);
    // Holds BOTH scopes. Authority over your own tenant is not authority over
    // somebody else's, and the scope is deliberately not what decides this.
    const token = serviceToken({
      appId: strangerApp,
      ownerAccountId: stranger,
      scopes: ['inference:providers:read', 'inference:providers:write'],
    });

    const response = await request(
      'GET',
      `/inference/provider-connections/${connection}`,
      token
    );
    // 404, never 403: distinguishing them would make the id space an existence
    // oracle for another tenant's BYOK setup.
    expect(response.status).toBe(404);
  });

  it('does not let one account MUTATE another’s connection', async () => {
    const owner = await insertAccount();
    const provider = await insertProvider();
    const connection = await seedConnection(owner, provider);

    const stranger = await insertAccount();
    const strangerApp = await insertApplication(stranger);
    const token = serviceToken({
      appId: strangerApp,
      ownerAccountId: stranger,
      scopes: ['inference:providers:read', 'inference:providers:write'],
    });

    const response = await request(
      'POST',
      `/inference/provider-connections/${connection}/revoke`,
      token,
      {}
    );
    expect(response.status).toBe(404);

    const [row] = await getDb()
      .select({ status: inferenceProviderConnections.status })
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.id, connection));
    expect(row.status).toBe('pending_validation');
  });

  it('POSITIVE CONTROL: the owner reaches the same connection', async () => {
    const owner = await insertAccount();
    const ownerApp = await insertApplication(owner);
    const provider = await insertProvider();
    const connection = await seedConnection(owner, provider);

    const token = serviceToken({
      appId: ownerApp,
      ownerAccountId: owner,
      scopes: ['inference:providers:read', 'inference:providers:write'],
    });

    expect(
      (await request('GET', `/inference/provider-connections/${connection}`, token)).status
    ).toBe(200);
    expect(
      (
        await request(
          'POST',
          `/inference/provider-connections/${connection}/revoke`,
          token,
          {}
        )
      ).status
    ).toBe(200);
  });

  it('does not let a service token reach an application it does not own', async () => {
    const owner = await insertAccount();
    const ownerApp = await insertApplication(owner);
    const provider = await insertProvider();

    const stranger = await insertAccount();
    const strangerApp = await insertApplication(stranger);
    const token = serviceToken({
      appId: strangerApp,
      ownerAccountId: stranger,
      scopes: ['inference:providers:read'],
    });

    const response = await request(
      'GET',
      `/inference/provider-connections/applications/${ownerApp}?provider=${provider}&environment=production`,
      token
    );
    expect(response.status).toBe(404);
  });
});

describe('with no secret backend configured', () => {
  it('refuses a create with a typed 503 and writes nothing', async () => {
    delete process.env.INFERENCE_PROVIDER_SECRET_STORE;
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();
    const token = serviceToken({
      appId: application,
      ownerAccountId: account,
      scopes: ['inference:providers:write'],
    });
    const plaintext = `sk-live-${randomUUID()}`;

    const response = await request(
      'POST',
      `/inference/provider-connections/accounts/${account}`,
      token,
      { provider, environment: 'production', scope: 'account', secret: plaintext }
    );

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('provider_secret_store_unavailable');
    expect((response.body.details as Record<string, unknown>).reason).toBe('not-configured');
    // The refusal must not quote back the thing it refused to hold.
    expect(response.raw).not.toContain(plaintext);

    const rows = await getDb()
      .select({ id: inferenceProviderConnections.id })
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.ownerAccountId, account));
    expect(rows).toHaveLength(0);
  });

  it('refuses a rotation the same way', async () => {
    delete process.env.INFERENCE_PROVIDER_SECRET_STORE;
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();
    const connection = await seedConnection(account, provider);
    const token = serviceToken({
      appId: application,
      ownerAccountId: account,
      scopes: ['inference:providers:write'],
    });

    const response = await request(
      'POST',
      `/inference/provider-connections/${connection}/rotate`,
      token,
      { secret: 'sk-live-rotate' }
    );
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('provider_secret_store_unavailable');
  });

  it('names an unrecognised store rather than the generic refusal', async () => {
    process.env.INFERENCE_PROVIDER_SECRET_STORE = 's3';
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();
    const token = serviceToken({
      appId: application,
      ownerAccountId: account,
      scopes: ['inference:providers:write'],
    });

    const response = await request(
      'POST',
      `/inference/provider-connections/accounts/${account}`,
      token,
      { provider, environment: 'production', scope: 'account', secret: 'sk-live-x' }
    );
    expect(response.status).toBe(503);
    expect((response.body.details as Record<string, unknown>).reason).toBe('unknown-store');
  });

  it('refuses an UNAUTHORISED caller with 403, not 503', async () => {
    /*
     * Order matters, and this is what holds it: a caller with no authority must
     * never learn what this deployment is configured with. Authorise first, then
     * resolve the store.
     */
    delete process.env.INFERENCE_PROVIDER_SECRET_STORE;
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();
    const token = serviceToken({
      appId: application,
      ownerAccountId: account,
      scopes: ['inference:providers:read'],
    });

    const response = await request(
      'POST',
      `/inference/provider-connections/accounts/${account}`,
      token,
      { provider, environment: 'production', scope: 'account', secret: 'sk-live-y' }
    );
    expect(response.status).toBe(403);
  });

  it('still serves the routes that need no credential', async () => {
    delete process.env.INFERENCE_PROVIDER_SECRET_STORE;
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();
    const connection = await seedConnection(account, provider);
    const token = serviceToken({
      appId: application,
      ownerAccountId: account,
      scopes: ['inference:providers:read', 'inference:providers:write'],
    });

    // Disable, revoke, validation-verdict and every read work without a store —
    // so an unconfigured deployment is not one where a customer is stuck.
    expect(
      (
        await request(
          'POST',
          `/inference/provider-connections/${connection}/disable`,
          token,
          {}
        )
      ).status
    ).toBe(200);
    expect(
      (
        await request(
          'GET',
          `/inference/provider-connections/${connection}/audit`,
          token
        )
      ).status
    ).toBe(200);
    expect(
      (
        await request(
          'POST',
          `/inference/provider-connections/${connection}/revoke`,
          token,
          {}
        )
      ).status
    ).toBe(200);
  });
});

describe('the response body', () => {
  it('carries a reference and a prefix, and no field a credential could occupy', async () => {
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();
    const connection = await seedConnection(account, provider);
    const token = serviceToken({
      appId: application,
      ownerAccountId: account,
      scopes: ['inference:providers:read'],
    });

    const response = await request(
      'GET',
      `/inference/provider-connections/${connection}`,
      token
    );
    const data = response.body.data as Record<string, unknown>;

    expect(Object.keys(data)).not.toContain('secret');
    expect(Object.keys(data)).not.toContain('apiKey');
    expect(Object.keys(data)).not.toContain('token');
    expect(String(data.secretRef)).toMatch(/^secretsmanager:oxy\/inference\/byok\//);
    expect(String(data.keyPrefix).length).toBeLessThanOrEqual(12);
    expect(data.upstreamBillsCustomerDirectly).toBe(true);
  });
});
