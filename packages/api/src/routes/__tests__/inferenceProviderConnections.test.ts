/**
 * `/inference/provider-connections` — the scope gate, cross-account isolation
 * and the refusal path, against a REAL Postgres (issue #972 workstream 10).
 *
 * Four claims, and each has a POSITIVE CONTROL beside it, because every one of
 * these checks would also pass if the route simply never worked:
 *
 *  - `inference:providers:read` is required to read. A credential without it is
 *    refused; a credential WITH it, on the same request, succeeds.
 *  - **A service credential may not write at all** (issue #972 §3), whatever scope
 *    it carries. The same credential still reads; a person holding
 *    `inference:providers:write` still writes.
 *  - An account cannot reach another account's connection. The owner, on the
 *    same connection, can.
 *  - With no secret backend the credential-accepting routes refuse before
 *    reading the body. The routes that need no credential still work.
 *
 * The file therefore drives BOTH lanes. A service token is minted here rather than
 * through `POST /auth/service-token` so a case can hold exactly one scope — the
 * point is the GATE, not the mint, which `serviceTokenCredentials.test.ts` covers.
 * A person is spoken as by setting `currentUserId` and sending no bearer at all.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { generateKeyPairSync, randomUUID } from 'node:crypto';

// `jest.setup.cjs` stubs `jsonwebtoken` globally (sign → a fixed string). The
// service-token claims ARE the gate here, so restore the real module.
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
import jwt from 'jsonwebtoken';

process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret';

/**
 * The user lane. A request with NO `Authorization` header falls past
 * `verifyServiceToken` to `authMiddleware`, so setting `currentUserId` is how a
 * case speaks as a person rather than as a credential — which this file now needs,
 * because the WRITE routes no longer have a service lane at all.
 */
let currentUserId = '';
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string } },
    _res: unknown,
    next: () => void,
  ) => {
    if (currentUserId.length > 0) {
      req.user = { _id: currentUserId, id: currentUserId };
    }
    next();
  },
}));

jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

import { eq } from 'drizzle-orm';
import { uuidv7 } from '@oxyhq/db';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { applications } from '../../db/schema/applications';
import { inferenceProviderConnections } from '../../db/schema/inferenceProviderConnections';
import { inferenceProviders } from '../../db/schema/inferenceProviders';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import providerConnectionRouter from '../inferenceProviderConnections';
import { permissionsForAccountRole, type AccountRole } from '../../utils/accountRoles';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

let server: http.Server;

/**
 * `token` is optional: omitting it sends NO `Authorization` header, which is how
 * a case arrives on the user lane (see the `authMiddleware` mock above).
 */
function request(
  method: 'GET' | 'POST',
  path: string,
  token: string | undefined,
  body?: unknown,
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
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
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
      },
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
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closePostgres();
});

const ORIGINAL_CONTROL_KEY_ID = process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_KEY_ID;
const ORIGINAL_CONTROL_PRIVATE_KEY = process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY;
const ORIGINAL_KAANA_BASE_URL = process.env.KAANA_BASE_URL;

beforeEach(() => {
  // A leaked `currentUserId` would let a SERVICE-lane case fall through to the
  // user lane and pass for the wrong reason.
  currentUserId = '';
});

afterEach(() => {
  if (ORIGINAL_CONTROL_KEY_ID === undefined)
    delete process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_KEY_ID;
  else process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_KEY_ID = ORIGINAL_CONTROL_KEY_ID;
  if (ORIGINAL_CONTROL_PRIVATE_KEY === undefined)
    delete process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY;
  else process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY = ORIGINAL_CONTROL_PRIVATE_KEY;
  if (ORIGINAL_KAANA_BASE_URL === undefined) delete process.env.KAANA_BASE_URL;
  else process.env.KAANA_BASE_URL = ORIGINAL_KAANA_BASE_URL;
  jest.restoreAllMocks();
});

function suffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 10);
}

