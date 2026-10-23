import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications, users, applicationWorkloadIdentities } from '../../db/schema';
import { bindWorkloadIdentity } from '../../services/workloadIdentityBinding.service';
import { mintServiceToken } from '../../services/serviceTokenMint.service';
import router from '../resourceIntrospection';
import { errorHandler } from '../../middleware/errorHandler';
const server = express().use(express.json()).use(router).use(errorHandler);
beforeAll(connectPostgres);
afterAll(closePostgres);
async function identity() {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning();
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: 'Own receiver test',
      ownerAccountId: owner.id,
      status: 'active',
      isOfficial: true,
      scopes: [],
    })
    .returning();
  const { binding } = await bindWorkloadIdentity({
    applicationId: app.id,
    subject: `arn:aws:iam::237343248947:role/test-${randomUUID()}`,
    environment: 'development',
    actor: { isPlatformStaff: true, describedAs: 'test' },
  });
  const claims = {
    appId: app.id,
    appName: app.name,
    credentialId: binding.attestationId,
    ownerAccountId: owner.id,
    environment: 'development' as const,
    tier: 'internal' as const,
    authority: 'first_party' as const,
  };
  return { app, owner, binding, claims, token: mintServiceToken(claims) };
}
it('introspects exact receiver audience with live identity and no scope grants', async () => {
  const caller = await identity();
  const receiver = await identity();
  const token = mintServiceToken(caller.claims, `oxy-service:${receiver.app.id}`);
  const result = await request(server)
    .post('/introspect')
    .auth(receiver.token, { type: 'bearer' })
    .send({ token });
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({
    active: true,
    authority: 'first_party',
    applicationId: caller.app.id,
    accountId: caller.owner.id,
    audience: `oxy-service:${receiver.app.id}`,
  });
  expect(result.body).not.toHaveProperty('scopes');
  await getDb()
    .delete(applicationWorkloadIdentities)
    .where(eq(applicationWorkloadIdentities.id, caller.binding.id));
  expect(
    (
      await request(server)
        .post('/introspect')
        .auth(receiver.token, { type: 'bearer' })
        .send({ token })
    ).body.active,
  ).toBe(false);
});
it('refuses receiver substitution, wrong environment and external promotion', async () => {
  const caller = await identity();
  const receiver = await identity();
  const other = await identity();
  const audience = `oxy-service:${receiver.app.id}` as const;
  const own = mintServiceToken(caller.claims, audience);
  expect(
    (
      await request(server)
        .post('/introspect')
        .auth(other.token, { type: 'bearer' })
        .send({ token: own })
    ).body.active,
  ).toBe(false);
  const environment = mintServiceToken({ ...caller.claims, environment: 'production' }, audience);
  expect(
    (
      await request(server)
        .post('/introspect')
        .auth(receiver.token, { type: 'bearer' })
        .send({ token: environment })
    ).body.active,
  ).toBe(false);
  const external = mintServiceToken(
    { ...caller.claims, authority: 'external', scopes: ['user:read'] },
    audience,
  );
  expect(
    (
      await request(server)
        .post('/introspect')
        .auth(receiver.token, { type: 'bearer' })
        .send({ token: external })
    ).body.active,
  ).toBe(false);
});
it('revokes the receiver identity itself immediately', async () => {
  const receiver = await identity();
  await getDb()
    .update(applications)
    .set({ isOfficial: false, type: 'third_party' })
    .where(eq(applications.id, receiver.app.id));
  expect(
    (
      await request(server)
        .post('/introspect')
        .auth(receiver.token, { type: 'bearer' })
        .send({ token: receiver.token })
    ).status,
  ).toBe(401);
});
