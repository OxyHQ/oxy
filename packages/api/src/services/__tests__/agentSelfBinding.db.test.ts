/**
 * An agent acting AS ITSELF (ADR 0018 addendum): its own bot account needs no
 * DelegationGrant, and nothing else does — and the unattended-run lane derives
 * the requester from the bot's live parent instead of taking it from Alia.
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
  appCapabilityCatalogRegistrations,
  capabilityExecutionAuthorizations,
  delegationGrants,
} from '../../db/schema/agency';
import { users } from '../../db/schema/users';
import { accountMembers } from '../../db/schema/accountMembers';
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
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
  process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = 'agent-self-binding-test';
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

const TOOLS: CatalogTool[] = [
  {
    name: 'readMail',
    version: '1.0.0',
    description: 'Read the mailbox.',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object' },
    capabilityPackage: 'read',
    requiredCapabilities: ['mail.read'],
    resourceTypes: ['account'],
    effect: 'read',
    idempotency: 'none',
    rollback: 'none',
    exposure: ['internal'],
    limitKeys: [],
    invocation: { method: 'GET', path: '/mail' },
  },
  {
    name: 'sendMail',
    version: '1.0.0',
    description: 'Send one email.',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: { type: 'object' },
    capabilityPackage: 'communicate',
    requiredCapabilities: ['mail.send'],
    resourceTypes: ['account'],
    effect: 'external',
    idempotency: 'required',
    rollback: 'none',
    exposure: ['internal'],
    limitKeys: [],
    invocation: { method: 'POST', path: '/mail' },
  },
];

/**
 * A person, the bot they own (parent + `owner` membership, which is what
 * creating an agent account leaves behind), a second bot the same person owns,
 * and Alia's coordinator.
 */
async function world() {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const [agent] = await getDb()
    .insert(users)
    .values({
      color: 'teal',
      kind: 'bot',
      username: `self-agent-${randomUUID()}`,
      parentAccountId: owner.id,
    })
    .returning({ id: users.id });
  const [otherBot] = await getDb()
    .insert(users)
    .values({
      color: 'teal',
      kind: 'bot',
      username: `self-other-${randomUUID()}`,
      parentAccountId: owner.id,
    })
    .returning({ id: users.id });
  await getDb()
    .insert(accountMembers)
    .values([
      { accountId: agent.id, memberUserId: owner.id, role: 'owner', status: 'active' },
      { accountId: otherBot.id, memberUserId: owner.id, role: 'owner', status: 'active' },
    ]);
  const appSlug = `selfmail-${randomUUID()}`;
  const scopes = ['capability-tickets:issue', 'capabilities:read'];
  const [application] = await getDb()
    .insert(applications)
    .values({
      name: `Self coordinator ${randomUUID()}`,
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
      name: 'Self credential',
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
    internalBaseUrl: 'https://mail.example.test',
    accountResourceType: 'account',
    tools: TOOLS,
    events: [],
  };
  const [registration] = await getDb()
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
    })
    .returning({ id: appCapabilityCatalogRegistrations.id });
  return {
    ownerId: owner.id,
    agentId: agent.id,
    otherBotId: otherBot.id,
    appSlug,
    registrationId: registration.id,
    coordinator: { applicationId: application.id, credentialId: credential.id },
    scopes,
  };
}

type World = Awaited<ReturnType<typeof world>>;

async function authorize(
  w: World,
  input: {
    effectiveAccountId: string;
    requesterAccountId?: string;
    tool?: string;
    maximumAutonomy?: AutonomyLevel;
    kind?: 'direct_request' | 'automation';
  },
) {
  const kind = input.kind ?? 'direct_request';
  const [row] = await getDb()
    .insert(capabilityExecutionAuthorizations)
    .values({
      kind,
      requesterAccountId: input.requesterAccountId ?? w.ownerId,
      ownerAccountId: w.ownerId,
      coordinatorApplicationId: w.coordinator.applicationId,
      coordinatorCredentialId: w.coordinator.credentialId,
      actorType: 'agent',
      actorAccountId: w.agentId,
      resourceApp: w.appSlug,
      effectiveAccountId: input.effectiveAccountId,
      resourceType: 'account',
      resourceKey: input.effectiveAccountId,
      tool: input.tool ?? 'sendMail',
      runId: kind === 'direct_request' ? randomUUID() : null,
      automationId: kind === 'automation' ? `agent-session:${randomUUID()}` : null,
      maximumAutonomy: input.maximumAutonomy ?? 'execute_on_request',
      limits: [],
      expiresAt: new Date(Date.now() + 60_000),
    })
    .returning({ id: capabilityExecutionAuthorizations.id });
  return row.id;
}

