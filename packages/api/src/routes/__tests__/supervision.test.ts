import express from 'express';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { ServiceTokenPayload } from '../../middleware/serviceToken';
let mockServiceToken: ServiceTokenPayload | undefined;
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../server', () => ({ emitSessionUpdate: jest.fn() }));
jest.mock('../../utils/socket', () => ({
  broadcastDeviceState: jest.fn(),
  broadcastSessionAccountsChanged: jest.fn(),
}));
jest.mock('../../services/securityActivityService', () => ({
  __esModule: true,
  default: { logDeviceAdded: jest.fn() },
}));
jest.mock('../../middleware/auth', () => {
  const actual = jest.requireActual('../../middleware/auth');
  return {
    ...actual,
    serviceAuthMiddleware: (
      req: { serviceApp?: ServiceTokenPayload },
      res: unknown,
      next: () => void,
    ) => {
      if (!mockServiceToken) return actual.serviceAuthMiddleware(req, res, next);
      req.serviceApp = mockServiceToken;
      next();
    },
  };
});
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
import router from '../supervision';
import { accountService } from '../../services/account.service';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users, applications, applicationCredentials, sessions } from '../../db/schema';
import sessionService from '../../services/session.service';
import { inviteGuardian, acceptInvitation } from '../../services/supervision.service';
let server: http.Server;
beforeAll(async () => {
  await connectPostgres();
  process.env.DEVICE_ID_SALT = 's'.repeat(48);
  const app = express();
  app.use(express.json());
  app.use('/safety', router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await closePostgres();
});
afterEach(() => {
  mockServiceToken = undefined;
});
async function person() {
  const [row] = await getDb()
    .insert(users)
    .values({ kind: 'personal', privacyProfileVisibility: true })
    .returning({ id: users.id });
  return row.id;
}
async function consumer() {
  const owner = await person();
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: 'Safety reviewer',
      ownerAccountId: owner,
      type: 'first_party',
      scopes: ['safety:decide'],
      capabilities: ['safety:profile:v1', 'safety:content:v1'],
    })
    .returning({ id: applications.id });
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: app.id,
      name: 'Safety service',
      type: 'service',
      environment: 'production',
      publicKey: `oxy_dk_${randomUUID()}`,
      secretHash: 'testhash',
    })
    .returning({ id: applicationCredentials.id });
  mockServiceToken = {
    type: 'service',
    appId: app.id,
    appName: 'Safety reviewer',
    credentialId: credential.id,
    ownerAccountId: owner,
    environment: 'production',
    tier: 'internal',
    scopes: ['safety:decide'],
  };
  return { app: app.id, credential: credential.id };
}
async function session(account: string) {
  return sessionService.createSession(
    account,
    { headers: { 'user-agent': 'Safety test' }, ip: '127.0.0.1', get: () => undefined } as never,
    { deviceId: randomUUID() },
  );
}
async function post(path: string, body: unknown) {
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/safety${path}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  return { status: response.status, body: await response.json() };
}
it('requires actual bearer proof, exact session and consumer binding, then live action authority', async () => {
  const c = await consumer(),
    child = await person(),
    guardian = await person();
  await acceptInvitation((await inviteGuardian(child, guardian)).id, guardian);
  const current = await session(child),
    input = { sessionId: current.sessionId, accessToken: current.accessToken, action: 'content' };
  expect((await post('/service/session', { ...input, accessToken: 'forged' })).status).toBe(401);
  expect((await post('/service/session', { ...input, sessionId: randomUUID() })).status).toBe(401);
  const good = await post('/service/session', input);
  expect(good.status).toBe(200);
  expect(good.body.user.id).toBe(child);
  const [otherApp] = await getDb()
    .insert(applications)
    .values({ name: 'Other consumer', ownerAccountId: guardian })
    .returning({ id: applications.id });
  await getDb()
    .update(sessions)
    .set({ applicationId: otherApp.id })
    .where(eq(sessions.sessionId, current.sessionId));
  expect((await post('/service/session', input)).status).toBe(403);
  await getDb()
    .update(sessions)
    .set({ applicationId: c.app })
    .where(eq(sessions.sessionId, current.sessionId));
  await getDb().update(applications).set({ capabilities: [] }).where(eq(applications.id, c.app));
  expect((await post('/service/session', input)).status).toBe(403);
  await getDb()
    .update(applicationCredentials)
    .set({ status: 'revoked' })
    .where(eq(applicationCredentials.id, c.credential));
  expect(
    (
      await post('/service/profile-access-batch', {
        input: { subjectAccountIds: [child] },
        requester: { accessToken: null },
      })
    ).status,
  ).toBe(403);
});
it('keeps ordinary adults and explicit anonymous public policy reads valid without granting impersonation', async () => {
  await consumer();
  const adult = await person(),
    current = await session(adult);
  expect(
    (
      await post('/service/session', {
        sessionId: current.sessionId,
        accessToken: current.accessToken,
        action: 'content',
      })
    ).status,
  ).toBe(200);
  const input = { subjectAccountIds: [adult] };
  const anonymous = await post('/service/profile-access-batch', {
    input,
    requester: { accessToken: null },
  });
  expect(anonymous.status).toBe(200);
  expect(anonymous.body.items[0].decision.allowed).toBe(true);
  expect(
    (
      await post('/service/profile-access-batch', {
        input,
        requester: { accessToken: null, viewerId: adult },
      })
    ).status,
  ).toBe(422);
});


it('preserves a live authorized ordinary organization actor and revokes it when its human principal enrolls',async()=>{
 await consumer();const operator=await person(),guardian=await person();
 const {account}=await accountService.createChildAccount(operator,operator,{kind:'organization',username:`org${randomUUID().replaceAll('-','').slice(0,16)}`});
 const current=await sessionService.createSession(account.id,{headers:{'user-agent':'Safety test'},ip:'127.0.0.1',get:()=>undefined} as never,{deviceId:randomUUID(),operatedByUserId:operator});
 const input={sessionId:current.sessionId,accessToken:current.accessToken,action:'profile'};
 const result=await post('/service/session',input);
 expect(result.status).toBe(200);
 expect(result.body.actor).toMatchObject({effectiveAccountId:account.id,actorAccountId:operator});
 await acceptInvitation((await inviteGuardian(operator,guardian)).id,guardian);
 expect((await post('/service/session',input)).status).toBe(401);
});