function serviceToken(input: { appId: string; ownerAccountId: string; scopes: string[] }): string {
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
    { expiresIn: '1h' },
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

/**
 * A member of `accountId`. `insertAccount` returns a `users.id`, which IS an
 * account id in the unified graph, so a member row is all a person needs to
 * resolve through `resolveCallerAccountAccess`.
 */
async function insertMember(
  accountId: string,
  memberUserId: string,
  role: AccountRole,
): Promise<void> {
  await getDb()
    .insert(accountMembers)
    .values({ accountId, memberUserId, role, inherit: true, status: 'active' });
}

/** A fresh person holding `role` over `accountId`, ready to be spoken as. */
async function insertMemberAccount(accountId: string, role: AccountRole): Promise<string> {
  const member = await insertAccount();
  await insertMember(accountId, member, role);
  return member;
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
  await getDb().insert(inferenceProviders).values({
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
      custodyState: 'ready',
      credentialHandle: `kcred_${randomUUID()
        .replace(/-/g, '')
        .replace(/[0189]/g, 'a')
        .slice(0, 26)}`,
      credentialRevision: 1,
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
      {},
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

  it('POSITIVE CONTROL: with the scope, the caller gets PAST the scope check', async () => {
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
      {},
    );

    // "It succeeds" is not available as a control any more: a service credential
    // has no write lane at all (see the refusal suite below). What separates a
    // working scope check from a route that refuses everything is that the SAME
    // request WITH the scope is refused for a DIFFERENT and LATER reason.
    expect(response.status).toBe(403);
    expect(response.body.message).toBe('A service credential may not change provider connections');
    expect(response.body.message).not.toContain('does not carry');
  });

  it('POSITIVE CONTROL: a USER holding the permission makes the same mutation', async () => {
    // The write lane end to end, so the refusals above are the gate and not a
    // route that cannot disable a connection at all.
    const account = await insertAccount();
    const provider = await insertProvider();
    const connection = await seedConnection(account, provider);

    currentUserId = await insertMemberAccount(account, 'admin');
    const response = await request(
      'POST',
      `/inference/provider-connections/${connection}/disable`,
      undefined,
      {},
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

    const response = await request('GET', `/inference/provider-connections/${connection}`, token);
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

    const response = await request('GET', `/inference/provider-connections/${connection}`, token);
    expect(response.status).toBe(200);
    const data = response.body.data as Record<string, unknown>;
    expect(data.connectionId).toBe(connection);
  });
});

/**
 * A service credential has NO write lane on this surface (issue #972 §3).
 *
 * The escalation this closes, all of it inside one tenant: the service lane used
 * to check the SCOPE and the owner match and then return, never consulting an
 * account permission, while the user lane on the same function required one that
 * only `owner` and `admin` hold. So a member with the `developer` role —
 * `credentials:create` and `credentials:rotate`, no BYOK write — could mint or
 * rotate a `service` credential carrying `inference:providers:write` and register,
 * rotate and destroy provider secrets they would be refused as a signed-in user.
 */
describe('a service credential may not change provider connections', () => {
  /** Every configuration write, and the body each needs. */
  const WRITES: readonly {
    readonly what: string;
    readonly path: string;
    readonly body: unknown;
  }[] = [
    { what: 'rotate', path: '/rotate', body: { secret: 'sk-live-rotated' } },
    { what: 'disable', path: '/disable', body: {} },
    { what: 'enable', path: '/enable', body: {} },
    { what: 'revoke', path: '/revoke', body: {} },
    { what: 'reconcile', path: '/reconcile', body: {} },
    // Inside the refusal deliberately: an `invalid` verdict DISABLES the
    // connection, so leaving this open would leave a disable-equivalent open to
    // exactly the credential the refusal exists to stop.
    // The body is deliberately VALID: `validate()` runs before the handler, so a
    // malformed verdict would 400 and the refusal below would never be reached.
    {
      what: 'validation',
      path: '/validation',
      body: { state: 'invalid', failureCode: 'unauthorized' },
    },
  ];

  it.each(WRITES)('refuses $what, even carrying the staff-gated write scope', async (write) => {
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();
    const connection = await seedConnection(account, provider);

    // The escalating credential, reproduced exactly: its own owner account, and
    // the scope staff granted the application.
    const token = serviceToken({
      appId: application,
      ownerAccountId: account,
      scopes: ['inference:providers:read', 'inference:providers:write'],
    });

    const response = await request(
      'POST',
      `/inference/provider-connections/${connection}${write.path}`,
      token,
      write.body,
    );
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: 'FORBIDDEN',
      message: 'A service credential may not change provider connections',
    });

    // …and nothing moved.
    const [row] = await getDb()
      .select({
        status: inferenceProviderConnections.status,
        validationState: inferenceProviderConnections.validationState,
      })
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.id, connection));
    expect(row.status).toBe('pending_validation');
    expect(row.validationState).toBe('unvalidated');
  });

  it('refuses a REGISTRATION on both the account and the application lane', async () => {
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();
    const token = serviceToken({
      appId: application,
      ownerAccountId: account,
      scopes: ['inference:providers:write'],
    });
    const body = {
      provider,
      environment: 'production',
      acknowledgeProviderTerms: false,
      secret: 'sk-live-registered',
    };

    // 403 BEFORE the 503 the missing secret store would produce, which is also
    // the ordering invariant: an unauthorised caller never learns what this
    // deployment is configured with.
    const accountLane = await request(
      'POST',
      `/inference/provider-connections/accounts/${account}`,
      token,
      { ...body, scope: 'account' },
    );
    expect(accountLane.status).toBe(403);
    expect(accountLane.body.message).toBe(
      'A service credential may not change provider connections',
    );

    const applicationLane = await request(
      'POST',
      `/inference/provider-connections/applications/${application}`,
      token,
      body,
    );
    expect(applicationLane.status).toBe(403);
    expect(applicationLane.body.message).toBe(
      'A service credential may not change provider connections',
    );

    const rows = await getDb()
      .select({ id: inferenceProviderConnections.id })
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.ownerAccountId, account));
    expect(rows).toHaveLength(0);
  });

  it('POSITIVE CONTROL: the SAME credential still reads everything', async () => {
    // Without this the suite above would be satisfied by a router that refused
    // every service request, which is not the change.
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();
    const connection = await seedConnection(account, provider);
    const token = serviceToken({
      appId: application,
      ownerAccountId: account,
      scopes: ['inference:providers:read', 'inference:providers:write'],
    });

    for (const path of [
      `/inference/provider-connections/${connection}`,
      `/inference/provider-connections/${connection}/audit`,
      `/inference/provider-connections/accounts/${account}`,
      `/inference/provider-connections/applications/${application}?provider=${provider}&environment=production`,
    ]) {
      expect((await request('GET', path, token)).status).toBe(200);
    }
  });

  it('closes the `developer`-role path the escalation ran through', async () => {
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();
    const connection = await seedConnection(account, provider);

    // NON-VACUITY: the scenario needs a role that can mint and rotate credentials
    // and cannot write BYOK. If `developer` ever gained the write, or lost
    // `credentials:create`, the case below would pass while testing nothing.
    const developerPermissions = permissionsForAccountRole('developer');
    expect(developerPermissions).toContain('credentials:create');
    expect(developerPermissions).toContain('credentials:rotate');
    expect(developerPermissions).not.toContain('inference:providers:write');

    // As themselves: refused, naming the permission they lack.
    currentUserId = await insertMemberAccount(account, 'developer');
    const asPerson = await request(
      'POST',
      `/inference/provider-connections/${connection}/disable`,
      undefined,
      {},
    );
    expect(asPerson.status).toBe(403);
    expect(asPerson.body.message).toBe(
      'This action requires the inference:providers:write permission',
    );

    // Through the credential they are entitled to mint: refused as well. This is
    // the half that used to succeed.
    currentUserId = '';
    const throughCredential = await request(
      'POST',
      `/inference/provider-connections/${connection}/disable`,
      serviceToken({
        appId: application,
        ownerAccountId: account,
        scopes: ['inference:providers:write'],
      }),
      {},
    );
    expect(throughCredential.status).toBe(403);
    expect(throughCredential.body.message).toBe(
      'A service credential may not change provider connections',
    );

    // POSITIVE CONTROL: an `admin` on the same account, same URL, same body.
    currentUserId = await insertMemberAccount(account, 'admin');
    expect(
      (
        await request(
          'POST',
          `/inference/provider-connections/${connection}/disable`,
          undefined,
          {},
        )
      ).status,
    ).toBe(200);
  });

  it('withholds BYOK READ from a viewer, which `account:read` used to confer', async () => {
    // The other half of the RBAC change: BYOK read was inherited from
    // `account:read`, which every role holds. It returns no credential material,
    // but it does return the provider, a key prefix, a fingerprint and the
    // validation failures.
    const account = await insertAccount();
    const provider = await insertProvider();
    const connection = await seedConnection(account, provider);

    expect(permissionsForAccountRole('viewer')).toContain('account:read');
    expect(permissionsForAccountRole('viewer')).not.toContain('inference:providers:read');

    currentUserId = await insertMemberAccount(account, 'viewer');
    const refused = await request(
      'GET',
      `/inference/provider-connections/${connection}`,
      undefined,
    );
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe(
      'This action requires the inference:providers:read permission',
    );

    // POSITIVE CONTROL: an `editor`, who does hold it, reads the same connection.
    currentUserId = await insertMemberAccount(account, 'editor');
    expect(
      (await request('GET', `/inference/provider-connections/${connection}`, undefined)).status,
    ).toBe(200);
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

    const response = await request('GET', `/inference/provider-connections/${connection}`, token);
    // 404, never 403: distinguishing them would make the id space an existence
    // oracle for another tenant's BYOK setup.
    expect(response.status).toBe(404);
  });

  it('does not let one account’s MEMBER mutate another’s connection', async () => {
    // On the USER lane, because the service lane no longer has a write to isolate:
    // a stranger's admin holds `inference:providers:write` over their OWN account
    // and it must not reach this one.
    const owner = await insertAccount();
    const provider = await insertProvider();
    const connection = await seedConnection(owner, provider);

    const stranger = await insertAccount();
    currentUserId = await insertMemberAccount(stranger, 'admin');

    const response = await request(
      'POST',
      `/inference/provider-connections/${connection}/revoke`,
      undefined,
      {},
    );
    // 404, never 403: distinguishing them would make the id space an existence
    // oracle for another tenant's BYOK setup.
    expect(response.status).toBe(404);

    const [row] = await getDb()
      .select({ status: inferenceProviderConnections.status })
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.id, connection));
    expect(row.status).toBe('pending_validation');
  });

  it('POSITIVE CONTROL: the owner reaches the same connection, on both lanes', async () => {
    const owner = await insertAccount();
    const ownerApp = await insertApplication(owner);
    const provider = await insertProvider();
    const connection = await seedConnection(owner, provider);

    const token = serviceToken({
      appId: ownerApp,
      ownerAccountId: owner,
      scopes: ['inference:providers:read', 'inference:providers:write'],
    });

    // The credential READS its own account's connection.
    expect(
      (await request('GET', `/inference/provider-connections/${connection}`, token)).status,
    ).toBe(200);

    // …and the account's own admin gets past authorization at the identical URL
    // the stranger above was refused. With control signing unset, the later
    // exact-outcome gate returns 503 after fencing the connection locally.
    currentUserId = await insertMemberAccount(owner, 'admin');
    const revoke = await request(
      'POST',
      `/inference/provider-connections/${connection}/revoke`,
      undefined,
      {},
    );
    expect(revoke.status).toBe(503);
    expect(revoke.body.error).toBe('kaana_credential_reconcile_required');
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
      token,
    );
    expect(response.status).toBe(404);
  });
});

