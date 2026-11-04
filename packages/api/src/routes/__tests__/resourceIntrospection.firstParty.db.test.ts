import express from 'express';
import { OxyServer } from '@oxy.so/core/server';
import { serviceTokenPublicJwks } from '../../config/serviceTokenSigning';
import { generateMachineCredentialToken } from '../../utils/machineCredentialToken';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  applications,
  users,
  applicationWorkloadIdentities,
  applicationCredentials,
} from '../../db/schema';
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
it('refuses receiver substitution, wrong environment and retired scoped workload tokens', async () => {
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
    ).body,
  ).toMatchObject({ active: false });
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

it('runs canonical SDK verification through the real introspection route with live external ceilings', async () => {
  const receiver = await identity();
  const caller = await identity();
  await getDb()
    .update(applications)
    .set({ scopes: ['payments:read', 'payments:write'] })
    .where(eq(applications.id, caller.app.id));
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: caller.app.id,
      name: 'Customer service key on official application',
      type: 'service',
      publicKey: randomUUID(),
      secretHash: 'test-only',
      environment: 'development',
      scopes: ['payments:read'],
    })
    .returning();
  const audience = `oxy-service:${receiver.app.id}` as const;
  const claims = {
    ...caller.claims,
    authority: 'external' as const,
    credentialId: credential.id,
    scopes: ['payments:read', 'payments:write'],
  };
  const api = express().use(express.json());
  api.get('/.well-known/jwks.json', (_req, res) => res.json({ keys: serviceTokenPublicJwks() }));
  api.use('/auth/resources', router).use(errorHandler);
  const listener = api.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => listener.once('listening', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  const oxy = new OxyServer({ baseURL: `http://127.0.0.1:${address.port}` });
  // Only workload mint is replaced: the signed receiver JWT, shared introspection
  // client, HTTP route, database liveness and receiving middleware remain real.
  jest
    .spyOn(oxy as unknown as { platformServiceToken(): Promise<string> }, 'platformServiceToken')
    .mockResolvedValue(receiver.token);
  const product = express();
  product.use(oxy.middleware.service({ expectedAudience: audience }));
  product.get('/read', oxy.middleware.requireScope('payments:read'), (_req, res) =>
    res.sendStatus(200),
  );
  product.get('/write', oxy.middleware.requireScope('payments:write'), (_req, res) =>
    res.sendStatus(200),
  );
  try {
    for (const aud of [audience, 'oxy-api'] as const) {
      const bearer = mintServiceToken(claims, aud);
      expect((await request(product).get('/read').auth(bearer, { type: 'bearer' })).status).toBe(
        200,
      );
      expect((await request(product).get('/write').auth(bearer, { type: 'bearer' })).status).toBe(
        403,
      );
    }
    const bearer = mintServiceToken(claims, audience);
    await getDb()
      .update(applications)
      .set({ isOfficial: false, type: 'third_party' })
      .where(eq(applications.id, caller.app.id));
    expect((await request(product).get('/read').auth(bearer, { type: 'bearer' })).status).toBe(200);
    await getDb()
      .update(applicationCredentials)
      .set({ scopes: ['payments:write'] })
      .where(eq(applicationCredentials.id, credential.id));
    expect((await request(product).get('/read').auth(bearer, { type: 'bearer' })).status).toBe(403);
    const wrongReceiver = mintServiceToken(claims, `oxy-service:${caller.app.id}`);
    expect(
      (await request(product).get('/read').auth(wrongReceiver, { type: 'bearer' })).status,
    ).toBe(401);
    const wrongEnvironment = mintServiceToken({ ...claims, environment: 'production' }, audience);
    expect(
      (await request(product).get('/write').auth(wrongEnvironment, { type: 'bearer' })).status,
    ).toBe(401);
    await getDb()
      .update(applicationCredentials)
      .set({ status: 'revoked' })
      .where(eq(applicationCredentials.id, credential.id));
    expect((await request(product).get('/write').auth(bearer, { type: 'bearer' })).status).toBe(
      401,
    );
    const own = mintServiceToken(caller.claims, audience);
    expect((await request(product).get('/write').auth(own, { type: 'bearer' })).status).toBe(401);
    await getDb()
      .update(applications)
      .set({ isOfficial: true })
      .where(eq(applications.id, caller.app.id));
    expect((await request(product).get('/write').auth(own, { type: 'bearer' })).status).toBe(200);
    await getDb()
      .delete(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.id, receiver.binding.id));
    expect((await request(product).get('/write').auth(own, { type: 'bearer' })).status).not.toBe(
      200,
    );
  } finally {
    oxy.dispose();
    listener.closeAllConnections();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    jest.restoreAllMocks();
  }
});

it('does not open the Clarity raw machine-key projection to another product receiver', async () => {
  const receiver = await identity();
  const key = generateMachineCredentialToken();
  await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: receiver.app.id,
      name: 'External machine key',
      type: 'machine',
      environment: 'development',
      publicKey: randomUUID(),
      tokenPrefix: key.tokenPrefix,
      tokenHash: key.tokenHash,
      scopes: ['clarity:search'],
    });
  expect(
    (
      await request(server)
        .post('/introspect')
        .auth(receiver.token, { type: 'bearer' })
        .send({ token: key.token })
    ).body.active,
  ).toBe(false);
});
