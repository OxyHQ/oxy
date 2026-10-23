/**
 * ADR 0042 — an agent acts for a present NON-OWNER requester, on that
 * requester's own account, under its owner's published ceiling. The ceiling is
 * judged by the same tool, limit and autonomy rules as a grant, never reaches
 * anyone else's data, and never makes anything ask for approval: "Ver" reads,
 * "Ver y actuar" acts, and a run the person starts may continue on its own.
 */
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import type { AppCapabilityCatalog, AutonomyLevel, CatalogTool } from '@oxy.so/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import {
  accountCapabilityPolicies,
  appCapabilityCatalogRegistrations,
  capabilityExecutionAuthorizations,
} from '../../db/schema/agency';
import { users } from '../../db/schema/users';
import { accountMembers } from '../../db/schema/accountMembers';
import { sessions } from '../../db/schema/sessions';
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');
  return {
    ...actual,
    // The person behind the bearer, without minting a session: these tests are
    // about what that person may authorize, not about how they signed in.
    authMiddleware: (
      req: {
        headers: Record<string, string | undefined>;
        user?: { _id: string };
        sessionId?: string;
      },
      res: { status: (code: number) => { json: (body: unknown) => void } },
      next: () => void,
    ) => {
      const userId = req.headers['x-test-user'];
      if (!userId) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      req.user = { _id: userId };
      req.sessionId = req.headers['x-test-session'];
      next();
    },
  };
});
import { signServiceTokenEd25519 } from '../../config/serviceTokenSigning';
import capabilitiesRouter from '../../routes/capabilities';
import {
  evaluateCapabilityAuthority,
  reauthorizeCapabilityTicket,
} from '../capabilityAuthority.service';

const keyPair = generateKeyPairSync('ed25519');
const originalKeyId = process.env.CAPABILITY_TICKET_SIGNING_KEY_ID;
const originalPrivateKey = process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY;

beforeAll(async () => {
  process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = 'agent-ceiling-test';
  process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY = keyPair.privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  await connectPostgres();
});

afterAll(async () => {
  if (originalKeyId === undefined)
    Reflect.deleteProperty(process.env, 'CAPABILITY_TICKET_SIGNING_KEY_ID');
  else process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = originalKeyId;
  if (originalPrivateKey === undefined)
    Reflect.deleteProperty(process.env, 'CAPABILITY_TICKET_SIGNING_PRIVATE_KEY');
  else process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY = originalPrivateKey;
  await closePostgres();
});

const ACCOUNT_ROOT = 'homiio_account';

const TOOLS: CatalogTool[] = [
  {
    name: 'searchListings',
    version: '1.0.0',
    description: 'Search listings.',
    inputSchema: { type: 'object', additionalProperties: false },
    capabilityPackage: 'read',
    requiredCapabilities: ['listings.read'],
    resourceTypes: [ACCOUNT_ROOT],
    effect: 'read',
    idempotency: 'none',
    rollback: 'none',
    exposure: ['internal', 'mcp'],
    limitKeys: [],
    invocation: { method: 'GET', path: '/listings' },
  },
  {
    name: 'saveHome',
    version: '1.0.0',
    description: 'Save a home.',
    inputSchema: { type: 'object', additionalProperties: false },
    capabilityPackage: 'create',
    requiredCapabilities: ['saved.write'],
    resourceTypes: [ACCOUNT_ROOT],
    effect: 'write',
    idempotency: 'supported',
    rollback: 'supported',
    exposure: ['internal', 'mcp'],
    limitKeys: [],
    invocation: { method: 'POST', path: '/saved' },
  },
  {
    name: 'payRent',
    version: '1.0.0',
    description: 'Pay rent.',
    inputSchema: {
      type: 'object',
      properties: { amount: { type: 'number' } },
      additionalProperties: false,
    },
    capabilityPackage: 'finance',
    requiredCapabilities: ['payments.send'],
    resourceTypes: [ACCOUNT_ROOT],
    effect: 'financial',
    idempotency: 'required',
    rollback: 'none',
    exposure: ['internal'],
    limitKeys: [{ key: 'amount', kind: 'maximum_number' }],
    invocation: { method: 'POST', path: '/payments' },
  },
];

/**
 * The agent's owner (Homiio's project), Sindi's bot, a PERSON who uses Sindi
 * and owns nothing of it, a stranger, and Alia's coordinator.
 */