describe('with no Kaana credential control configured', () => {
  it('refuses a create with a typed 503 and writes nothing', async () => {
    delete process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_KEY_ID;
    delete process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY;
    const account = await insertAccount();
    const provider = await insertProvider();
    currentUserId = await insertMemberAccount(account, 'admin');
    const plaintext = `sk-live-${randomUUID()}`;

    const response = await request(
      'POST',
      `/inference/provider-connections/accounts/${account}`,
      undefined,
      {
        provider,
        environment: 'production',
        scope: 'account',
        secret: plaintext,
      },
    );

    expect(response.status).toBe(503);
    expect(response.body.error).toBe('kaana_credential_control_unavailable');
    // The refusal must not quote back the thing it refused to hold.
    expect(response.raw).not.toContain(plaintext);

    const rows = await getDb()
      .select({ id: inferenceProviderConnections.id })
      .from(inferenceProviderConnections)
      .where(eq(inferenceProviderConnections.ownerAccountId, account));
    expect(rows).toHaveLength(0);
  });

  it('refuses a rotation the same way', async () => {
    delete process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_KEY_ID;
    delete process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY;
    const account = await insertAccount();
    const provider = await insertProvider();
    const connection = await seedConnection(account, provider);
    currentUserId = await insertMemberAccount(account, 'admin');

    const response = await request(
      'POST',
      `/inference/provider-connections/${connection}/rotate`,
      undefined,
      { secret: 'sk-live-rotate' },
    );
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('kaana_credential_control_unavailable');
  });

  it('refuses a partial control signing configuration', async () => {
    process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_KEY_ID = 'control-1';
    delete process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY;
    const account = await insertAccount();
    const provider = await insertProvider();
    currentUserId = await insertMemberAccount(account, 'admin');

    const response = await request(
      'POST',
      `/inference/provider-connections/accounts/${account}`,
      undefined,
      {
        provider,
        environment: 'production',
        scope: 'account',
        secret: 'sk-live-x',
      },
    );
    expect(response.status).toBe(503);
    expect(response.body.error).toBe('kaana_credential_control_unavailable');
  });

  it('refuses an UNAUTHORISED caller with 403, not 503', async () => {
    /*
     * Order matters, and this is what holds it: a caller with no authority must
     * never learn what this deployment is configured with. Authorise first, then
     * resolve the store.
     */
    delete process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_KEY_ID;
    delete process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY;
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
      {
        provider,
        environment: 'production',
        scope: 'account',
        secret: 'sk-live-y',
      },
    );
    expect(response.status).toBe(403);
  });

  it('still serves the routes that need no credential', async () => {
    delete process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_KEY_ID;
    delete process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY;
    const account = await insertAccount();
    const application = await insertApplication(account);
    const provider = await insertProvider();
    const connection = await seedConnection(account, provider);
    const token = serviceToken({
      appId: application,
      ownerAccountId: account,
      scopes: ['inference:providers:read'],
    });

    // Disable, validation-verdict and every read work without Kaana control.
    // A revoke still fences the connection locally, but cannot claim the remote
    // credential was revoked without an exact signed outcome.
    currentUserId = await insertMemberAccount(account, 'admin');
    expect(
      (
        await request(
          'POST',
          `/inference/provider-connections/${connection}/disable`,
          undefined,
          {},
        )
      ).status,
    ).toBe(200);

    // The READ still works for the credential, with no store configured.
    const previousUser = currentUserId;
    currentUserId = '';
    expect(
      (await request('GET', `/inference/provider-connections/${connection}/audit`, token)).status,
    ).toBe(200);
    currentUserId = previousUser;

    const revoke = await request(
      'POST',
      `/inference/provider-connections/${connection}/revoke`,
      undefined,
      {},
    );
    expect(revoke.status).toBe(503);
    expect(revoke.body.error).toBe('kaana_credential_reconcile_required');
  });
});

