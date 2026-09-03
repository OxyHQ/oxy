import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isCheckViolation } from '@oxyhq/db';
import type {
  AppCapabilityCatalog,
  AutonomyLevel,
  CatalogTool,
  GrantLimit,
} from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import {
  accountCapabilityPolicies,
  appCapabilityCatalogRegistrations,
  capabilityExecutionAuthorizations,
  delegationGrants,
} from '../../db/schema/agency';
import { users } from '../../db/schema/users';
import {
  evaluateCapabilityAuthority,
  reauthorizeCapabilityTicket,
} from '../capabilityAuthority.service';

const keyPair = generateKeyPairSync('ed25519');
const originalKeyId = process.env.CAPABILITY_TICKET_SIGNING_KEY_ID;
const originalPrivateKey = process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY;

beforeAll(async () => {
  process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = 'authority-db-test';
  process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY = keyPair.privateKey.export({
    format: 'pem',
    type: 'pkcs8',
  }).toString();
  await connectPostgres();
});

afterAll(async () => {
  if (originalKeyId === undefined) delete process.env.CAPABILITY_TICKET_SIGNING_KEY_ID;
  else process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = originalKeyId;
  if (originalPrivateKey === undefined) delete process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY;
  else process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY = originalPrivateKey;
  await closePostgres();
});

async function fixture(
  maximumAutonomy: AutonomyLevel,
  kind: 'direct_request' | 'automation' = 'direct_request',
  toolInput: Partial<CatalogTool> = {},
  limits: GrantLimit[] = [],
) {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const appSlug = `authority-${randomUUID()}`;
  const [application] = await getDb().insert(applications).values({
    name: `Authority coordinator ${randomUUID()}`,
    ownerAccountId: owner.id,
    status: 'active',
    isInternal: true,
    scopes: ['capability-tickets:issue'],
    capabilities: ['agency:coordinate'],
  }).returning({ id: applications.id });
  const [credential] = await getDb().insert(applicationCredentials).values({
    applicationId: application.id,
    name: 'Authority credential',
    publicKey: `oxy_dk_${randomUUID()}`,
    secretHash: 'test-only-secret-hash',
    type: 'service',
    environment: 'production',
    scopes: ['capability-tickets:issue'],
    status: 'active',
  }).returning({ id: applicationCredentials.id });
  const tool: CatalogTool = {
    name: 'publishEffect',
    version: '1.0.0',
    description: 'Publish one effect for authority testing.',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object' },
    capabilityPackage: 'publish',
    requiredCapabilities: ['test.publish'],
    resourceTypes: ['account'],
    effect: 'external',
    idempotency: 'required',
    rollback: 'none',
    exposure: ['internal'],
    limitKeys: [],
    invocation: { method: 'POST', path: '/effects' },
    ...toolInput,
  };
  const catalog: AppCapabilityCatalog = {
    schemaVersion: '1',
    appId: appSlug,
    version: '1.0.0',
    audience: `${appSlug}-api`,
    internalBaseUrl: 'https://api.example.test',
    accountResourceType: 'account',
    tools: [tool],
    events: [],
  };
  const [registration] = await getDb().insert(appCapabilityCatalogRegistrations).values({
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
  }).returning({ id: appCapabilityCatalogRegistrations.id });
  const automationId = kind === 'automation' ? `automation-${randomUUID()}` : null;
  const [authorization] = await getDb().insert(capabilityExecutionAuthorizations).values({
    kind,
    requesterAccountId: owner.id,
    ownerAccountId: owner.id,
    coordinatorApplicationId: application.id,
    coordinatorCredentialId: credential.id,
    actorType: 'alia',
    actorAccountId: null,
    resourceApp: appSlug,
    effectiveAccountId: owner.id,
    resourceType: 'account',
    resourceKey: owner.id,
    tool: tool.name,
    runId: kind === 'direct_request' ? randomUUID() : null,
    automationId,
    maximumAutonomy,
    limits,
    expiresAt: new Date(Date.now() + 60_000),
  }).returning({ id: capabilityExecutionAuthorizations.id });
  return {
    ownerId: owner.id,
    appSlug,
    catalogRegistrationId: registration.id,
    authorizationId: authorization.id,
    coordinator: { applicationId: application.id, credentialId: credential.id },
    automationId,
  };
}