function evaluate(w: World, executionAuthorizationId: string, runId?: string) {
  return evaluateCapabilityAuthority(
    {
      executionAuthorizationId,
      coordinator: w.coordinator,
      ...(runId ? { runId } : {}),
    },
    { issueTicket: true },
  );
}

async function grant(
  w: World,
  packages: Array<'read' | 'communicate'>,
  maximumAutonomy: AutonomyLevel,
) {
  await getDb().insert(delegationGrants).values({
    ownerAccountId: w.ownerId,
    actorAccountId: w.agentId,
    resourceApp: w.appSlug,
    effectiveAccountId: w.ownerId,
    resourceType: 'account',
    resourceKey: w.ownerId,
    catalogRegistrationId: w.registrationId,
    capabilityPackages: packages,
    maximumAutonomy,
    canRedelegate: false,
    expiresAt: null,
    createdByUserId: w.ownerId,
  });
}

describe('an agent acting on its own account', () => {
  it('is authorized by an active bot, a live coordinator and its operator — without any grant', async () => {
    const w = await world();
    const result = await evaluate(w, await authorize(w, { effectiveAccountId: w.agentId }));
    expect(result.decision).toMatchObject({
      allowed: true,
      reason: 'allowed_by_current_authority',
    });
    expect(result.decision.grantId).toBeUndefined();
    expect(result.claims).toMatchObject({
      requesterAccountId: w.ownerId,
      actor: { type: 'agent', accountId: w.agentId },
      resource: { effectiveAccountId: w.agentId },
    });
    expect(result.claims?.grantId).toBeUndefined();
    if (!result.claims) throw new Error('Expected claims');
    await expect(reauthorizeCapabilityTicket(result.claims)).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("never reaches its owner's account without a grant", async () => {
    const w = await world();
    await expect(
      evaluate(w, await authorize(w, { effectiveAccountId: w.ownerId })),
    ).resolves.toEqual({
      decision: { allowed: false, reason: 'agent_has_no_active_grant' },
    });
  });

  it('never reaches ANOTHER bot the same person operates without a grant', async () => {
    const w = await world();
    await expect(
      evaluate(w, await authorize(w, { effectiveAccountId: w.otherBotId })),
    ).resolves.toEqual({
      decision: { allowed: false, reason: 'agent_has_no_active_grant' },
    });
  });

  it('is not its own requester: a bare bot id proves nothing', async () => {
    const w = await world();
    const result = await evaluate(
      w,
      await authorize(w, {
        effectiveAccountId: w.agentId,
        requesterAccountId: w.agentId,
      }),
    );
    expect(result.decision.allowed).toBe(false);
  });

  it('ends the moment its operator loses authority over the bot, or the bot is archived', async () => {
    const w = await world();
    const id = await authorize(w, { effectiveAccountId: w.agentId });
    const issued = await evaluate(w, id);
    if (!issued.claims) throw new Error('Expected claims');
    await getDb()
      .update(accountMembers)
      .set({ status: 'removed' })
      .where(eq(accountMembers.accountId, w.agentId));
    await expect(evaluate(w, id)).resolves.toEqual({
      decision: { allowed: false, reason: 'requester_lacks_current_account_authority' },
    });
    await expect(reauthorizeCapabilityTicket(issued.claims)).resolves.toMatchObject({
      allowed: false,
    });

    const archived = await world();
    const archivedId = await authorize(archived, { effectiveAccountId: archived.agentId });
    await getDb()
      .update(users)
      .set({ accountStatus: 'archived' })
      .where(eq(users.id, archived.agentId));
    expect((await evaluate(archived, archivedId)).decision.allowed).toBe(false);
  });
});

describe('the unattended agent-run lane', () => {
  function app(w: World) {
    const token = signServiceTokenEd25519({
      type: 'service',
      appId: w.coordinator.applicationId,
      appName: 'Alia fixture',
      credentialId: w.coordinator.credentialId,
      ownerAccountId: w.ownerId,
      environment: 'production',
      tier: 'internal',
      scopes: w.scopes,
      iss: 'oxy-auth',
      aud: 'oxy-api',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const server = express();
    server.use(express.json());
    server.use('/capabilities', capabilitiesRouter);
    return (body: Record<string, unknown>) =>
      request(server)
        .post('/capabilities/agent-run-authorizations')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
  }

  function body(w: World, overrides: Record<string, unknown> = {}) {
    return {
      actorAccountId: w.agentId,
      ownerAccountId: w.ownerId,
      sessionId: `session-${randomUUID()}`,
      resource: {
        appId: w.appSlug,
        effectiveAccountId: w.agentId,
        resourceType: 'account',
        resourceId: w.agentId,
      },
      tool: 'sendMail',
      maximumAutonomy: 'autonomous',
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      ...overrides,
    };
  }

  it("derives the requester from the bot's live parent and lets the agent act as itself", async () => {
    const w = await world();
    const created = await app(w)(body(w));
    expect(created.status).toBe(201);
    expect(created.body.authorization).toMatchObject({
      kind: 'automation',
      requesterAccountId: w.ownerId,
      ownerAccountId: w.ownerId,
      actorType: 'agent',
      actorAccountId: w.agentId,
      effectiveAccountId: w.agentId,
    });
    expect(created.body.authorization.automationId).toMatch(/^agent-session:session-/);
    const runId = randomUUID();
    const result = await evaluate(w, created.body.authorization.id, runId);
    expect(result.decision.allowed).toBe(true);
    expect(result.claims).toMatchObject({
      runId,
      requesterAccountId: w.ownerId,
      autonomy: 'autonomous',
    });
  });

  it('refuses an owner the bot does not have, and an account that is not a bot', async () => {
    const w = await world();
    const stranger = await world();
    expect((await app(w)(body(w, { ownerAccountId: stranger.ownerId }))).status).toBe(403);
    expect((await app(w)(body(w, { actorAccountId: w.ownerId }))).status).toBe(403);
    // Another bot, named with its real owner but pointed at THIS bot's account:
    // its owner does not operate it.
    expect(
      (
        await app(w)(
          body(w, {
            actorAccountId: stranger.agentId,
            ownerAccountId: stranger.ownerId,
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await app(w)(
          body(w, {
            actorAccountId: stranger.agentId,
            ownerAccountId: stranger.ownerId,
            resource: {
              appId: w.appSlug,
              effectiveAccountId: stranger.agentId,
              resourceType: 'account',
              resourceId: stranger.agentId,
            },
          }),
        )
      ).status,
    ).toBe(201);
  });

  it('refuses an expiry beyond fifteen minutes', async () => {
    const w = await world();
    expect(
      (
        await app(w)(
          body(w, {
            expiresAt: new Date(Date.now() + 16 * 60_000).toISOString(),
          }),
        )
      ).status,
    ).toBe(400);
  });

  it("reaches the owner's data only through a grant whose autonomy covers unattended effects", async () => {
    const w = await world();
    const ownerResource = {
      appId: w.appSlug,
      effectiveAccountId: w.ownerId,
      resourceType: 'account',
      resourceId: w.ownerId,
    };
    const send = await app(w)(body(w, { resource: ownerResource }));
    expect(send.status).toBe(201);
    const read = await app(w)(
      body(w, { resource: ownerResource, tool: 'readMail', maximumAutonomy: 'read_only' }),
    );
    expect(read.status).toBe(201);

    // Nada: no grant at all.
    expect((await evaluate(w, send.body.authorization.id, randomUUID())).decision).toEqual({
      allowed: false,
      reason: 'agent_has_no_active_grant',
    });

    // Ver: read packages, read_only — the read passes, the send cannot.
    await grant(w, ['read'], 'read_only');
    expect((await evaluate(w, read.body.authorization.id, randomUUID())).decision.allowed).toBe(
      true,
    );
    expect((await evaluate(w, send.body.authorization.id, randomUUID())).decision.allowed).toBe(
      false,
    );

    // Ver y actuar: every non-sensitive package, autonomous.
    await getDb()
      .update(delegationGrants)
      .set({ revokedAt: new Date() })
      .where(eq(delegationGrants.actorAccountId, w.agentId));
    await grant(w, ['read', 'communicate'], 'autonomous');
    expect((await evaluate(w, send.body.authorization.id, randomUUID())).decision.allowed).toBe(
      true,
    );
  });

  it('cannot turn a grant meant for direct requests into unattended effects', async () => {
    const w = await world();
    await grant(w, ['read', 'communicate'], 'execute_on_request');
    const created = await app(w)(
      body(w, {
        resource: {
          appId: w.appSlug,
          effectiveAccountId: w.ownerId,
          resourceType: 'account',
          resourceId: w.ownerId,
        },
      }),
    );
    expect(created.status).toBe(201);
    await expect(evaluate(w, created.body.authorization.id, randomUUID())).resolves.toEqual({
      decision: { allowed: false, reason: 'requested_autonomy_exceeds_effective_policy' },
    });
  });
});
