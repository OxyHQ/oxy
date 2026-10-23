jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn(), logSignIn: jest.fn() },
}));
jest.mock('../../server', () => ({ __esModule: true, emitSessionUpdate: jest.fn() }));
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import type { Request } from 'express';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
import { applications } from '../../db/schema/applications';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import {
  capabilityExecutionAuthorizations,
  appCapabilityCatalogRegistrations,
} from '../../db/schema/agency';
import { bindWorkloadIdentity } from '../workloadIdentityBinding.service';
import { registerFirstPartyCapabilityCatalog } from '../capabilityCatalog.service';
import { createFirstPartyTaskAuthorization } from '../firstPartyTaskAuthority.service';
import {
  evaluateCapabilityAuthority,
  reauthorizeCapabilityTicket,
} from '../capabilityAuthority.service';
import sessionService from '../session.service';
import { oxyProfileCapabilityCatalog } from '../../capabilities/oxy-profile.catalog';
const signing = generateKeyPairSync('ed25519');
const saved = { ...process.env };
beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET = 'own-task-test-secret';
  process.env.REFRESH_TOKEN_SECRET = 'own-task-refresh-test';
  process.env.DEVICE_ID_SALT = 'f'.repeat(48);
  process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = 'own-task-test';
  process.env.CAPABILITY_TICKET_SIGNING_PRIVATE_KEY = signing.privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  await connectPostgres();
});
afterAll(async () => {
  await closePostgres();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});
