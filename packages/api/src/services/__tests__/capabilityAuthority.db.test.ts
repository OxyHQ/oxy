import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppCapabilityCatalog, AutonomyLevel } from '@oxyhq/contracts';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import {
  appCapabilityCatalogRegistrations,
  capabilityExecutionAuthorizations,
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

async function fixture(maximumAutonomy: AutonomyLevel) {
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
  const catalog: AppCapabilityCatalog = {
    schemaVersion: '1',
    appId: appSlug,
    version: '1.0.0',
    audience: `${appSlug}-api`,
    internalBaseUrl: 'https://api.example.test',
    accountResourceType: 'account',
    tools: [{
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
    }],
    events: [],
  };
  await getDb().insert(appCapabilityCatalogRegistrations).values({
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
  const [authorization] = await getDb().insert(capabilityExecutionAuthorizations).values({
    kind: 'direct_request',
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
    tool: 'publishEffect',
    runId: randomUUID(),
    maximumAutonomy,
    limits: [],
    expiresAt: new Date(Date.now() + 60_000),
  }).returning({ id: capabilityExecutionAuthorizations.id });
  return {
    authorizationId: authorization.id,
    coordinator: { applicationId: application.id, credentialId: credential.id },
  };
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
});