async function world() {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const [person] = await getDb()
    .insert(users)
    .values({ color: 'teal' })
    .returning({ id: users.id });
  const [stranger] = await getDb()
    .insert(users)
    .values({ color: 'teal' })
    .returning({ id: users.id });
  const [agent] = await getDb()
    .insert(users)
    .values({
      color: 'teal',
      kind: 'bot',
      username: `ceiling-agent-${randomUUID()}`,
      parentAccountId: owner.id,
    })
    .returning({ id: users.id });
  await getDb()
    .insert(accountMembers)
    .values([{ accountId: agent.id, memberUserId: owner.id, role: 'owner', status: 'active' }]);
  const appSlug = `homiio-${randomUUID()}`;
  const scopes = ['capability-tickets:issue', 'capabilities:read'];
  const [application] = await getDb()
    .insert(applications)
    .values({
      name: `Ceiling coordinator ${randomUUID()}`,
      ownerAccountId: owner.id,
      status: 'active',
      isInternal: true,
      scopes,
      capabilities: ['agency:coordinate'],
    })
    .returning({ id: applications.id });
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: application.id,
      name: 'Ceiling credential',
      publicKey: `oxy_dk_${randomUUID()}`,
      secretHash: 'test-only-secret-hash',
      type: 'service',
      environment: 'production',
      scopes,
      status: 'active',
    })
    .returning({ id: applicationCredentials.id });
  const catalog: AppCapabilityCatalog = {
    schemaVersion: '1',
    appId: appSlug,
    version: '1.0.0',
    audience: `${appSlug}-api`,
    internalBaseUrl: 'https://api.homiio.example',
    accountResourceType: ACCOUNT_ROOT,
    tools: TOOLS,
    events: [],
  };
  await getDb()
    .insert(appCapabilityCatalogRegistrations)
    .values({
      appSlug,
      version: catalog.version,
      audience: catalog.audience,
      catalog,
      digest: '0'.repeat(64),
      signature: 'test-signature',
      registeredByApplicationId: application.id,
      registeredByCredentialId: credential.id,
      deployedAt: new Date(),
      active: true,
    });

  const server = express();
  server.use(express.json());
  server.use('/capabilities', capabilitiesRouter);
  const serviceToken = signServiceTokenEd25519({
    type: 'service',
    appId: application.id,
    appName: 'Alia fixture',
    credentialId: credential.id,
    ownerAccountId: owner.id,
    environment: 'production',
    tier: 'internal',
    scopes,
    iss: 'oxy-auth',
    aud: 'oxy-api',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
  });
  // A live, ordinary (keyless) session per human: execution authorizations are
  // approved by a session the person holds right now.
  const sessionOf = new Map<string, string>();
  for (const userId of [owner.id, person.id, stranger.id]) {
    const sessionId = randomUUID();
    await getDb()
      .insert(sessions)
      .values({
        sessionId,
        userId,
        deviceId: randomUUID(),
        deviceType: 'web',
        platform: 'web',
        accessToken: `fixture-${sessionId}`,
        refreshToken: `fixture-refresh-${sessionId}`,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      });
    sessionOf.set(userId, sessionId);
  }
  const authed = (userId: string, test: request.Test) =>
    test.set('x-test-user', userId).set('x-test-session', sessionOf.get(userId) ?? '');
  return {
    ownerId: owner.id,
    personId: person.id,
    strangerId: stranger.id,
    agentId: agent.id,
    appSlug,
    coordinator: { applicationId: application.id, credentialId: credential.id },
    as: (userId: string) => ({
      put: (path: string, body: unknown) =>
        authed(userId, request(server).put(path)).send(body as object),
      post: (path: string, body: unknown) =>
        authed(userId, request(server).post(path)).send(body as object),
      get: (path: string) => authed(userId, request(server).get(path)),
      delete: (path: string) => authed(userId, request(server).delete(path)),
    }),
    service: (path: string, body: unknown) =>
      request(server)
        .post(path)
        .set('Authorization', `Bearer ${serviceToken}`)
        .send(body as object),
  };
}

type World = Awaited<ReturnType<typeof world>>;

const ceilingPath = (w: World) => `/capabilities/agent-ceilings/${w.agentId}/${w.appSlug}`;

