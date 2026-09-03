import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import type { AppCapabilityCatalog } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import {
  appCapabilityCatalogRegistrations,
  capabilityExecutionAuthorizations,
} from '../../db/schema/agency';
import { users } from '../../db/schema/users';

const USER_ID = 'settings-user';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (
    req: { user?: { _id: string; id: string } },
    _res: unknown,
    next: () => void,
  ) => {
    req.user = { _id: 'settings-user', id: 'settings-user' };
    next();
  },
  serviceAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../services/account.service', () => ({
  __esModule: true,
  default: {
    resolveEffectiveAccess: jest.fn(async (operatorId: string, accountId: string) => (
      operatorId === 'settings-user' && accountId === 'settings-user'
        ? { permissions: ['account:act_as'] }
        : null
    )),
  },
}));

jest.mock('../../services/agencyServicePrincipal.service', () => ({
  principalHasCatalogCapability: jest.fn(() => false),
  resolveLiveAgencyCoordinator: jest.fn(async (applicationId: string, credentialId: string) => ({
    applicationId,
    credentialId,
    ownerAccountId: 'settings-user',
    scopes: ['capability-tickets:issue'],
    capabilities: ['agency:coordinate'],
  })),
  resolveLiveAgencyServicePrincipal: jest.fn(),
}));

jest.mock('../../services/capabilityAuthority.service', () => ({
  evaluateCapabilityAuthority: jest.fn(),
  grantAllowsTool: jest.fn(() => false),
  mostRestrictiveAutonomy: jest.fn((levels: string[]) => levels[0]),
  reauthorizeCapabilityTicket: jest.fn(),
}));

jest.mock('../../services/capabilityRuntimeStore.service', () => ({
  persistCapabilityAuditEvent: jest.fn(),
}));

import capabilitiesRouter from '../capabilities';

const app = express();
app.use(express.json());
app.use('/capabilities', capabilitiesRouter);

