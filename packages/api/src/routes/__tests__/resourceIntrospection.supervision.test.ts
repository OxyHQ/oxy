import express from 'express';
import { CLARITY_BACKEND_APPLICATION_ID } from '../../config/firstPartyApplications';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../middleware/auth', () => ({
  serviceAuthMiddleware: (req: { serviceApp?: unknown }, _res: unknown, next: () => void) => {
    req.serviceApp = {
      appId: CLARITY_BACKEND_APPLICATION_ID,
    };
    next();
  },
}));
import router from '../resourceIntrospection';
import { errorHandler } from '../../middleware/errorHandler';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users, applications, applicationCredentials, supervisionProfiles } from '../../db/schema';
import { signServiceTokenEd25519 } from '../../config/serviceTokenSigning';
let server: http.Server;
beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use(router);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePostgres();
});
async function fixture() {
  const [owner] = await getDb()
    .insert(users)
    .values({ kind: 'personal', privacyIsPrivateAccount: true })
    .returning({ id: users.id });
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: 'Introspection service',
      ownerAccountId: owner.id,
      type: 'first_party',
      scopes: ['user:read', 'clarity:search'],
    })
    .returning({ id: applications.id });
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: app.id,
      name: 'Introspection proof',
      type: 'service',
      environment: 'production',
      publicKey: `oxy_dk_${randomUUID()}`,
      secretHash: 'test-only',
    })
    .returning({ id: applicationCredentials.id });
  const now = Math.floor(Date.now() / 1000);
  const token = signServiceTokenEd25519({
    type: 'service',
    appId: app.id,
    appName: 'Introspection service',
    credentialId: credential.id,
    ownerAccountId: owner.id,
    environment: 'production',
    tier: 'internal',
    scopes: ['user:read', 'clarity:search'],
    iss: 'oxy-auth',
    aud: 'oxy-api',
    iat: now,
    exp: now + 300,
  });
  return { owner: owner.id, app: app.id, credential: credential.id, token };
}
async function introspect(token: string) {
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/introspect`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    },
  );
  expect(response.status).toBe(200);
  return response.json();
}
it('keeps an external key on an official app scoped with external authority', async () => {
  const f = await fixture();
  expect(await introspect(f.token)).toMatchObject({
    active: true,
    accountId: f.owner,
    applicationId: f.app,
    scopes: ['user:read', 'clarity:search'],
    tier: 'external',
    authority: 'external',
  });
  await getDb()
    .update(applications)
    .set({ scopes: ['user:read'] })
    .where(eq(applications.id, f.app));
  expect(await introspect(f.token)).toMatchObject({ active: true, scopes: ['user:read'] });
});
it('rejects a still-signed pre-enrollment owner token on the next request', async () => {
  const f = await fixture();
  expect((await introspect(f.token)).active).toBe(true);
  await getDb()
    .insert(supervisionProfiles)
    .values({ childAccountId: f.owner, status: 'orphaned', consentVersion: '1' });
  expect(await introspect(f.token)).toEqual({ active: false, scopes: [], permissions: [] });
});
it.each(['credential', 'application', 'owner'] as const)(
  'rechecks current %s authority for a previously accepted signed token',
  async (target) => {
    const f = await fixture();
    expect((await introspect(f.token)).active).toBe(true);
    if (target === 'credential')
      await getDb()
        .update(applicationCredentials)
        .set({ status: 'revoked' })
        .where(eq(applicationCredentials.id, f.credential));
    if (target === 'application')
      await getDb()
        .update(applications)
        .set({ status: 'suspended' })
        .where(eq(applications.id, f.app));
    if (target === 'owner')
      await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, f.owner));
    expect(await introspect(f.token)).toEqual({ active: false, scopes: [], permissions: [] });
  },
);