async function publish(w: World, body: Record<string, unknown>) {
  const response = await w.as(w.ownerId).put(ceilingPath(w), body);
  if (response.status !== 201 && response.status !== 200)
    throw new Error(`publish failed: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body.ceiling as { id: string; version: number };
}

const VER_Y_ACTUAR = { capabilityPackages: ['read', 'create'], maximumAutonomy: 'autonomous' };
const VER = { capabilityPackages: ['read'], maximumAutonomy: 'read_only' };

async function authorizeAs(
  w: World,
  requesterId: string,
  input: {
    ceilingId: string;
    tool: string;
    kind?: 'direct_request' | 'automation';
    maximumAutonomy?: AutonomyLevel;
    effectiveAccountId?: string;
    ownerAccountId?: string;
    limits?: Array<{ tool: string; key: string; value: number }>;
  },
) {
  const kind = input.kind ?? 'direct_request';
  const effectiveAccountId = input.effectiveAccountId ?? requesterId;
  return w.as(requesterId).post('/capabilities/execution-authorizations', {
    kind,
    ownerAccountId: input.ownerAccountId ?? requesterId,
    coordinatorApplicationId: w.coordinator.applicationId,
    coordinatorCredentialId: w.coordinator.credentialId,
    actor: { type: 'agent', accountId: w.agentId },
    resource: {
      appId: w.appSlug,
      effectiveAccountId,
      resourceType: ACCOUNT_ROOT,
      resourceId: effectiveAccountId,
    },
    tool: input.tool,
    ...(kind === 'direct_request'
      ? { runId: randomUUID() }
      : { automationId: `run:${randomUUID()}` }),
    maximumAutonomy:
      input.maximumAutonomy ?? (kind === 'automation' ? 'autonomous' : 'execute_on_request'),
    limits: input.limits ?? [],
    ceilingId: input.ceilingId,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
}

function evaluate(w: World, executionAuthorizationId: string, runId?: string) {
  return evaluateCapabilityAuthority(
    { executionAuthorizationId, coordinator: w.coordinator, ...(runId ? { runId } : {}) },
    { issueTicket: true },
  );
}

describe('publishing a ceiling', () => {
  it('is for whoever operates the bot, replaces immutably and is validated like a grant', async () => {
    const w = await world();
    const first = await w.as(w.ownerId).put(ceilingPath(w), VER);
    expect(first.status).toBe(201);
    expect(first.body.ceiling).toMatchObject({
      agentAccountId: w.agentId,
      appId: w.appSlug,
      maximumAutonomy: 'read_only',
      version: 1,
      revokedAt: null,
    });
    const second = await w.as(w.ownerId).put(ceilingPath(w), VER_Y_ACTUAR);
    expect(second.status).toBe(200);
    expect(second.body.ceiling).toMatchObject({ version: 2 });
    expect(second.body.ceiling.id).not.toBe(first.body.ceiling.id);

    expect((await w.as(w.personId).put(ceilingPath(w), VER)).status).toBe(403);
    expect(
      (await w.as(w.ownerId).put(`/capabilities/agent-ceilings/${w.personId}/${w.appSlug}`, VER))
        .status,
    ).toBe(403);
    expect(
      (await w.as(w.ownerId).put(ceilingPath(w), { ...VER, maximumAutonomy: 'execute_on_request' }))
        .status,
    ).toBe(400);
    expect(
      (await w.as(w.ownerId).put(ceilingPath(w), { ...VER, capabilityPackages: ['administer'] }))
        .body.error,
    ).toBe('capability_package_not_available_for_resource');
    // Money is reachable only when named explicitly and bounded when autonomous.
    expect(
      (
        await w.as(w.ownerId).put(ceilingPath(w), {
          capabilityPackages: ['read'],
          capabilities: ['payments.send'],
          maximumAutonomy: 'autonomous',
        })
      ).body.error,
    ).toBe('autonomous_sensitive_tool_limit_required');

    const listed = await w.as(w.ownerId).get(`/capabilities/agent-ceilings/${w.agentId}`);
    expect(listed.body.ceilings).toHaveLength(1);
    expect((await w.as(w.personId).get(`/capabilities/agent-ceilings/${w.agentId}`)).status).toBe(
      403,
    );
  });
});

describe('a person using somebody else’s agent', () => {
  it('lets "Ver y actuar" read and act on the person’s own account, with no approval step', async () => {
    const w = await world();
    const ceiling = await publish(w, VER_Y_ACTUAR);
    for (const tool of ['searchListings', 'saveHome']) {
      const created = await authorizeAs(w, w.personId, { ceilingId: ceiling.id, tool });
      expect(created.status).toBe(201);
      const result = await evaluate(w, created.body.authorization.id);
      expect(result.decision).toMatchObject({ allowed: true, ceilingId: ceiling.id });
      expect(result.decision.grantId).toBeUndefined();
      expect(result.claims).toMatchObject({
        ceilingId: ceiling.id,
        requesterAccountId: w.personId,
        ownerAccountId: w.personId,
        actor: { type: 'agent', accountId: w.agentId },
        resource: { effectiveAccountId: w.personId, resourceId: w.personId },
        autonomy: 'execute_on_request',
      });
      if (!result.claims) throw new Error('Expected claims');
      await expect(reauthorizeCapabilityTicket(result.claims)).resolves.toMatchObject({
        allowed: true,
      });
    }
  });

  it('lets "Ver" read but not act', async () => {
    const w = await world();
    const ceiling = await publish(w, VER);
    // Alia asks for the autonomy the requester map published: read_only under "Ver".
    const read = await authorizeAs(w, w.personId, {
      ceilingId: ceiling.id,
      tool: 'searchListings',
      maximumAutonomy: 'read_only',
    });
    expect((await evaluate(w, read.body.authorization.id)).decision.allowed).toBe(true);
    const overreach = await authorizeAs(w, w.personId, {
      ceilingId: ceiling.id,
      tool: 'searchListings',
    });
    expect((await evaluate(w, overreach.body.authorization.id)).decision).toEqual({
      allowed: false,
      reason: 'requested_autonomy_exceeds_effective_policy',
    });
    const write = await authorizeAs(w, w.personId, { ceilingId: ceiling.id, tool: 'saveHome' });
    expect((await evaluate(w, write.body.authorization.id)).decision).toEqual({
      allowed: false,
      reason: 'ceiling_does_not_allow_tool',
    });
  });

  it('lets a run the person starts continue on its own, within the ceiling', async () => {
    const w = await world();
    const ceiling = await publish(w, VER_Y_ACTUAR);
    const created = await authorizeAs(w, w.personId, {
      ceilingId: ceiling.id,
      tool: 'saveHome',
      kind: 'automation',
    });
    expect(created.status).toBe(201);
    const runId = randomUUID();
    const result = await evaluate(w, created.body.authorization.id, runId);
    expect(result.decision).toMatchObject({ allowed: true, effectiveAutonomy: 'autonomous' });
    expect(result.claims).toMatchObject({ runId, requesterAccountId: w.personId });

    await publish(w, VER);
    expect((await evaluate(w, created.body.authorization.id, randomUUID())).decision.allowed).toBe(
      false,
    );
  });

  it('pays only within explicit, bounded money authority', async () => {
    const w = await world();
    const ceiling = await publish(w, {
      capabilityPackages: ['read'],
      capabilities: ['payments.send'],
      limits: [{ tool: 'payRent', key: 'amount', value: 1200 }],
      maximumAutonomy: 'autonomous',
    });
    const created = await authorizeAs(w, w.personId, { ceilingId: ceiling.id, tool: 'payRent' });
    const result = await evaluate(w, created.body.authorization.id);
    expect(result.decision.allowed).toBe(true);
    expect(result.claims?.limits).toEqual([{ tool: 'payRent', key: 'amount', value: 1200 }]);
  });

  it('requires fresh requester authorization after an owner broadens a ceiling', async () => {
    const w = await world();
    const original = await publish(w, {
      capabilityPackages: ['read'],
      capabilities: ['payments.send'],
      limits: [{ tool: 'payRent', key: 'amount', value: 1200 }],
      maximumAutonomy: 'autonomous',
    });
    const authorized = await authorizeAs(w, w.personId, {
      ceilingId: original.id,
      tool: 'payRent',
    });

    const replacement = await publish(w, {
      capabilityPackages: ['read'],
      capabilities: ['payments.send'],
      limits: [{ tool: 'payRent', key: 'amount', value: 5000 }],
      maximumAutonomy: 'autonomous',
    });
    expect(replacement.id).not.toBe(original.id);
    expect((await evaluate(w, authorized.body.authorization.id)).decision).toEqual({
      allowed: false,
      reason: 'agent_ceiling_not_active',
    });

    const reauthorized = await authorizeAs(w, w.personId, {
      ceilingId: replacement.id,
      tool: 'payRent',
    });
    expect((await evaluate(w, reauthorized.body.authorization.id)).claims?.limits).toEqual([
      { tool: 'payRent', key: 'amount', value: 5000 },
    ]);
  });

  it('never reaches an account the person does not operate, nor the agent owner’s', async () => {
    const w = await world();
    const ceiling = await publish(w, VER_Y_ACTUAR);
    expect(
      (
        await authorizeAs(w, w.personId, {
          ceilingId: ceiling.id,
          tool: 'searchListings',
          effectiveAccountId: w.strangerId,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await authorizeAs(w, w.personId, {
          ceilingId: ceiling.id,
          tool: 'searchListings',
          effectiveAccountId: w.ownerId,
          ownerAccountId: w.ownerId,
        })
      ).status,
    ).toBe(403);
    // A row that tried anyway is refused by the database itself.
    await expect(
      getDb()
        .insert(capabilityExecutionAuthorizations)
        .values({
          kind: 'direct_request',
          requesterAccountId: w.personId,
          ownerAccountId: w.ownerId,
          coordinatorApplicationId: w.coordinator.applicationId,
          coordinatorCredentialId: w.coordinator.credentialId,
          actorType: 'agent',
          actorAccountId: w.agentId,
          resourceApp: w.appSlug,
          effectiveAccountId: w.personId,
          resourceType: ACCOUNT_ROOT,
          resourceKey: w.personId,
          tool: 'searchListings',
          runId: randomUUID(),
          maximumAutonomy: 'execute_on_request',
          ceilingId: ceiling.id,
          expiresAt: new Date(Date.now() + 60_000),
        }),
    ).rejects.toThrow();
  });

  it('refuses a ceiling named for another agent or app', async () => {
    const w = await world();
    const other = await world();
    const otherCeiling = await publish(other, VER_Y_ACTUAR);
    const response = await authorizeAs(w, w.personId, {
      ceilingId: otherCeiling.id,
      tool: 'searchListings',
    });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('ceiling_not_applicable');
  });

  it('ends on the next ticket once the ceiling is revoked, and honours the person’s policy', async () => {
    const w = await world();
    const ceiling = await publish(w, VER_Y_ACTUAR);
    const created = await authorizeAs(w, w.personId, { ceilingId: ceiling.id, tool: 'saveHome' });
    const issued = await evaluate(w, created.body.authorization.id);
    if (!issued.claims) throw new Error('Expected claims');

    await getDb()
      .insert(accountCapabilityPolicies)
      .values({
        accountId: w.personId,
        appSlug: w.appSlug,
        maximumAutonomy: 'autonomous',
        deniedCapabilities: ['saved.write'],
      });
    expect((await evaluate(w, created.body.authorization.id)).decision).toEqual({
      allowed: false,
      reason: 'account_policy_denied_capability',
    });
    await getDb()
      .delete(accountCapabilityPolicies)
      .where(eq(accountCapabilityPolicies.accountId, w.personId));

    expect((await w.as(w.ownerId).delete(ceilingPath(w))).status).toBe(204);
    expect((await evaluate(w, created.body.authorization.id)).decision).toEqual({
      allowed: false,
      reason: 'agent_ceiling_not_active',
    });
    await expect(reauthorizeCapabilityTicket(issued.claims)).resolves.toMatchObject({
      allowed: false,
    });
    expect((await w.as(w.ownerId).delete(ceilingPath(w))).status).toBe(404);
  });
});

describe('the requester capability map', () => {
  it('lists, per app, what the agent may do on the person’s account and nothing else', async () => {
    const w = await world();
    const ceiling = await publish(w, VER);
    const response = await w.service('/capabilities/requester-capability-map', {
      requesterAccountId: w.personId,
      effectiveAccountId: w.personId,
      actorAccountId: w.agentId,
    });
    expect(response.status).toBe(200);
    expect(response.body.assignments).toEqual([
      {
        ceilingId: ceiling.id,
        resource: {
          appId: w.appSlug,
          effectiveAccountId: w.personId,
          resourceType: ACCOUNT_ROOT,
          resourceId: w.personId,
        },
        maximumAutonomy: 'read_only',
        limits: [],
        toolNames: ['searchListings'],
      },
    ]);
    expect(
      (
        await w.service('/capabilities/requester-capability-map', {
          requesterAccountId: w.personId,
          effectiveAccountId: w.strangerId,
          actorAccountId: w.agentId,
        })
      ).status,
    ).toBe(403);
    await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, w.agentId));
    expect(
      (
        await w.service('/capabilities/requester-capability-map', {
          requesterAccountId: w.personId,
          effectiveAccountId: w.personId,
          actorAccountId: w.agentId,
        })
      ).status,
    ).toBe(400);
  });
});