const appSlug = `settings-catalog-${randomUUID()}`;
const catalog: AppCapabilityCatalog = {
  schemaVersion: '1',
  appId: appSlug,
  version: '1.0.0',
  audience: `${appSlug}-api`,
  internalBaseUrl: 'https://api.example.test',
  accountResourceType: 'account',
  tools: [
    {
      name: 'readResource',
      version: '1.0.0',
      description: 'Read one account resource.',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object' },
      capabilityPackage: 'read',
      requiredCapabilities: ['resource.read'],
      resourceTypes: ['account'],
      effect: 'read',
      idempotency: 'none',
      rollback: 'none',
      exposure: ['internal'],
      limitKeys: [],
      invocation: { method: 'GET', path: '/resource' },
    },
    {
      name: 'financialEffect',
      version: '1.0.0',
      description: 'Perform one bounded financial effect.',
      inputSchema: {
        type: 'object',
        properties: { amount: { type: 'number' } },
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
      capabilityPackage: 'finance',
      requiredCapabilities: ['finance.execute'],
      resourceTypes: ['account'],
      effect: 'financial',
      idempotency: 'required',
      rollback: 'manual',
      exposure: ['internal'],
      limitKeys: [{ key: 'amount', kind: 'maximum_number' }],
      invocation: { method: 'POST', path: '/financial-effect' },
    },
  ],
  events: [],
};

let agentId: string;
let applicationId: string;
let credentialId: string;
let authorizationId: string;

beforeAll(async () => {
  await connectPostgres();
  await getDb().insert(users).values({ id: USER_ID, color: 'teal' });
  const [agent] = await getDb().insert(users).values({
    color: 'teal',
    kind: 'bot',
    username: `settings-agent-${randomUUID()}`,
    parentAccountId: USER_ID,
  }).returning({ id: users.id });
  agentId = agent.id;
  const [application] = await getDb().insert(applications).values({
    name: `Settings catalog owner ${randomUUID()}`,
    ownerAccountId: USER_ID,
    status: 'active',
    isInternal: true,
  }).returning({ id: applications.id });
  applicationId = application.id;
  const [credential] = await getDb().insert(applicationCredentials).values({
    applicationId,
    name: 'Settings test credential',
    publicKey: `oxy_dk_${randomUUID()}`,
    secretHash: 'settings-test-secret-hash',
    type: 'service',
    environment: 'production',
    scopes: [],
    status: 'active',
  }).returning({ id: applicationCredentials.id });
  credentialId = credential.id;
  await getDb().insert(appCapabilityCatalogRegistrations).values({
    appSlug,
    version: catalog.version,
    audience: catalog.audience,
    catalog,
    digest: 'a'.repeat(64),
    signature: 'settings-test-signature',
    registeredByApplicationId: applicationId,
    registeredByCredentialId: credentialId,
    deployedAt: new Date(),
    active: true,
  });
  const [authorization] = await getDb().insert(capabilityExecutionAuthorizations).values({
    kind: 'direct_request',
    requesterAccountId: USER_ID,
    ownerAccountId: USER_ID,
    coordinatorApplicationId: applicationId,
    coordinatorCredentialId: credentialId,
    actorType: 'alia',
    actorAccountId: null,
    resourceApp: appSlug,
    effectiveAccountId: USER_ID,
    resourceType: 'account',
    resourceKey: USER_ID,
    tool: 'readResource',
    runId: `settings-run-${randomUUID()}`,
    maximumAutonomy: 'read_only',
    limits: [],
    expiresAt: new Date(Date.now() + 60_000),
  }).returning({ id: capabilityExecutionAuthorizations.id });
  authorizationId = authorization.id;
});

afterAll(async () => {
  await closePostgres();
});

it('serves safe catalogs and manages account policies for Settings', async () => {
  const available = await request(app).get(`/capabilities/catalogs/available?accountId=${USER_ID}`);
  expect(available.status).toBe(200);
  expect(available.body.catalogs).toEqual(expect.arrayContaining([expect.objectContaining({
    appId: appSlug,
    version: catalog.version,
    digest: 'a'.repeat(64),
    audience: catalog.audience,
    catalog,
  })]));
  expect(JSON.stringify(available.body)).not.toContain('settings-test-signature');
  expect(JSON.stringify(available.body)).not.toContain(credentialId);

  const written = await request(app).put(`/capabilities/account-policies/${appSlug}`).send({
    accountId: USER_ID,
    maximumAutonomy: 'draft',
    deniedCapabilities: ['resource.read'],
  });
  expect(written.status).toBe(200);
  expect(written.body.policy).toMatchObject({
    accountId: USER_ID,
    appSlug,
    maximumAutonomy: 'draft',
    deniedCapabilities: ['resource.read'],
  });

  const listed = await request(app).get(`/capabilities/account-policies?accountId=${USER_ID}&appId=${appSlug}`);
  expect(listed.status).toBe(200);
  expect(listed.body.policies).toHaveLength(1);

  const removed = await request(app).delete(`/capabilities/account-policies/${appSlug}?accountId=${USER_ID}`);
  expect(removed.status).toBe(204);
});

it('rejects future tools and edits a catalog-bound grant atomically', async () => {
  const resource = {
    appId: appSlug,
    effectiveAccountId: USER_ID,
    resourceType: 'account',
    resourceId: USER_ID,
  };
  const futureOverride = await request(app).post('/capabilities/grants').send({
    ownerAccountId: USER_ID,
    actorAccountId: agentId,
    resource,
    capabilityPackages: ['read'],
    capabilities: [],
    toolOverrides: [{ tool: 'futureTool', decision: 'allow' }],
    limits: [],
    maximumAutonomy: 'read_only',
    canRedelegate: false,
    expiresAt: null,
  });
  expect(futureOverride.status).toBe(400);
  expect(futureOverride.body).toEqual({ error: 'override_tool_not_available_for_resource' });

  const unboundedAutonomy = await request(app).post('/capabilities/grants').send({
    ownerAccountId: USER_ID,
    actorAccountId: agentId,
    resource,
    capabilityPackages: [],
    capabilities: ['finance.execute'],
    toolOverrides: [],
    limits: [],
    maximumAutonomy: 'autonomous',
    canRedelegate: false,
    expiresAt: null,
  });
  expect(unboundedAutonomy.status).toBe(400);
  expect(unboundedAutonomy.body).toEqual({ error: 'autonomous_sensitive_tool_limit_required' });

  const created = await request(app).post('/capabilities/grants').send({
    ownerAccountId: USER_ID,
    actorAccountId: agentId,
    resource,
    capabilityPackages: ['read'],
    capabilities: [],
    toolOverrides: [],
    limits: [],
    maximumAutonomy: 'read_only',
    canRedelegate: false,
    expiresAt: null,
  });
  expect(created.status).toBe(201);
  expect(created.body.grant.catalog).toMatchObject({ version: catalog.version, digest: 'a'.repeat(64) });

  const unsafeUpdate = await request(app).put(`/capabilities/grants/${created.body.grant.id}`).send({
    capabilityPackages: [],
    capabilities: ['finance.execute'],
    toolOverrides: [],
    limits: [],
    maximumAutonomy: 'autonomous',
    canRedelegate: false,
    expiresAt: null,
  });
  expect(unsafeUpdate.status).toBe(400);
  expect(unsafeUpdate.body).toEqual({ error: 'autonomous_sensitive_tool_limit_required' });

  const updated = await request(app).put(`/capabilities/grants/${created.body.grant.id}`).send({
    capabilityPackages: [],
    capabilities: ['resource.read'],
    toolOverrides: [],
    limits: [],
    maximumAutonomy: 'draft',
    canRedelegate: false,
    expiresAt: null,
  });
  expect(updated.status).toBe(200);
  expect(updated.body.grant).toMatchObject({
    id: created.body.grant.id,
    capabilityPackages: [],
    capabilities: ['resource.read'],
    maximumAutonomy: 'draft',
    resource,
  });
});

it('lists and revokes execution authorizations for Settings', async () => {
  const unsafeAuthorization = await request(app).post('/capabilities/execution-authorizations').send({
    kind: 'automation',
    ownerAccountId: USER_ID,
    coordinatorApplicationId: applicationId,
    coordinatorCredentialId: credentialId,
    actor: { type: 'alia', ownerAccountId: USER_ID },
    resource: {
      appId: appSlug,
      effectiveAccountId: USER_ID,
      resourceType: 'account',
      resourceId: USER_ID,
    },
    tool: 'financialEffect',
    automationId: `settings-automation-${randomUUID()}`,
    maximumAutonomy: 'autonomous',
    limits: [],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  expect(unsafeAuthorization.status).toBe(400);
  expect(unsafeAuthorization.body).toEqual({ error: 'autonomous_sensitive_tool_limit_required' });

  const listed = await request(app).get(`/capabilities/execution-authorizations?ownerAccountId=${USER_ID}`);
  expect(listed.status).toBe(200);
  expect(listed.body.authorizations).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: authorizationId, ownerAccountId: USER_ID }),
  ]));

  const revoked = await request(app).delete(`/capabilities/execution-authorizations/${authorizationId}`);
  expect(revoked.status).toBe(204);
  const relisted = await request(app).get(`/capabilities/execution-authorizations?ownerAccountId=${USER_ID}`);
  const authorization = relisted.body.authorizations.find((entry: { id: string }) => entry.id === authorizationId);
  expect(authorization.revokedAt).not.toBeNull();
});
