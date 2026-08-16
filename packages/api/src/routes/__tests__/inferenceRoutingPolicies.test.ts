/**
 * `/inference/routing-policies` against a REAL Postgres (issue #972, §16).
 *
 * The service test (`services/__tests__/inferenceRoutingPolicy.service.test.ts`)
 * covers what a policy IS — validation, append-only versioning, inheritance,
 * route-switch authorisation. None of it goes through the router, so until this
 * file existed the module's 597 lines of AUTHORIZATION had no coverage at all:
 * the two-principal dispatch, the scope gate, the account-graph gate, and the
 * one check the module's own header calls the reason a service token is not a
 * way around the account graph.
 *
 * ## What is asserted, and why each claim needs its control
 *
 * Every refusal here is a 404 or a 403 — and both are answers a BROKEN route
 * would also give. A 404 is what an unmounted path, a mistyped id, a policy that
 * was never created and a genuine cross-tenant refusal all produce; a 403 is
 * what an over-strict gate produces for everybody. So every negative in this
 * file is paired, IN THE SAME TEST, with a positive control that differs in
 * exactly one variable:
 *
 *  - **cross-tenant reads** name a policy that a DIFFERENT caller then reads
 *    successfully at the identical URL, so the 404 cannot be "there is nothing
 *    there";
 *  - **scope refusals** re-issue the same token with the scope added and assert
 *    the call now succeeds, so the 403 cannot be "this route always refuses";
 *  - **permission refusals** repeat the request as a member whose role confers
 *    the permission, so the 403 cannot be "the body was rejected".
 *
 * Refusals are asserted on the CODE and the MESSAGE, never on the status alone.
 * `NotFoundError` from this router says "No routing policy is available for that
 * application"; Express's own unmatched-path 404 says nothing and carries no
 * JSON body at all. Asserting only `status === 404` cannot tell those apart, and
 * the difference is the whole test.
 *
 * Everything is real except caller identity (`authMiddleware`, which this router
 * only reaches on the non-service lane) and the logger. Every assertion is
 * scoped to rows this file created.
 */

import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';

// `jest.setup.cjs` stubs `jsonwebtoken` globally (sign → a fixed string). The
// service-token claims ARE the gate for one of this router's two lanes, so the
// real implementation has to be restored before anything imports it.
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
import jwt from 'jsonwebtoken';

process.env.ACCESS_TOKEN_SECRET = 'test-access-token-secret';

/**
 * The user lane's identity, controlled per test.
 *
 * An EMPTY `currentUserId` leaves `req.user` unset and calls `next()` — which is
 * what a real `authMiddleware` failure looks like from this router's point of
 * view, and the only way to reach `principalOf`'s own 401. A mock that always
 * authenticated would make that branch untestable.
 */
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string } },
    _res: unknown,
    next: () => void
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
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { accountMembers } from '../../db/schema/accountMembers';
import { applications } from '../../db/schema/applications';
import { inferenceRoutingPolicyVersions } from '../../db/schema/inferenceRoutingPolicyVersions';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import routingPolicyRouter from '../inferenceRoutingPolicies';
import type { AccountRole } from '../../utils/accountRoles';

let server: http.Server;
let currentUserId = '';

const MOUNT = '/inference/routing-policies';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
  raw: string;
}

function request(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  options: { token?: string; body?: unknown; delegatedUserId?: string } = {}
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
          authorization: `Bearer ${options.token ?? 'user-session-token'}`,
          ...(options.delegatedUserId === undefined
            ? {}
            : { 'x-oxy-user-id': options.delegatedUserId }),
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
          let body: Record<string, unknown> = {};
          try {
            body = raw.length > 0 ? JSON.parse(raw) : {};
          } catch {
            body = {};
          }
          resolve({ status: res.statusCode ?? 0, body, raw });
        });
      }
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function tag(): string {
  return crypto.randomBytes(6).toString('hex');
}

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

async function seedAccount(kind: 'personal' | 'organization' = 'personal'): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `rpr-${tag()}`, kind })
    .returning({ id: users.id });
  return row.id;
}

async function seedMember(
  accountId: string,
  memberUserId: string,
  role: AccountRole
): Promise<void> {
  await getDb()
    .insert(accountMembers)
    .values({ accountId, memberUserId, role, inherit: true, status: 'active' });
}

