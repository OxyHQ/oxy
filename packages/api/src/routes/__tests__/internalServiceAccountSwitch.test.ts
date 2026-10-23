const mockFileImport = jest.fn();
jest.mock('../../services/fileIngestSingleton', () => ({
  fileImportService: { importFromUrl: (...args: unknown[]) => mockFileImport(...args) },
  fileIngestService: {},
}));
/** Real HTTP, signing, Postgres, membership and session authority. */
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: jest.fn(),
  broadcastSessionAccountsChanged: jest.fn(),
}));
jest.mock('../../server', () => ({ emitSessionUpdate: jest.fn() }));
import express, { type Request } from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { signServiceTokenEd25519 } from '../../config/serviceTokenSigning';
import { insertAccountFixtures } from '../../db/__fixtures__/accountIdentity';
import { accountMembers } from '../../db/schema/accountMembers';
import { appGrants } from '../../db/schema/appGrants';
import { applications } from '../../db/schema/applications';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { sessions } from '../../db/schema/sessions';
import { users } from '../../db/schema/users';
import { bindWorkloadIdentity } from '../../services/workloadIdentityBinding.service';
import { createFirstPartyTask, revokeFirstPartyTask } from '../../services/firstPartyTasks.service';
import sessionService from '../../services/session.service';
import { errorHandler } from '../../middleware/errorHandler';
import internalRouter from '../internal';
import assetsRouter from '../assets';
const app = express();
app.use(express.json());
app.use('/internal', internalRouter);
app.use('/assets', assetsRouter);
app.use(errorHandler);
const saved = { ...process.env };
beforeAll(async () => {
  process.env.ACCESS_TOKEN_SECRET = 'switch-own-test-access-secret';
  process.env.REFRESH_TOKEN_SECRET = 'switch-own-test-refresh-secret';
  process.env.DEVICE_ID_SALT = 'switch-own-test-device-id-salt-48chars';
  await connectPostgres();
});
afterAll(async () => {
  await closePostgres();
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});
async function fixture() {
  const [owner, user, other, bot, otherBot] = await insertAccountFixtures([
    {},
    {},
    {},
    { kind: 'bot' },
    { kind: 'bot' },
  ]);
  const [application] = await getDb()
    .insert(applications)
    .values({
      name: 'Own switch',
      ownerAccountId: owner.id,
      isOfficial: true,
      status: 'active',
      scopes: [],
      capabilities: [],
    })
    .returning();
  const { binding } = await bindWorkloadIdentity({
    applicationId: application.id,
    subject: `arn:aws:iam::237343248947:role/own-switch-${randomUUID()}`,
    environment: 'development',
    actor: { isPlatformStaff: true, describedAs: 'test' },
  });
  await getDb()
    .insert(accountMembers)
    .values([
      { accountId: bot.id, memberUserId: user.id, role: 'admin', status: 'active' },
      { accountId: otherBot.id, memberUserId: user.id, role: 'admin', status: 'active' },
    ]);
  const session = await sessionService.createSession(user.id, { headers: {} } as Request, {
    deviceId: randomUUID(),
  });
  const claims = {
    type: 'service',
    authority: 'first_party',
    appId: application.id,
    appName: 'Own switch',
    credentialId: binding.attestationId,
    ownerAccountId: owner.id,
    environment: 'development',
    tier: 'internal',
    iss: 'oxy-auth',
    aud: 'oxy-api',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const token = signServiceTokenEd25519(claims);
  const presenter = {
    authority: 'first_party' as const,
    applicationId: application.id,
    credentialId: binding.attestationId,
    ownerAccountId: owner.id,
    capabilities: [],
  };
  return {
    owner,
    user,
    other,
    bot,
    otherBot,
    application,
    binding,
    session,
    claims,
    token,
    presenter,
  };
}
async function rows(userId: string) {
  return getDb().select().from(sessions).where(eq(sessions.userId, userId));
}
function call(f: Awaited<ReturnType<typeof fixture>>, target = f.bot.id) {
  return request(app)
    .post(`/internal/accounts/${target}/service-switch`)
    .set('Authorization', `Bearer ${f.token}`);
}
it('switches with verified requester proof, no grants/scopes, recording the real operator and ignoring a forged header', async () => {
  const f = await fixture();
  const response = await call(f)
    .set('X-Oxy-Requester-Token', f.session.accessToken)
    .set('X-Oxy-User-Id', f.other.id);
  expect(response.status).toBe(200);
  expect(
    jwt.verify(response.body.data.accessToken, process.env.ACCESS_TOKEN_SECRET!),
  ).toMatchObject({ sub: f.bot.id, act: { sub: f.user.id } });
  const first = await rows(f.bot.id);
  expect(first).toHaveLength(1);
  expect(first[0].operatedByUserId).toBe(f.user.id);
  expect((await call(f).set('X-Oxy-Requester-Token', f.session.accessToken)).status).toBe(200);
  expect(await rows(f.bot.id)).toHaveLength(1);
  await getDb()
    .delete(accountMembers)
    .where(and(eq(accountMembers.accountId, f.bot.id), eq(accountMembers.memberUserId, f.user.id)));
  expect((await call(f).set('X-Oxy-Requester-Token', f.session.accessToken)).status).toBe(403);
  expect(
    await sessionService.validateSessionById(first[0].sessionId, true, { useCache: false }),
  ).toBeNull();
});
it('rejects raw account headers, missing proof and logged out proof before minting', async () => {
  const f = await fixture();
  expect((await call(f).set('X-Oxy-User-Id', f.user.id)).status).toBe(400);
  await sessionService.deactivateSession(f.session.sessionId);
  expect((await call(f).set('X-Oxy-Requester-Token', f.session.accessToken)).status).toBe(403);
  expect(await rows(f.bot.id)).toEqual([]);
});
it('cannot elevate an external key even for an official application with every former grant', async () => {
  const f = await fixture();
  const scopes = ['user:read', 'accounts:act-as-session', 'acting-as:offline'];
  await getDb().update(applications).set({ scopes }).where(eq(applications.id, f.application.id));
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: f.application.id,
      name: 'external',
      type: 'service',
      environment: 'development',
      publicKey: `oxy_dk_${randomUUID()}`,
      scopes,
    })
    .returning();
  await getDb()
    .insert(appGrants)
    .values({ applicationId: f.application.id, userId: f.user.id, scopes });
  const externalToken = signServiceTokenEd25519({
    ...f.claims,
    authority: 'external',
    credentialId: credential.id,
    scopes,
  });
  const response = await call({ ...f, token: externalToken }).set('X-Oxy-User-Id', f.user.id);
  expect(response.status).toBe(403);
  expect(await rows(f.bot.id)).toEqual([]);
});
it('refuses expired workload, owner/environment mismatch and a now untrusted application', async () => {
  const f = await fixture();
  for (const changed of [{ ownerAccountId: f.other.id }, { environment: 'production' }]) {
    expect([401, 403]).toContain(
      (
        await call({ ...f, token: signServiceTokenEd25519({ ...f.claims, ...changed }) }).set(
          'X-Oxy-Requester-Token',
          f.session.accessToken,
        )
      ).status,
    );
  }
  await getDb()
    .update(applicationWorkloadIdentities)
    .set({ expiresAt: new Date(0) })
    .where(eq(applicationWorkloadIdentities.id, f.binding.id));
  expect((await call(f).set('X-Oxy-Requester-Token', f.session.accessToken)).status).toBe(401);
  await getDb()
    .update(applicationWorkloadIdentities)
    .set({ expiresAt: null })
    .where(eq(applicationWorkloadIdentities.id, f.binding.id));
  await getDb()
    .update(applications)
    .set({ isOfficial: false, isInternal: false, type: 'third_party' })
    .where(eq(applications.id, f.application.id));
  expect((await call(f).set('X-Oxy-Requester-Token', f.session.accessToken)).status).toBe(401);
  expect(await rows(f.bot.id)).toEqual([]);
});
it('retains account permissions and target-kind/active checks', async () => {
  const f = await fixture();
  await getDb()
    .update(accountMembers)
    .set({ role: 'viewer' })
    .where(eq(accountMembers.accountId, f.bot.id));
  expect((await call(f).set('X-Oxy-Requester-Token', f.session.accessToken)).status).toBe(403);
  expect(
    (await call(f, f.user.id).set('X-Oxy-Requester-Token', f.session.accessToken)).status,
  ).toBe(403);
  await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, f.bot.id));
  expect((await call(f).set('X-Oxy-Requester-Token', f.session.accessToken)).status).toBe(404);
  expect(await rows(f.bot.id)).toEqual([]);
});
it('uses a durable root task after logout, but only for its exact self bot and until revocation', async () => {
  const f = await fixture();
  const task = await createFirstPartyTask(
    {
      origin: { kind: 'goal', id: randomUUID() },
      actor: { type: 'agent', accountId: f.bot.id },
      effectiveAccountId: f.user.id,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
    f.session.accessToken,
    f.presenter,
  );
  await sessionService.deactivateSession(f.session.sessionId);
  expect((await call(f).set('X-Oxy-Task-Id', task.id)).status).toBe(200);
  expect((await call(f, f.otherBot.id).set('X-Oxy-Task-Id', task.id)).status).toBe(403);
  await revokeFirstPartyTask(task.id, f.presenter);
  expect((await call(f).set('X-Oxy-Task-Id', task.id)).status).toBe(403);
});
it('verifies task/requester attribution for a receiving workload without scope projection', async () => {
  const f = await fixture();
  const verify = (userId: string) =>
    request(app)
      .get('/internal/service-acting-as/verify')
      .query({
        appId: f.application.id,
        userId,
        credentialId: f.binding.attestationId,
        ownerAccountId: f.owner.id,
        environment: 'development',
      })
      .set('Authorization', `Bearer ${f.token}`)
      .set('X-Oxy-Requester-Token', f.session.accessToken);
  const good = await verify(f.user.id);
  expect(good.status).toBe(200);
  expect(good.body.data).toMatchObject({ authorized: true, authority: 'first_party' });
  expect(good.body.data).not.toHaveProperty('scopes');
  expect((await verify(f.other.id)).body.data.authorized).toBe(false);
});

it('Files accepts only an explicitly selected root self bot, its operator and its original task', async () => {
  const f = await fixture();
  const task = await createFirstPartyTask(
    {
      origin: { kind: 'goal', id: randomUUID() },
      actor: { type: 'agent', accountId: f.bot.id },
      effectiveAccountId: f.user.id,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
    f.session.accessToken,
    f.presenter,
  );
  mockFileImport.mockResolvedValue({
    file: {
      id: 'imported',
      sha256: 'hash',
      size: 1,
      mime: 'image/png',
      visibility: 'private',
      status: 'active',
    },
    source: { host: 'source.example', fetchedAt: new Date(), etag: null, lastModified: null },
    outcome: 'downloaded',
    deduplicated: false,
  });
  const upload = (owner: string, selected?: string) => {
    const pending = request(app)
      .post('/assets/service/user-media/import')
      .set('Authorization', `Bearer ${f.token}`)
      .set('X-Oxy-Task-Id', task.id)
      .set('x-owner-user-id', owner)
      .send({ sourceUrl: 'https://source.example/image.png', visibility: 'private' });
    if (selected) pending.set('X-Oxy-User-Id', selected);
    return pending;
  };
  expect((await upload(f.bot.id, f.bot.id)).status).toBe(200);
  expect(mockFileImport).toHaveBeenLastCalledWith(
    { kind: 'account', userId: f.bot.id },
    expect.anything(),
    f.application.id,
  );
  expect((await upload(f.bot.id)).status).toBe(403);
  expect((await upload(f.otherBot.id, f.otherBot.id)).status).toBe(403);
  await getDb().delete(accountMembers).where(eq(accountMembers.accountId, f.bot.id));
  expect((await upload(f.bot.id, f.bot.id)).status).toBe(403);
  // A public bot's requester cannot borrow the bot owner's privilege.
  expect(mockFileImport).toHaveBeenCalledTimes(1);
  expect((await upload(f.user.id)).status).toBe(200);
  await revokeFirstPartyTask(task.id, f.presenter);
  expect((await upload(f.user.id)).status).toBe(403);
  expect(mockFileImport).toHaveBeenCalledTimes(2);
});
