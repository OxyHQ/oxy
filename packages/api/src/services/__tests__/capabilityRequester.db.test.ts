/** Real recipient workload, original durable task and downstream HTTP boundaries. */
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn(), logSignIn: jest.fn() },
}));
jest.mock('../../server', () => ({ emitSessionUpdate: jest.fn() }));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
const mockUpload = jest.fn(async (..._args: unknown[]) => ({
  file: { id: 'operation-file', sha256: 'hash', size: 4, mime: 'image/png', visibility: 'private' },
  deduplicated: false,
}));
jest.mock('../assetServiceSingleton', () => ({
  assetService: { uploadUserMediaStreamDetailed: (...args: unknown[]) => mockUpload(...args) },
  s3Service: {},
}));
jest.mock('../fileAccessGrant.service', () => ({
  ...jest.requireActual('../fileAccessGrant.service'),
  grantUploadAccess: jest.fn(),
}));
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import express, { type Request } from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { signServiceTokenEd25519 } from '../../config/serviceTokenSigning';
import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
import { applications } from '../../db/schema/applications';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { firstPartyTasks } from '../../db/schema/agency';
import { bindWorkloadIdentity } from '../workloadIdentityBinding.service';
import { registerFirstPartyCapabilityCatalog } from '../capabilityCatalog.service';
import { createFirstPartyTaskAuthorization } from '../firstPartyTaskAuthority.service';
import { createFirstPartyTask, revokeFirstPartyTask } from '../firstPartyTasks.service';
import { evaluateCapabilityAuthority } from '../capabilityAuthority.service';
import { resolveCapabilityRequester } from '../capabilityRequester.service';
import { resolveServiceRequester } from '../serviceRequester.service';
import sessionService from '../session.service';
import { oxyProfileCapabilityCatalog } from '../../capabilities/oxy-profile.catalog';
import assetsRouter from '../../routes/assets';
import privacyRouter from '../../routes/privacy';
import supervisionRouter from '../../routes/supervision';
import internalRouter from '../../routes/internal';
import { errorHandler } from '../../middleware/errorHandler';
const app = express();
app.use(express.json());
app.use('/assets', assetsRouter);
app.use('/privacy', privacyRouter);
app.use('/safety', supervisionRouter);
app.use('/internal', internalRouter);
app.use(errorHandler);
const signing = generateKeyPairSync('ed25519');
const saved = { ...process.env };
beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET = 'own-operation-test-secret';
  process.env.REFRESH_TOKEN_SECRET = 'own-operation-refresh-test';
  process.env.DEVICE_ID_SALT = 'f'.repeat(48);
  process.env.CAPABILITY_TICKET_SIGNING_KEY_ID = 'own-operation-test';
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
async function fixture(effect: 'read' | 'write' = 'read') {
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
    actors: effect === 'read' ? ['alia', 'agent', 'requester'] : ['alia', 'agent'],
    effect,
    idempotency: effect === 'read' ? 'none' : 'supported',
    invocation: { ...tool.invocation, method: effect === 'read' ? tool.invocation.method : 'POST' },
  }));
  const [receiverApp] = await getDb()
    .insert(applications)
    .values({
      name: 'Operation recipient',
      ownerAccountId: owner.id,
      isOfficial: true,
      status: 'active',
      scopes: [],
      capabilities: [],
    })
    .returning();
  const { binding: receiverBinding } = await bindWorkloadIdentity({
    applicationId: receiverApp.id,
    subject: `arn:aws:iam::237343248947:role/recipient-${randomUUID()}`,
    environment: 'development',
    actor: { isPlatformStaff: true, describedAs: 'test' },
  });
  const receiver = {
    ...presenter,
    applicationId: receiverApp.id,
    credentialId: receiverBinding.attestationId,
  };
  const registration = await registerFirstPartyCapabilityCatalog({
    applicationId: receiverApp.id,
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
  const task = await createFirstPartyTask(
    {
      origin: { kind: 'goal', id: randomUUID() },
      actor: input.actor,
      effectiveAccountId: user.id,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
    session.accessToken,
    presenter,
  );
  const authorization = await createFirstPartyTaskAuthorization(input, '', presenter, task.id);
  const base = { owner, user, other, bot, app, presenter, session, registration, input };
  const result = await issue(base, authorization.id);
  expect(result.decision.allowed).toBe(true);
  const serviceToken = (principal = receiver) =>
    signServiceTokenEd25519({
      type: 'service',
      authority: 'first_party',
      appId: principal.applicationId,
      appName: 'Operation recipient',
      credentialId: principal.credentialId,
      ownerAccountId: owner.id,
      environment: 'development',
      tier: 'internal',
      iss: 'oxy-auth',
      aud: 'oxy-api',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    })!;
  return {
    ...base,
    receiver,
    receiverBinding,
    task,
    authorization,
    ticket: result.ticket!,
    claims: result.claims!,
    serviceToken,
  };
}
async function issue(
  f: {
    app: { id: string };
    presenter: { credentialId: string };
    input: { expectedCatalog: { registrationId: string; version: string; digest: string } };
  },
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

it('preserves original requester, actor, resource and limits only for the registered recipient', async () => {
  const f = await fixture();
  await sessionService.deactivateSession(f.session.sessionId);
  expect(await resolveCapabilityRequester(f.ticket, f.receiver)).toMatchObject({
    principalAccountId: f.user.id,
    subjectAccountId: f.user.id,
    operation: {
      receiverApplicationId: f.receiver.applicationId,
      claims: {
        requesterAccountId: f.user.id,
        actor: f.input.actor,
        resource: f.input.resource,
        limits: [],
        taskId: f.task.id,
      },
    },
  });
  expect(await resolveCapabilityRequester(f.ticket, f.presenter)).toBeNull();
  expect(
    await resolveCapabilityRequester(f.ticket, {
      ...f.receiver,
      authority: 'external',
      scopes: ['user:read'],
    }),
  ).toBeNull();
  await expect(
    resolveServiceRequester(f.receiver, {
      'x-oxy-capability-ticket': f.ticket,
      'x-oxy-user-id': f.other.id,
    }),
  ).rejects.toThrow();
  await expect(
    resolveServiceRequester(f.receiver, {
      'x-oxy-capability-ticket': f.ticket,
      'x-oxy-task-id': f.task.id,
    }),
  ).rejects.toThrow();
  await revokeFirstPartyTask(f.task.id, f.presenter);
  expect(await resolveCapabilityRequester(f.ticket, f.receiver)).toBeNull();
});
it('allows a read operation to obtain Safety policy via semantic POST but denies nested writes and session exchange', async () => {
  const f = await fixture();
  const headers = {
    Authorization: `Bearer ${f.serviceToken()}`,
    'X-Oxy-Capability-Ticket': f.ticket,
  };
  const safety = await request(app)
    .post('/safety/service/profile-access')
    .set('Authorization', headers.Authorization)
    .send({ input: { subjectAccountId: f.user.id }, requester: { capabilityTicket: f.ticket } });
  expect(safety.status).toBe(200);
  expect(safety.body).toMatchObject({ allowed: true });
  expect((await request(app).get('/privacy/blocked').set(headers)).status).toBe(200);
  expect(
    (
      await request(app)
        .post('/assets/service/user-media')
        .set(headers)
        .set('x-owner-user-id', f.user.id)
        .set('Content-Type', 'image/png')
        .send(Buffer.from('test'))
    ).status,
  ).toBe(403);
  expect(
    (
      await request(app)
        .post(`/internal/accounts/${f.bot.id}/service-switch`)
        .set(headers)
        .send({ targetAccountId: f.bot.id })
    ).status,
  ).toBe(403);
});
it('permits the write operation own-account Files effect and denies substituted account, receiver, revocation and expiry', async () => {
  const f = await fixture('write');
  const upload = (owner = f.user.id, token = f.serviceToken()) =>
    request(app)
      .post('/assets/service/user-media')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Oxy-Capability-Ticket', f.ticket)
      .set('x-owner-user-id', owner)
      .set('Content-Type', 'image/png')
      .send(Buffer.from('test'));
  const before = mockUpload.mock.calls.length;
  expect((await upload()).status).toBe(200);
  expect(mockUpload.mock.calls.length).toBe(before + 1);
  expect((await upload(f.other.id)).status).toBe(403);
  expect((await upload(f.user.id, f.serviceToken(f.presenter))).status).toBe(403);
  expect(
    (
      await request(app)
        .post(`/internal/accounts/${f.bot.id}/service-switch`)
        .set('Authorization', `Bearer ${f.serviceToken()}`)
        .set('X-Oxy-Capability-Ticket', f.ticket)
        .send({ targetAccountId: f.bot.id })
    ).status,
  ).toBe(403);
  await revokeFirstPartyTask(f.task.id, f.presenter);
  expect((await upload()).status).toBe(403);
  const expired = await fixture('write');
  await getDb()
    .update(firstPartyTasks)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(firstPartyTasks.id, expired.task.id));
  expect(await resolveCapabilityRequester(expired.ticket, expired.receiver)).toBeNull();
  expect(mockUpload.mock.calls.length).toBe(before + 1);
});
it('checks live workload and catalogue ownership before a downstream operation', async () => {
  const f = await fixture();
  await getDb()
    .delete(applicationWorkloadIdentities)
    .where(eq(applicationWorkloadIdentities.id, f.receiverBinding.id));
  const response = await request(app)
    .get('/privacy/blocked')
    .set('Authorization', `Bearer ${f.serviceToken()}`)
    .set('X-Oxy-Capability-Ticket', f.ticket);
  expect(response.status).toBe(401);
});