async function seedApp(ownerAccountId: string): Promise<string> {
  const [row] = await getDb()
    .insert(applications)
    .values({ name: `Routing ${tag()}`, ownerAccountId, createdByUserId: ownerAccountId })
    .returning({ id: applications.id });
  return row.id;
}

/**
 * The seven inference scopes this router reads, plus whichever the caller wants.
 *
 * Minted with the REAL `jsonwebtoken` against the same secret `verifyServiceToken`
 * reads, so the token this file presents is verified by the router's own
 * verifier and not by a stub of it.
 */
function serviceToken(input: {
  appId: string;
  ownerAccountId: string;
  scopes: readonly string[];
}): string {
  return jwt.sign(
    {
      type: 'service',
      appId: input.appId,
      appName: 'Routing Fixture App',
      credentialId: `cred-${tag()}`,
      ownerAccountId: input.ownerAccountId,
      environment: 'production',
      scopes: [...input.scopes],
    },
    process.env.ACCESS_TOKEN_SECRET as string,
    { expiresIn: '1h' }
  );
}

const READ_SCOPE = 'inference:routing:read';
const WRITE_SCOPE = 'inference:routing:write';

/** The least opinionated policy body that is still valid. */
function controls(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerAllowlist: [],
    providerDenylist: [],
    allowedRegions: [],
    deniedRegions: [],
    requireZeroDataRetention: false,
    prohibitTrainingOnCustomerData: false,
    maxPricePerUnit: [],
    optimiseFor: 'balanced',
    oxyHostedOnly: false,
    allowedLicenseIds: [],
    requireCommercialUseRights: false,
    fallback: { disabled: false, sameModelDeployment: true, authorizedCrossModel: [] },
    byokPreference: 'disabled',
    dedicatedCapacity: 'disabled',
    ...overrides,
  };
}

interface Tenant {
  readonly accountId: string;
  readonly ownerUserId: string;
  readonly applicationId: string;
}

/** An organization account with an owner member and one application. */
async function seedTenant(): Promise<Tenant> {
  const accountId = await seedAccount('organization');
  const ownerUserId = await seedAccount();
  await seedMember(accountId, ownerUserId, 'owner');
  const applicationId = await seedApp(accountId);
  return { accountId, ownerUserId, applicationId };
}

/** Create the application-scoped policy as the tenant's owner, and return its id. */
async function createApplicationPolicy(tenant: Tenant): Promise<string> {
  currentUserId = tenant.ownerUserId;
  const created = await request('POST', `${MOUNT}/applications/${tenant.applicationId}`, {
    body: controls(),
  });
  expect(created.status).toBe(201);
  return (created.body.data as { routingPolicyId: string }).routingPolicyId;
}