async function agentFixture() {
  const input = await fixture('execute_on_request');
  const [agent] = await getDb().insert(users).values({
    color: 'teal',
    kind: 'bot',
    username: `authority-agent-${randomUUID()}`,
    parentAccountId: input.ownerId,
  }).returning({ id: users.id });
  const [grant] = await getDb().insert(delegationGrants).values({
    ownerAccountId: input.ownerId,
    actorAccountId: agent.id,
    resourceApp: input.appSlug,
    effectiveAccountId: input.ownerId,
    resourceType: 'account',
    resourceKey: input.ownerId,
    catalogRegistrationId: input.catalogRegistrationId,
    capabilityPackages: ['publish'],
    maximumAutonomy: 'execute_on_request',
    canRedelegate: false,
    expiresAt: new Date(Date.now() + 60_000),
    createdByUserId: input.ownerId,
  }).returning({ id: delegationGrants.id });
  await getDb().update(capabilityExecutionAuthorizations).set({
    actorType: 'agent',
    actorAccountId: agent.id,
  }).where(eq(capabilityExecutionAuthorizations.id, input.authorizationId));
  return { ...input, grantId: grant.id };
}

describe('capability authority over live database state', () => {
  it('never issues an effect ticket for draft authority', async () => {
    const input = await fixture('draft');

    const result = await evaluateCapabilityAuthority({
      executionAuthorizationId: input.authorizationId,
      coordinator: input.coordinator,
    }, { issueTicket: true });

    expect(result).toEqual({
      decision: { allowed: false, reason: 'effect_requires_execution_authority' },
    });
  });

  it('rejects a ticket when its server-side authorization is revoked before execution', async () => {
    const input = await fixture('execute_on_request');
    const issued = await evaluateCapabilityAuthority({
      executionAuthorizationId: input.authorizationId,
      coordinator: input.coordinator,
    }, { issueTicket: true });
    expect(issued.decision.allowed).toBe(true);
    expect(issued.claims).toBeDefined();
    if (!issued.claims) throw new Error('Expected an issued capability ticket');

    await getDb().update(capabilityExecutionAuthorizations).set({ revokedAt: new Date() })
      .where(eq(capabilityExecutionAuthorizations.id, input.authorizationId));

    await expect(reauthorizeCapabilityTicket(issued.claims)).resolves.toEqual({
      allowed: false,
      reason: 'ticket_execution_authorization_mismatch',
    });
  });

  it('rejects an execution authorization after its expiry', async () => {
    const input = await fixture('execute_on_request');
    await getDb().update(capabilityExecutionAuthorizations).set({
      expiresAt: new Date(Date.now() - 1_000),
    }).where(eq(capabilityExecutionAuthorizations.id, input.authorizationId));

    await expect(evaluateCapabilityAuthority({
      executionAuthorizationId: input.authorizationId,
      coordinator: input.coordinator,
    }, { issueTicket: true })).resolves.toEqual({
      decision: { allowed: false, reason: 'execution_authorization_not_active' },
    });
  });

  it('materializes durable automation authority into a ticket for one exact run', async () => {
    const input = await fixture('autonomous', 'automation');

    // The contract release has already cleared legacy rows and now refuses any
    // writer that tries to bind a recurrent authorization to one future run.
    try {
      await getDb().update(capabilityExecutionAuthorizations).set({
        runId: 'legacy-automation-run',
        stepId: 'legacy-automation-step',
      }).where(eq(capabilityExecutionAuthorizations.id, input.authorizationId));
      throw new Error('Expected persisted automation run scope to be refused');
    } catch (error: unknown) {
      expect(isCheckViolation(
        error,
        'capability_execution_authorizations_run_scope_check',
      )).toBe(true);
    }

    await expect(evaluateCapabilityAuthority({
      executionAuthorizationId: input.authorizationId,
      coordinator: input.coordinator,
    }, { issueTicket: true })).resolves.toEqual({
      decision: { allowed: false, reason: 'automation_run_identity_missing' },
    });

    const issued = await evaluateCapabilityAuthority({
      executionAuthorizationId: input.authorizationId,
      coordinator: input.coordinator,
      runId: 'automation-run-1',
      stepId: 'automation-step-1',
    }, { issueTicket: true });

    expect(issued.decision.allowed).toBe(true);
    expect(issued.claims).toMatchObject({
      runId: 'automation-run-1',
      stepId: 'automation-step-1',
      automationId: input.automationId,
      executionAuthorization: {
        kind: 'automation',
        id: input.authorizationId,
        automationId: input.automationId,
      },
    });
    if (!issued.claims) throw new Error('Expected an issued automation ticket');
    await expect(reauthorizeCapabilityTicket(issued.claims)).resolves.toMatchObject({
      allowed: true,
      effectiveAutonomy: 'autonomous',
    });
  });

  it('rejects autonomous sensitive authority when the tool has no bounded inputs', async () => {
    const input = await fixture('autonomous', 'automation', {
      capabilityPackage: 'finance',
      requiredCapabilities: ['finance.execute'],
      effect: 'financial',
    });

    await expect(evaluateCapabilityAuthority({
      executionAuthorizationId: input.authorizationId,
      coordinator: input.coordinator,
      runId: 'financial-run',
    }, { issueTicket: true })).resolves.toEqual({
      decision: { allowed: false, reason: 'autonomous_sensitive_tool_has_no_limit_keys' },
    });
  });

  it('rechecks every autonomous sensitive limit when a ticket is used', async () => {
    const limits: GrantLimit[] = [{ tool: 'publishEffect', key: 'amount', value: 100 }];
    const input = await fixture('autonomous', 'automation', {
      inputSchema: {
        type: 'object',
        properties: { amount: { type: 'number' } },
        additionalProperties: false,
      },
      capabilityPackage: 'finance',
      requiredCapabilities: ['finance.execute'],
      effect: 'financial',
      limitKeys: [{ key: 'amount', kind: 'maximum_number' }],
    }, limits);
    const issued = await evaluateCapabilityAuthority({
      executionAuthorizationId: input.authorizationId,
      coordinator: input.coordinator,
      runId: 'financial-run',
    }, { issueTicket: true });
    expect(issued.decision.allowed).toBe(true);
    if (!issued.claims) throw new Error('Expected an autonomous financial ticket');

    await getDb().update(capabilityExecutionAuthorizations).set({ limits: [] })
      .where(eq(capabilityExecutionAuthorizations.id, input.authorizationId));

    await expect(reauthorizeCapabilityTicket(issued.claims)).resolves.toEqual({
      allowed: false,
      reason: 'autonomous_sensitive_tool_limit_required',
    });
  });

  it('invalidates a ticket when a sensitive limit is narrowed after issuance', async () => {
    const limits: GrantLimit[] = [{ tool: 'publishEffect', key: 'amount', value: 100 }];
    const input = await fixture('autonomous', 'automation', {
      inputSchema: {
        type: 'object',
        properties: { amount: { type: 'number' } },
        additionalProperties: false,
      },
      capabilityPackage: 'finance',
      requiredCapabilities: ['finance.execute'],
      effect: 'financial',
      limitKeys: [{ key: 'amount', kind: 'maximum_number' }],
    }, limits);
    const issued = await evaluateCapabilityAuthority({
      executionAuthorizationId: input.authorizationId,
      coordinator: input.coordinator,
      runId: 'financial-run',
    }, { issueTicket: true });
    if (!issued.claims) throw new Error('Expected an autonomous financial ticket');

    await getDb().update(capabilityExecutionAuthorizations).set({
      limits: [{ tool: 'publishEffect', key: 'amount', value: 50 }],
    }).where(eq(capabilityExecutionAuthorizations.id, input.authorizationId));

    await expect(reauthorizeCapabilityTicket(issued.claims)).resolves.toEqual({
      allowed: false,
      reason: 'ticket_authority_snapshot_no_longer_current',
    });
  });

  it('does not let a coordinator replace the run bound to direct authority', async () => {
    const input = await fixture('execute_on_request');

    await expect(evaluateCapabilityAuthority({
      executionAuthorizationId: input.authorizationId,
      coordinator: input.coordinator,
      runId: 'different-run',
    }, { issueTicket: true })).resolves.toEqual({
      decision: { allowed: false, reason: 'direct_request_runtime_scope_override' },
    });
  });

  it('applies a newly restrictive account policy before issuing a ticket', async () => {
    const input = await fixture('execute_on_request');
    await getDb().insert(accountCapabilityPolicies).values({
      accountId: input.ownerId,
      appSlug: input.appSlug,
      maximumAutonomy: 'draft',
      deniedCapabilities: [],
    });

    await expect(evaluateCapabilityAuthority({
      executionAuthorizationId: input.authorizationId,
      coordinator: input.coordinator,
    }, { issueTicket: true })).resolves.toEqual({
      decision: { allowed: false, reason: 'requested_autonomy_exceeds_effective_policy' },
    });
  });

  it('rejects an expired agent grant', async () => {
    const input = await agentFixture();
    await getDb().update(delegationGrants).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(delegationGrants.id, input.grantId));

    await expect(evaluateCapabilityAuthority({
      executionAuthorizationId: input.authorizationId,
      coordinator: input.coordinator,
    }, { issueTicket: true })).resolves.toEqual({
      decision: { allowed: false, reason: 'agent_has_no_active_grant' },
    });
  });

  it('invalidates an issued ticket as soon as its agent grant is revoked', async () => {
    const input = await agentFixture();
    const issued = await evaluateCapabilityAuthority({
      executionAuthorizationId: input.authorizationId,
      coordinator: input.coordinator,
    }, { issueTicket: true });
    if (!issued.claims) throw new Error('Expected an issued agent capability ticket');

    await getDb().update(delegationGrants).set({ revokedAt: new Date() })
      .where(eq(delegationGrants.id, input.grantId));

    await expect(reauthorizeCapabilityTicket(issued.claims)).resolves.toEqual({
      allowed: false,
      reason: 'ticket_grant_is_no_longer_current',
    });
  });
});