async function fixture() {
  const [owner, user, other, bot] = await insertAccountFixtures([{}, {}, {}, { kind: 'bot' }]);
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: 'Own task',
      ownerAccountId: owner.id,
      isOfficial: true,
      status: 'active',
      scopes: [],
      capabilities: [],
    })
    .returning();
  const { binding } = await bindWorkloadIdentity({
    applicationId: app.id,
    subject: `arn:aws:iam::237343248947:role/own-task-${randomUUID()}`,
    environment: 'development',
    actor: { isPlatformStaff: true, describedAs: 'test' },
  });
  const presenter = {
    authority: 'first_party' as const,
    applicationId: app.id,
    credentialId: binding.attestationId,
    ownerAccountId: owner.id,
    capabilities: [],
  };
  const session = await sessionService.createSession(user.id, { headers: {} } as Request, {
    deviceId: randomUUID(),
  });
  const catalog = oxyProfileCapabilityCatalog();
  catalog.appId = `own-${randomUUID()}`;
  catalog.tools = catalog.tools.map((tool) => ({
    ...tool,
    actors: ['alia', 'agent', 'requester'],
  }));
  const registration = await registerFirstPartyCapabilityCatalog({
    applicationId: app.id,
    catalog,
  });
  const input = {
    authority: 'first_party' as const,
    kind: 'direct_request' as const,
    actor: { type: 'agent' as const, accountId: bot.id },
    resource: {
      appId: catalog.appId,
      effectiveAccountId: user.id,
      resourceType: 'account',
      resourceId: user.id,
    },
    tool: 'readViewerGraph',
    expectedCatalog: {
      registrationId: registration.id,
      version: registration.version,
      digest: registration.digest,
    },
    runId: randomUUID(),
    limits: [],
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  return { owner, user, other, bot, app, presenter, session, registration, input };
}
async function issue(
  f: Awaited<ReturnType<typeof fixture>>,
  authorizationId: string,
  runId?: string,
) {
  return evaluateCapabilityAuthority(
    {
      executionAuthorizationId: authorizationId,
      authority: 'first_party',
      coordinator: { applicationId: f.app.id, credentialId: f.presenter.credentialId },
      expectedCatalog: f.input.expectedCatalog,
      ...(runId ? { runId } : {}),
    },
    { issueTicket: true },
  );
}
it('issues an own task for the original requester and distinct bot without any app grant or ceiling', async () => {
  const f = await fixture();
  const authorization = await createFirstPartyTaskAuthorization(
    f.input,
    f.session.accessToken,
    f.presenter,
  );
  expect(authorization).toMatchObject({
    authority: 'first_party',
    requesterAccountId: f.user.id,
    actorAccountId: f.bot.id,
    effectiveAccountId: f.user.id,
    ceilingId: null,
  });
  expect(JSON.stringify(authorization)).not.toContain(f.session.accessToken);
  const result = await issue(f, authorization.id);
  expect(result.decision.allowed).toBe(true);
  expect(result.claims).toMatchObject({
    authority: 'first_party',
    requesterAccountId: f.user.id,
    actor: { type: 'agent', accountId: f.bot.id },
    resource: { effectiveAccountId: f.user.id },
  });
  expect(result.claims).not.toHaveProperty('grantId');
  expect(result.claims).not.toHaveProperty('ceilingId');
  expect((await reauthorizeCapabilityTicket(result.claims!)).allowed).toBe(true);
  await sessionService.deactivateSession(f.session.sessionId);
  expect((await issue(f, authorization.id)).decision.allowed).toBe(false);
});
it('never promotes an external presenter or app-bound OAuth proof, or substitutes another account', async () => {
  const f = await fixture();
  await expect(
    createFirstPartyTaskAuthorization(f.input, f.session.accessToken, {
      ...f.presenter,
      authority: 'external',
      scopes: ['user:read'],
    }),
  ).rejects.toThrow();
  await expect(
    createFirstPartyTaskAuthorization(
      { ...f.input, resource: { ...f.input.resource, effectiveAccountId: f.other.id } },
      f.session.accessToken,
      f.presenter,
    ),
  ).rejects.toThrow();
  const [client] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: f.app.id,
      name: 'OAuth',
      type: 'public',
      environment: 'development',
      publicKey: `oxy_client_${randomUUID()}`,
      scopes: ['user:read'],
    })
    .returning();
  const externalSession = await sessionService.createSession(
    f.user.id,
    { headers: {} } as Request,
    {
      deviceId: randomUUID(),
      application: { applicationId: f.app.id, clientId: client.publicKey, scopes: ['user:read'] },
    },
  );
  await expect(
    createFirstPartyTaskAuthorization(f.input, externalSession.accessToken, f.presenter),
  ).rejects.toThrow();
});
it('keeps external and legacy tasks narrowed even when the owning app is marked own', async () => {
  const f = await fixture();
  const authorization = await createFirstPartyTaskAuthorization(
    f.input,
    f.session.accessToken,
    f.presenter,
  );
  expect(
    (
      await evaluateCapabilityAuthority({
        executionAuthorizationId: authorization.id,
        authority: 'external',
        coordinator: f.presenter,
      })
    ).decision.allowed,
  ).toBe(false);
  await getDb()
    .update(capabilityExecutionAuthorizations)
    .set({
      authority: 'external',
      requesterSessionId: null,
      requesterSessionBindingDigest: null,
      requesterCatalogRegistrationId: null,
      requesterCatalogVersion: null,
      requesterCatalogDigest: null,
    })
    .where(eq(capabilityExecutionAuthorizations.id, authorization.id));
  expect((await issue(f, authorization.id)).decision.allowed).toBe(false);
});
it('retains a scheduled task original requester after signout, but revokes the task immediately', async () => {
  const f = await fixture();
  const { runId, stepId, ...base } = f.input;
  const authorization = await createFirstPartyTaskAuthorization(
    {
      ...base,
      kind: 'automation',
      automationId: randomUUID(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
    f.session.accessToken,
    f.presenter,
  );
  await sessionService.deactivateSession(f.session.sessionId);
  const result = await issue(f, authorization.id, randomUUID());
  expect(result.decision.allowed).toBe(true);
  expect(result.claims?.requesterAccountId).toBe(f.user.id);
  await getDb()
    .update(capabilityExecutionAuthorizations)
    .set({ revokedAt: new Date() })
    .where(eq(capabilityExecutionAuthorizations.id, authorization.id));
  expect((await reauthorizeCapabilityTicket(result.claims!)).allowed).toBe(false);
});
it('rejects stale catalogue provenance or a demoted catalogue owner', async () => {
  const f = await fixture();
  const authorization = await createFirstPartyTaskAuthorization(
    f.input,
    f.session.accessToken,
    f.presenter,
  );
  await getDb()
    .update(appCapabilityCatalogRegistrations)
    .set({ source: 'credential', registeredByCredentialId: f.presenter.credentialId })
    .where(eq(appCapabilityCatalogRegistrations.id, f.registration.id));
  expect((await issue(f, authorization.id)).decision.allowed).toBe(false);
});

it('derives background tools and child actors from one durable task, preserving requester and revocation', async () => {
  const { createFirstPartyTask, revokeFirstPartyTask } = await import('../firstPartyTasks.service');
  const f = await fixture();
  const task = await createFirstPartyTask(
    {
      origin: { kind: 'goal', id: randomUUID() },
      actor: f.input.actor,
      effectiveAccountId: f.user.id,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
    f.session.accessToken,
    f.presenter,
  );
  const [child] = await insertAccountFixtures({ kind: 'bot' });
  await sessionService.deactivateSession(f.session.sessionId);
  const authorization = await createFirstPartyTaskAuthorization(
    { ...f.input, actor: { type: 'agent', accountId: child.id } },
    '',
    f.presenter,
    task.id,
  );
  expect(authorization).toMatchObject({
    taskId: task.id,
    requesterAccountId: f.user.id,
    effectiveAccountId: f.user.id,
    actorAccountId: child.id,
  });
  const result = await issue(f, authorization.id);
  expect(result.decision.allowed).toBe(true);
  expect(result.claims?.taskId).toBe(task.id);
  await expect(
    createFirstPartyTaskAuthorization(
      { ...f.input, resource: { ...f.input.resource, effectiveAccountId: f.other.id } },
      '',
      f.presenter,
      task.id,
    ),
  ).rejects.toThrow();
  await revokeFirstPartyTask(task.id, f.presenter);
  expect((await reauthorizeCapabilityTicket(result.claims!)).allowed).toBe(false);
  await expect(
    createFirstPartyTaskAuthorization(f.input, '', f.presenter, task.id),
  ).rejects.toThrow();
});

it('requires a live external OAuth grant even for an official application or after reclassification', async () => {
  const { validateForegroundRequesterBearer } = await import(
    '../foregroundCapabilityRequester.service'
  );
  const { appGrants } = await import('../../db/schema/appGrants');
  const f = await fixture();
  await getDb()
    .update(applications)
    .set({ scopes: ['user:read'] })
    .where(eq(applications.id, f.app.id));
  const [client] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: f.app.id,
      name: 'OAuth',
      type: 'public',
      environment: 'development',
      publicKey: `oxy_client_${randomUUID()}`,
      scopes: ['user:read'],
    })
    .returning();
  const session = await sessionService.createSession(f.user.id, { headers: {} } as Request, {
    deviceId: randomUUID(),
    application: { applicationId: f.app.id, clientId: client.publicKey, scopes: ['user:read'] },
  });
  const external = { ...f.presenter, authority: 'external' as const, scopes: ['user:read'] };
  expect(await validateForegroundRequesterBearer(session.accessToken, external)).toBeNull();
  await getDb()
    .update(applications)
    .set({ isOfficial: false, isInternal: false, type: 'third_party' })
    .where(eq(applications.id, f.app.id));
  expect(await validateForegroundRequesterBearer(session.accessToken, external)).toBeNull();
  await getDb()
    .insert(appGrants)
    .values({ applicationId: f.app.id, userId: f.user.id, scopes: ['user:read'] });
  expect(await validateForegroundRequesterBearer(session.accessToken, external)).toMatchObject({
    subjectAccountId: f.user.id,
  });
  await getDb().delete(appGrants).where(eq(appGrants.applicationId, f.app.id));
  await getDb().update(applications).set({ isOfficial: true }).where(eq(applications.id, f.app.id));
  expect(await validateForegroundRequesterBearer(session.accessToken, external)).toBeNull();
});
it('binds self tools to the root bot and current operator membership, never a substituted child', async () => {
  const { createFirstPartyTask } = await import('../firstPartyTasks.service');
  const { accountMembers } = await import('../../db/schema/accountMembers');
  const f = await fixture();
  const [child] = await insertAccountFixtures({ kind: 'bot' });
  await getDb()
    .insert(accountMembers)
    .values([
      { accountId: f.bot.id, memberUserId: f.user.id, role: 'admin', status: 'active' },
      { accountId: child.id, memberUserId: f.user.id, role: 'admin', status: 'active' },
    ]);
  const task = await createFirstPartyTask(
    {
      origin: { kind: 'goal', id: randomUUID() },
      actor: f.input.actor,
      effectiveAccountId: f.user.id,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
    f.session.accessToken,
    f.presenter,
  );
  const selfInput = {
    ...f.input,
    resource: { ...f.input.resource, effectiveAccountId: f.bot.id, resourceId: f.bot.id },
  };
  const auth = await createFirstPartyTaskAuthorization(selfInput, '', f.presenter, task.id);
  expect(auth.effectiveAccountId).toBe(f.bot.id);
  await expect(
    createFirstPartyTaskAuthorization(
      {
        ...selfInput,
        actor: { type: 'agent', accountId: child.id },
        resource: { ...selfInput.resource, effectiveAccountId: child.id, resourceId: child.id },
      },
      '',
      f.presenter,
      task.id,
    ),
  ).rejects.toThrow();
  const result = await issue(f, auth.id);
  expect(result.decision.allowed).toBe(true);
  await getDb().delete(accountMembers).where(eq(accountMembers.accountId, f.bot.id));
  expect((await reauthorizeCapabilityTicket(result.claims!)).allowed).toBe(false);
});