/** Create the account-scoped policy as the tenant's owner, and return its id. */
async function createAccountPolicy(tenant: Tenant): Promise<string> {
  currentUserId = tenant.ownerUserId;
  const created = await request('POST', `${MOUNT}/accounts/${tenant.accountId}`, {
    body: controls(),
  });
  expect(created.status).toBe(201);
  return (created.body.data as { routingPolicyId: string }).routingPolicyId;
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use(MOUNT, routingPolicyRouter);
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

beforeEach(() => {
  currentUserId = '';
});

/* -------------------------------------------------------------------------- */
/*  1. Two principals, dispatched — and neither of them optional              */
/* -------------------------------------------------------------------------- */

describe('the two lanes are dispatched, and neither is optional', () => {
  it('refuses a bearer that resolves to no principal at all, with a positive control', async () => {
    const tenant = await seedTenant();
    await createApplicationPolicy(tenant);

    // No service token, and `authMiddleware` establishes no user.
    currentUserId = '';
    const refused = await request('GET', `${MOUNT}/applications/${tenant.applicationId}`);
    expect(refused.status).toBe(401);
    expect(refused.body).toMatchObject({
      error: 'UNAUTHORIZED',
      message: 'Authentication is required for this operation',
    });

    // The control: the identical URL, differing only in that a principal exists.
    currentUserId = tenant.ownerUserId;
    const allowed = await request('GET', `${MOUNT}/applications/${tenant.applicationId}`);
    expect(allowed.status).toBe(200);
  });

  it('takes the SERVICE lane for a verifiable service token, not the user lane', async () => {
    const tenant = await seedTenant();
    await createApplicationPolicy(tenant);
    const stranger = await seedAccount();

    // The user lane would answer 404 for this identity: it is a member of
    // nothing. If the dispatch fell through to `authMiddleware`, that is the
    // answer this request would get.
    currentUserId = stranger;
    const asStranger = await request('GET', `${MOUNT}/applications/${tenant.applicationId}`);
    expect(asStranger.status).toBe(404);

    // Same identity on the user lane, but now carrying the application's own
    // service token — which is authorised through its scopes, not the graph.
    const served = await request('GET', `${MOUNT}/applications/${tenant.applicationId}`, {
      token: serviceToken({
        appId: tenant.applicationId,
        ownerAccountId: tenant.accountId,
        scopes: [READ_SCOPE],
      }),
    });
    expect(served.status).toBe(200);
  });

  it('answers an UNVERIFIABLE bearer through the user lane rather than the service one', async () => {
    const tenant = await seedTenant();
    await createApplicationPolicy(tenant);

    // A token signed with the wrong secret is not a service principal. It must
    // fall through to `authMiddleware`, which here establishes the owner — so a
    // 200 proves the fall-through happened, and a 401/403 would prove it did not.
    const forged = jwt.sign(
      {
        type: 'service',
        appId: tenant.applicationId,
        appName: 'Forged',
        credentialId: 'cred-forged',
        ownerAccountId: tenant.accountId,
        environment: 'production',
        scopes: [READ_SCOPE, WRITE_SCOPE],
      },
      'not-the-access-token-secret',
      { expiresIn: '1h' }
    );

    currentUserId = tenant.ownerUserId;
    const throughUserLane = await request(
      'GET',
      `${MOUNT}/applications/${tenant.applicationId}`,
      { token: forged }
    );
    expect(throughUserLane.status).toBe(200);

    // And with no user behind it, the forged token authorises nothing — the
    // control proving the 200 above came from the user, not from the token.
    currentUserId = '';
    const alone = await request('GET', `${MOUNT}/applications/${tenant.applicationId}`, {
      token: forged,
    });
    expect(alone.status).toBe(401);
  });
});

/* -------------------------------------------------------------------------- */
/*  2. A service token reaches only its OWN application                       */
/* -------------------------------------------------------------------------- */

describe('a service token reaches only its own application', () => {
  it('refuses another tenant’s application, which its own owner reads at the same URL', async () => {
    const mine = await seedTenant();
    const theirs = await seedTenant();
    await createApplicationPolicy(mine);
    await createApplicationPolicy(theirs);

    const token = serviceToken({
      appId: mine.applicationId,
      ownerAccountId: mine.accountId,
      scopes: [READ_SCOPE, WRITE_SCOPE],
    });

    // NEGATIVE: my credential, their application.
    currentUserId = '';
    const refused = await request('GET', `${MOUNT}/applications/${theirs.applicationId}`, {
      token,
    });
    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({
      error: 'NOT_FOUND',
      message: 'No routing policy is available for that application',
    });

    // CONTROL A — the same credential on its OWN application succeeds, so the
    // 404 is not "this token authorises nothing".
    const own = await request('GET', `${MOUNT}/applications/${mine.applicationId}`, { token });
    expect(own.status).toBe(200);

    // CONTROL B — the target application's OWN owner reads it at the identical
    // URL, so the 404 is not "there is no policy at that id".
    currentUserId = theirs.ownerUserId;
    const byTheirOwner = await request('GET', `${MOUNT}/applications/${theirs.applicationId}`);
    expect(byTheirOwner.status).toBe(200);
    expect(byTheirOwner.body.data).not.toBeNull();
  });

  it('cannot WRITE another tenant’s application policy either', async () => {
    const mine = await seedTenant();
    const theirs = await seedTenant();

    const token = serviceToken({
      appId: mine.applicationId,
      ownerAccountId: mine.accountId,
      scopes: [READ_SCOPE, WRITE_SCOPE],
    });

    currentUserId = '';
    const refused = await request('POST', `${MOUNT}/applications/${theirs.applicationId}`, {
      token,
      body: controls(),
    });
    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({
      message: 'No routing policy is available for that application',
    });

    // The control: the identical body on its OWN application is accepted, so
    // the refusal is about WHOSE application it is and not about the body.
    const own = await request('POST', `${MOUNT}/applications/${mine.applicationId}`, {
      token,
      body: controls(),
    });
    expect(own.status).toBe(201);

    // And nothing was written for the other tenant.
    const rows = await getDb()
      .select({ id: inferenceRoutingPolicyVersions.id })
      .from(inferenceRoutingPolicyVersions)
      .where(eq(inferenceRoutingPolicyVersions.createdByUserId, mine.accountId));
    expect(rows).toHaveLength(1);
  });

  it('refuses another account’s policy on the ACCOUNT lane, with the same shape of control', async () => {
    const mine = await seedTenant();
    const theirs = await seedTenant();
    await createAccountPolicy(theirs);

    const token = serviceToken({
      appId: mine.applicationId,
      ownerAccountId: mine.accountId,
      scopes: [READ_SCOPE],
    });

    currentUserId = '';
    const refused = await request('GET', `${MOUNT}/accounts/${theirs.accountId}`, { token });
    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({
      error: 'NOT_FOUND',
      message: 'No routing policy is available for that account',
    });

    // CONTROL A — its own owner account resolves, so the token works.
    const own = await request('GET', `${MOUNT}/accounts/${mine.accountId}`, { token });
    expect(own.status).toBe(200);

    // CONTROL B — the other account's owner reads a real, non-empty list at the
    // identical URL.
    currentUserId = theirs.ownerUserId;
    const byTheirOwner = await request('GET', `${MOUNT}/accounts/${theirs.accountId}`);
    expect(byTheirOwner.status).toBe(200);
    expect(byTheirOwner.body.count).toBe(1);
  });

  it('cannot reach a policy it does not own through the /:policyId lane', async () => {
    const mine = await seedTenant();
    const theirs = await seedTenant();
    const theirPolicyId = await createApplicationPolicy(theirs);

    const token = serviceToken({
      appId: mine.applicationId,
      ownerAccountId: mine.accountId,
      scopes: [READ_SCOPE, WRITE_SCOPE],
    });

    currentUserId = '';
    for (const path of [
      `${MOUNT}/${theirPolicyId}`,
      `${MOUNT}/${theirPolicyId}/versions`,
      `${MOUNT}/${theirPolicyId}/versions/1`,
    ]) {
      const refused = await request('GET', path, { token });
      expect(refused.status).toBe(404);
      expect(refused.body).toMatchObject({
        message: 'No routing policy is available for that application',
      });
    }

    const archive = await request('POST', `${MOUNT}/${theirPolicyId}/archive`, {
      token,
      body: {},
    });
    expect(archive.status).toBe(404);

    // CONTROL — every one of those paths answers 200 for the policy's own owner,
    // so none of the 404s above is a path that does not exist. Archive is left
    // out of the control deliberately: it MUTATES, and proving it works would
    // change the fixture the reads were just asserted against.
    currentUserId = theirs.ownerUserId;
    for (const path of [
      `${MOUNT}/${theirPolicyId}`,
      `${MOUNT}/${theirPolicyId}/versions`,
      `${MOUNT}/${theirPolicyId}/versions/1`,
    ]) {
      const allowed = await request('GET', path);
      expect(allowed.status).toBe(200);
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  3. The scope gate is separate from the ownership gate                     */
/* -------------------------------------------------------------------------- */

describe('a service token’s scopes gate the verb, independently of ownership', () => {
  it('refuses a WRITE to a token holding only the read scope, and accepts it once written is added', async () => {
    const tenant = await seedTenant();

    const readOnly = serviceToken({
      appId: tenant.applicationId,
      ownerAccountId: tenant.accountId,
      scopes: [READ_SCOPE],
    });

    currentUserId = '';
    const refused = await request('POST', `${MOUNT}/applications/${tenant.applicationId}`, {
      token: readOnly,
      body: controls(),
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      error: 'FORBIDDEN',
      message: `This credential does not carry the ${WRITE_SCOPE} scope`,
    });

    // The read the same token IS scoped for still works — so the 403 is about
    // the verb, not about the credential being rejected wholesale.
    const read = await request('GET', `${MOUNT}/applications/${tenant.applicationId}`, {
      token: readOnly,
    });
    expect(read.status).toBe(200);

    // CONTROL: identical request, identical body, one scope added.
    const withWrite = serviceToken({
      appId: tenant.applicationId,
      ownerAccountId: tenant.accountId,
      scopes: [READ_SCOPE, WRITE_SCOPE],
    });
    const accepted = await request('POST', `${MOUNT}/applications/${tenant.applicationId}`, {
      token: withWrite,
      body: controls(),
    });
    expect(accepted.status).toBe(201);
  });

  it('refuses a READ to a token carrying no inference routing scope at all', async () => {
    const tenant = await seedTenant();
    await createApplicationPolicy(tenant);

    // A real, verifiable service token — with scopes from a different family.
    const wrongFamily = serviceToken({
      appId: tenant.applicationId,
      ownerAccountId: tenant.accountId,
      scopes: ['inference:invoke', 'inference:usage:read'],
    });

    currentUserId = '';
    const refused = await request('GET', `${MOUNT}/applications/${tenant.applicationId}`, {
      token: wrongFamily,
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      message: `This credential does not carry the ${READ_SCOPE} scope`,
    });

    const withScope = serviceToken({
      appId: tenant.applicationId,
      ownerAccountId: tenant.accountId,
      scopes: ['inference:invoke', 'inference:usage:read', READ_SCOPE],
    });
    const allowed = await request('GET', `${MOUNT}/applications/${tenant.applicationId}`, {
      token: withScope,
    });
    expect(allowed.status).toBe(200);
  });

  it('checks the CALLER’s scope before the target’s ownership, so a refusal names the caller’s own gap', async () => {
    const mine = await seedTenant();
    const theirs = await seedTenant();
    await createApplicationPolicy(theirs);

    // Unscoped credential pointed at somebody else's application. Two refusals
    // are available; the module answers with the one about the caller, which
    // tells them nothing about whether the target exists.
    const unscoped = serviceToken({
      appId: mine.applicationId,
      ownerAccountId: mine.accountId,
      scopes: [],
    });

    currentUserId = '';
    const refused = await request('GET', `${MOUNT}/applications/${theirs.applicationId}`, {
      token: unscoped,
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      message: `This credential does not carry the ${READ_SCOPE} scope`,
    });

    // The same request pointed at a NONEXISTENT application answers identically,
    // which is what makes the ordering safe: holding no scope, a caller cannot
    // use this route to learn whether an application id is real.
    const nonexistent = await request('GET', `${MOUNT}/applications/does-not-exist`, {
      token: unscoped,
    });
    expect(nonexistent.status).toBe(403);
    expect(nonexistent.body).toEqual(refused.body);
  });
});

/* -------------------------------------------------------------------------- */
/*  4. The user lane is the account graph, and nothing else                   */
/* -------------------------------------------------------------------------- */

describe('a user bearer is authorised through the account graph', () => {
  it('lets a viewer READ an application policy and refuses the WRITE, which an editor makes', async () => {
    const tenant = await seedTenant();
    await createApplicationPolicy(tenant);

    const viewer = await seedAccount();
    await seedMember(tenant.accountId, viewer, 'viewer');

    currentUserId = viewer;
    const read = await request('GET', `${MOUNT}/applications/${tenant.applicationId}`);
    expect(read.status).toBe(200);

    const refused = await request('POST', `${MOUNT}/${await policyIdOf(tenant)}/versions`, {
      body: controls({ optimiseFor: 'price' }),
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      error: 'FORBIDDEN',
      message: 'This action requires the app:update permission',
    });

    // CONTROL: same body, same URL, a member whose role confers `app:update`.
    const editor = await seedAccount();
    await seedMember(tenant.accountId, editor, 'editor');
    currentUserId = editor;
    const accepted = await request('POST', `${MOUNT}/${await policyIdOf(tenant)}/versions`, {
      body: controls({ optimiseFor: 'price' }),
    });
    expect(accepted.status).toBe(201);
    // A WRITE answers with the policy itself; a READ answers with the stored
    // row that wraps it. The version counter moved, so this appended.
    expect((accepted.body.data as { policyVersion: number }).policyVersion).toBe(2);
  });

  it('lets a viewer READ the account policy and refuses the WRITE, which the owner makes', async () => {
    const tenant = await seedTenant();
    const viewer = await seedAccount();
    await seedMember(tenant.accountId, viewer, 'viewer');

    currentUserId = viewer;
    const read = await request('GET', `${MOUNT}/accounts/${tenant.accountId}`);
    expect(read.status).toBe(200);

    const refused = await request('POST', `${MOUNT}/accounts/${tenant.accountId}`, {
      body: controls(),
    });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      message: 'This action requires the account:update permission',
    });

    currentUserId = tenant.ownerUserId;
    const accepted = await request('POST', `${MOUNT}/accounts/${tenant.accountId}`, {
      body: controls(),
    });
    expect(accepted.status).toBe(201);
  });

  it('answers a stranger 404, identically to an application that does not exist', async () => {
    const tenant = await seedTenant();
    await createApplicationPolicy(tenant);
    const stranger = await seedAccount();

    currentUserId = stranger;
    const refused = await request('GET', `${MOUNT}/applications/${tenant.applicationId}`);
    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({
      error: 'NOT_FOUND',
      message: 'No routing policy is available for that application',
    });

    // The id space is not an oracle: a real application the caller may not see
    // and an id that names nothing produce byte-identical answers.
    const missing = await request('GET', `${MOUNT}/applications/no-such-application`);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(refused.body);

    // CONTROL: the owner reads the real one at the identical URL.
    currentUserId = tenant.ownerUserId;
    const allowed = await request('GET', `${MOUNT}/applications/${tenant.applicationId}`);
    expect(allowed.status).toBe(200);
  });

  it('honours a per-member REVOKE of apps:update, which the same member’s role would confer', async () => {
    const tenant = await seedTenant();
    const policyId = await createApplicationPolicy(tenant);

    const editor = await seedAccount();
    await getDb().insert(accountMembers).values({
      accountId: tenant.accountId,
      memberUserId: editor,
      role: 'editor',
      inherit: true,
      status: 'active',
      permissionRevokes: ['apps:update'],
    });

    currentUserId = editor;
    const refused = await request('POST', `${MOUNT}/${policyId}/versions`, { body: controls() });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({
      message: 'This action requires the app:update permission',
    });

    // CONTROL: the read the revoke does NOT touch still works, so the 403 is
    // the revoke and not a member row that failed to resolve at all.
    const read = await request('GET', `${MOUNT}/${policyId}`);
    expect(read.status).toBe(200);

    // CONTROL: an unrevoked editor writes the identical body.
    const plainEditor = await seedAccount();
    await seedMember(tenant.accountId, plainEditor, 'editor');
    currentUserId = plainEditor;
    const accepted = await request('POST', `${MOUNT}/${policyId}/versions`, { body: controls() });
    expect(accepted.status).toBe(201);
  });
});

/** The application-scoped policy id for a tenant, read through the route. */
async function policyIdOf(tenant: Tenant): Promise<string> {
  const previous = currentUserId;
  currentUserId = tenant.ownerUserId;
  const response = await request('GET', `${MOUNT}/applications/${tenant.applicationId}`);
  currentUserId = previous;
  return (response.body.data as { routingPolicyId: string }).routingPolicyId;
}

/* -------------------------------------------------------------------------- */
/*  5. A written version is attributed to a principal, never to a header      */
/* -------------------------------------------------------------------------- */

describe('a written version is attributed to the principal that authored it', () => {
  it('attributes a service token’s write to its OWNER ACCOUNT, never to X-Oxy-User-Id', async () => {
    const tenant = await seedTenant();
    const impersonated = await seedAccount();

    currentUserId = '';
    const created = await request('POST', `${MOUNT}/applications/${tenant.applicationId}`, {
      token: serviceToken({
        appId: tenant.applicationId,
        ownerAccountId: tenant.accountId,
        scopes: [WRITE_SCOPE],
      }),
      body: controls(),
      // A delegated end user. Attribution of a POLICY EDIT is not delegable:
      // the end user Alia acted for did not author the customer's routing.
      delegatedUserId: impersonated,
    });
    expect(created.status).toBe(201);

    const policyId = (created.body.data as { routingPolicyId: string }).routingPolicyId;
    const [version] = await getDb()
      .select({ createdByUserId: inferenceRoutingPolicyVersions.createdByUserId })
      .from(inferenceRoutingPolicyVersions)
      .where(
        and(
          eq(inferenceRoutingPolicyVersions.routingPolicyId, policyId),
          eq(inferenceRoutingPolicyVersions.version, 1)
        )
      );

    expect(version.createdByUserId).toBe(tenant.accountId);
    // Stated as its own assertion: an equality that happened to hold because
    // both ids were undefined would satisfy the line above on its own.
    expect(version.createdByUserId).not.toBe(impersonated);
    expect(impersonated).not.toBe(tenant.accountId);
  });

  it('attributes a user’s write to that user', async () => {
    const tenant = await seedTenant();
    const editor = await seedAccount();
    await seedMember(tenant.accountId, editor, 'editor');

    currentUserId = editor;
    const created = await request('POST', `${MOUNT}/applications/${tenant.applicationId}`, {
      body: controls(),
    });
    expect(created.status).toBe(201);

    const policyId = (created.body.data as { routingPolicyId: string }).routingPolicyId;
    const [version] = await getDb()
      .select({ createdByUserId: inferenceRoutingPolicyVersions.createdByUserId })
      .from(inferenceRoutingPolicyVersions)
      .where(eq(inferenceRoutingPolicyVersions.routingPolicyId, policyId));

    expect(version.createdByUserId).toBe(editor);
    expect(version.createdByUserId).not.toBe(tenant.accountId);
  });
});

/* -------------------------------------------------------------------------- */
/*  6. Route ORDER, which is a bug that reads as an empty catalogue           */
/* -------------------------------------------------------------------------- */

describe('the literal path segments win over the parameterised ones', () => {
  /**
   * MEASURED, not assumed. Registering `GET /:policyId` FIRST — the collision
   * the module's ORDER MATTERS comment names — changes NOTHING: Express matches
   * on segment arity, and `/:policyId` is one segment while `/accounts/:id` is
   * two, so they can never contend. The comment's example is wrong.
   *
   * The order IS load-bearing, but between the TWO-segment routes: `POST
   * /:policyId/versions` and `POST /accounts/:accountId` have the same arity,
   * and an account id spelt `versions` is matched by both. That case is pinned
   * below, and moving the versions route up is what turns it red.
   */
  it('serves /accounts/:id as the account LIST, not as a single policy', async () => {
    const tenant = await seedTenant();
    await createAccountPolicy(tenant);

    currentUserId = tenant.ownerUserId;
    const response = await request('GET', `${MOUNT}/accounts/${tenant.accountId}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.data)).toBe(true);
    expect(response.body.count).toBe(1);
  });

  it('routes /accounts/versions to the ACCOUNT lane, not to policy “accounts” version-append', async () => {
    const tenant = await seedTenant();
    currentUserId = tenant.ownerUserId;

    // `versions` as an account id is absurd but reachable, and it is the exact
    // string that makes the two two-segment POST routes contend. The MESSAGE is
    // the discriminator: the account lane and the policy-versions lane both
    // answer 404 here and say different things.
    const response = await request('POST', `${MOUNT}/accounts/versions`, { body: controls() });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      message: 'No routing policy is available for that account',
    });
    // The answer the OTHER route would have given, stated so the assertion above
    // cannot be satisfied by the wrong handler.
    expect(response.body.message).not.toBe('No such routing policy');
  });

  it('routes /applications/versions to the APPLICATION lane for the same reason', async () => {
    const tenant = await seedTenant();
    currentUserId = tenant.ownerUserId;

    const response = await request('POST', `${MOUNT}/applications/versions`, { body: controls() });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      message: 'No routing policy is available for that application',
    });
    expect(response.body.message).not.toBe('No such routing policy');
  });

  it('serves /applications/:id as the EFFECTIVE policy, carrying its source', async () => {
    const tenant = await seedTenant();
    await createAccountPolicy(tenant);

    currentUserId = tenant.ownerUserId;
    const inherited = await request('GET', `${MOUNT}/applications/${tenant.applicationId}`);
    expect(inherited.status).toBe(200);
    expect(inherited.body.source).toBe('account');

    // The application's own policy wins from the moment it exists — the same
    // URL, a different `source`, which is the question a customer debugging a
    // route actually asks.
    await createApplicationPolicy(tenant);
    const own = await request('GET', `${MOUNT}/applications/${tenant.applicationId}`);
    expect(own.status).toBe(200);
    expect(own.body.source).toBe('application');
  });

  it('serves /applications/:id/route-switches as the switch list, gated on usage:read', async () => {
    const tenant = await seedTenant();

    currentUserId = tenant.ownerUserId;
    const owned = await request('GET', `${MOUNT}/applications/${tenant.applicationId}/route-switches`);
    expect(owned.status).toBe(200);
    expect(owned.body).toMatchObject({ data: [], count: 0 });

    // A stranger gets the same 404 the rest of the application lane gives.
    currentUserId = await seedAccount();
    const refused = await request(
      'GET',
      `${MOUNT}/applications/${tenant.applicationId}/route-switches`
    );
    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({
      message: 'No routing policy is available for that application',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  7. Retirement is archive, and there is no DELETE                          */
/* -------------------------------------------------------------------------- */

describe('a policy is retired by archiving, and there is no DELETE', () => {
  it('archives once, refuses the second attempt, and never answers a DELETE', async () => {
    const tenant = await seedTenant();
    const policyId = await createApplicationPolicy(tenant);

    currentUserId = tenant.ownerUserId;

    // No DELETE verb is registered, so Express itself answers — and it answers
    // with no JSON body, which is how this is distinguished from the router's
    // own 404s. A route that archived on DELETE would answer 200 here.
    const deleted = await request('DELETE', `${MOUNT}/${policyId}`);
    expect(deleted.status).toBe(404);
    expect(deleted.body).toEqual({});

    // CONTROL: the id is real and reachable — the DELETE 404 above was the verb.
    const archived = await request('POST', `${MOUNT}/${policyId}/archive`, { body: {} });
    expect(archived.status).toBe(200);
    expect(archived.body.data).toMatchObject({ routingPolicyId: policyId, status: 'archived' });

    const again = await request('POST', `${MOUNT}/${policyId}/archive`, { body: {} });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({
      error: 'CONFLICT',
      message: 'This routing policy is already archived',
    });
  });

  it('leaves an archived policy’s versions readable, and refuses a new one', async () => {
    const tenant = await seedTenant();
    const policyId = await createApplicationPolicy(tenant);

    currentUserId = tenant.ownerUserId;
    await request('POST', `${MOUNT}/${policyId}/archive`, { body: {} });

    // The audit trail survives: a receipt naming version 1 still resolves.
    const versions = await request('GET', `${MOUNT}/${policyId}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.body.count).toBe(1);

    const edit = await request('POST', `${MOUNT}/${policyId}/versions`, { body: controls() });
    expect(edit.status).toBe(409);
    expect(edit.body).toMatchObject({
      message: 'This routing policy is archived and can no longer be edited',
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  8. The service's own refusals reach the wire as the right status          */
/* -------------------------------------------------------------------------- */

describe('a contradictory policy is a 400 carrying the contract’s own issues', () => {
  it('reports WHICH control contradicts which, rather than a bare rejection', async () => {
    const tenant = await seedTenant();

    currentUserId = tenant.ownerUserId;
    const refused = await request('POST', `${MOUNT}/applications/${tenant.applicationId}`, {
      body: controls({
        fallback: { disabled: true, sameModelDeployment: true, authorizedCrossModel: [] },
      }),
    });

    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      error: 'BAD_REQUEST',
      message: 'This routing policy is contradictory',
    });
    const details = refused.body.details as { issues: { path: string }[] };
    expect(details.issues.map((issue) => issue.path)).toContain('fallback.sameModelDeployment');

    // CONTROL: the same request with that one contradiction removed is accepted,
    // so the 400 is the refinement and not the whitelist rejecting the shape.
    const accepted = await request('POST', `${MOUNT}/applications/${tenant.applicationId}`, {
      body: controls({
        fallback: { disabled: true, sameModelDeployment: false, authorizedCrossModel: [] },
      }),
    });
    expect(accepted.status).toBe(201);
  });

  it('refuses a body that tries to set the server’s own identity fields', async () => {
    const tenant = await seedTenant();

    currentUserId = tenant.ownerUserId;
    // `.strict()` on the whitelist: a caller cannot rewind its own version
    // counter or re-point a policy at another account by naming those fields.
    const refused = await request('POST', `${MOUNT}/applications/${tenant.applicationId}`, {
      body: controls({
        routingPolicyId: 'chosen-by-the-caller',
        policyVersion: 99,
        scope: { kind: 'account', accountId: 'somebody-else' },
      }),
    });
    expect(refused.status).toBe(400);

    // CONTROL: the identical body without those three fields is accepted.
    const accepted = await request('POST', `${MOUNT}/applications/${tenant.applicationId}`, {
      body: controls(),
    });
    expect(accepted.status).toBe(201);
    const written = accepted.body.data as { routingPolicyId: string; policyVersion: number };
    expect(written.policyVersion).toBe(1);
    expect(written.routingPolicyId).not.toBe('chosen-by-the-caller');
  });

  it('refuses a SECOND active policy on one scope', async () => {
    const tenant = await seedTenant();
    await createApplicationPolicy(tenant);

    currentUserId = tenant.ownerUserId;
    const refused = await request('POST', `${MOUNT}/applications/${tenant.applicationId}`, {
      body: controls(),
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      error: 'CONFLICT',
      message:
        'This scope already has an active routing policy; edit it or archive it first',
    });
  });
});