describe('the response body', () => {
  it('derives operationActor from the authorized Oxy principal, never the request body', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();
    currentUserId = await insertMemberAccount(account, 'admin');
    const { privateKey } = generateKeyPairSync('ed25519');
    process.env.KAANA_BASE_URL = 'https://kaana.ai';
    process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_KEY_ID = 'route-control-test';
    process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY = privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();

    let mutation: Record<string, unknown> | undefined;
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      mutation = JSON.parse((init?.body as Buffer).toString('utf8')) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          operationId: mutation.operationId,
          action: 'create',
          status: 'applied',
          credentialHandle: `kcred_${'g'.repeat(26)}`,
          revision: 1,
        }),
        { status: 201 },
      );
    });

    const rejected = await request(
      'POST',
      `/inference/provider-connections/accounts/${account}`,
      undefined,
      {
        provider,
        environment: 'production',
        scope: 'account',
        secret: 'route-provider-key',
        operationActor: 'attacker',
      },
    );
    expect(rejected.status).toBe(400);
    expect(globalThis.fetch).not.toHaveBeenCalled();

    const accepted = await request(
      'POST',
      `/inference/provider-connections/accounts/${account}`,
      undefined,
      {
        provider,
        environment: 'production',
        scope: 'account',
        secret: 'route-provider-key',
      },
    );
    expect(accepted.status).toBe(201);
    expect(mutation?.operationActor).toBe(`user:${currentUserId}`);
    expect(mutation?.actor).toBeUndefined();
  });

  it('reconciles a lost create response with the same persisted operation id', async () => {
    const account = await insertAccount();
    const provider = await insertProvider();
    currentUserId = await insertMemberAccount(account, 'admin');
    const { privateKey } = generateKeyPairSync('ed25519');
    process.env.KAANA_BASE_URL = 'https://kaana.ai';
    process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_KEY_ID = 'route-reconcile-test';
    process.env.KAANA_CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY = privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString();

    let mutation: Record<string, unknown> | undefined;
    const outcomeRequests: Record<string, unknown>[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (!Buffer.isBuffer(init?.body)) throw new Error('expected a signed buffer body');
      const body = JSON.parse(init.body.toString('utf8')) as Record<string, unknown>;
      if (String(url).endsWith('/mutations')) {
        mutation = body;
        throw new Error('create response lost after commit');
      }
      outcomeRequests.push(body);
      if (outcomeRequests.length === 1) return new Response('', { status: 404 });
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          operationId: body.operationId,
          action: 'create',
          status: 'applied',
          credentialHandle: `kcred_${'h'.repeat(26)}`,
          revision: 1,
        }),
        { status: 200 },
      );
    });

    const created = await request(
      'POST',
      `/inference/provider-connections/accounts/${account}`,
      undefined,
      {
        provider,
        environment: 'production',
        scope: 'account',
        secret: 'route-reconcile-provider-key',
      },
    );
    expect(created.status).toBe(503);
    const connectionId = (created.body.details as Record<string, unknown>).connectionId;
    expect(typeof connectionId).toBe('string');

    const reconciled = await request(
      'POST',
      `/inference/provider-connections/${String(connectionId)}/reconcile`,
      undefined,
      {},
    );
    expect(reconciled.status).toBe(200);
    expect(reconciled.body.reconciledAction).toBe('create');
    expect(outcomeRequests).toHaveLength(2);
    expect(outcomeRequests[0]?.operationId).toBe(mutation?.operationId);
    expect(outcomeRequests[1]?.operationId).toBe(mutation?.operationId);
    expect(outcomeRequests[1]?.operationActor).toBeUndefined();
    expect(outcomeRequests[1]?.secretBase64).toBeUndefined();
  });

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

    const response = await request('GET', `/inference/provider-connections/${connection}`, token);
    const data = response.body.data as Record<string, unknown>;

    expect(Object.keys(data)).not.toContain('secret');
    expect(Object.keys(data)).not.toContain('apiKey');
    expect(Object.keys(data)).not.toContain('token');
    expect(String(data.credentialHandle)).toMatch(/^kcred_[a-z2-7]{26}$/);
    expect(data.credentialRevision).toBe(1);
    expect(data.custodyState).toBe('ready');
    expect(String(data.keyPrefix).length).toBeLessThanOrEqual(12);
    expect(data.upstreamBillsCustomerDirectly).toBe(true);
  });
});
