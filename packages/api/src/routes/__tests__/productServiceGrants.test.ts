/** Real service JWT verification, consent, live credential/workload and product rows. */
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { signServiceTokenEd25519 } from '../../config/serviceTokenSigning';
import * as environment from '../../config/env';
import {
  accountClosureFences,
  appGrants,
  applications,
  applicationCredentials,
  users,
  applicationWorkloadIdentities,
} from '../../db/schema';
import { errorHandler } from '../../middleware/errorHandler';
import {
  productAccessFixture,
  accessAccount,
} from '../../services/__fixtures__/productAccessFixtures';
import {
  recordProductAccessPeriod,
  updateProductAccessSourceState,
} from '../../services/productAccessPersistence.service';
import { revokeServiceActingAs } from '../../services/serviceActingAs.service';
import { ensureWorkloadAttributionIdentity } from '../../services/workloadAttributionIdentity.service';
import { workloadAttestationHandle } from '../../services/workloadAttestation.service';
import router from '../productAccess';

const required = ['user:read', 'acting-as:offline'];
const app = express();
app.use('/v1/products', router);
app.use(errorHandler);
beforeAll(connectPostgres);
afterAll(closePostgres);
async function fixture() {
  const f = await productAccessFixture();
  await getDb()
    .update(applications)
    .set({ scopes: required, type: 'internal', isInternal: true })
    .where(eq(applications.id, f.app.id));
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      applicationId: f.app.id,
      name: 'Synthetic offline product read',
      publicKey: `synthetic-${randomUUID()}`,
      type: 'service',
      environment: 'production',
      scopes: required,
    })
    .returning();
  const [grant] = await getDb()
    .insert(appGrants)
    .values({ userId: f.beneficiary, applicationId: f.app.id, scopes: required })
    .returning();
  const source = f.input();
  await recordProductAccessPeriod(source);
  const token = (overrides: Record<string, unknown> = {}) =>
    signServiceTokenEd25519({
      type: 'service',
      appId: f.app.id,
      appName: 'Synthetic product reader',
      credentialId: credential.id,
      ownerAccountId: f.owner,
      environment: 'production',
      scopes: required,
      iss: 'oxy-auth',
      aud: 'oxy-api',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...overrides,
    });
  const read = (
    bearer: string | null = token(),
    subject = f.beneficiary,
    product = f.products[0].id,
  ) => {
    const call = request(app).get(
      `/v1/products/${encodeURIComponent(product)}/access/${encodeURIComponent(subject)}/service-grants`,
    );
    return bearer ? call.set('Authorization', `Bearer ${bearer}`) : call;
  };
  return { ...f, credential, grant, source, token, read };
}
it('reads only the exact consented subject/product with no provider or financial identifiers', async () => {
  const f = await fixture();
  const response = await f.read();
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body.data.access.subjectAccountId).toBe(f.beneficiary);
  expect(response.body.data.grants).toHaveLength(1);
  expect(JSON.stringify(response.body)).not.toMatch(
    /providerSubscriptionId|payerAccountId|priceId|balance/,
  );
  expect((await f.read(null)).status).toBe(401);
  expect((await f.read(f.token({ exp: Math.floor(Date.now() / 1000) - 1 }))).status).toBe(401);
  expect((await f.read(f.token(), await accessAccount())).status).toBe(404);
  const other = await productAccessFixture();
  expect((await f.read(f.token(), f.beneficiary, other.products[0].id)).status).toBe(404);
});
it('requires both token scopes and the live consent intersection', async () => {
  const f = await fixture();
  for (const scopes of [['user:read'], ['acting-as:offline'], []])
    expect((await f.read(f.token({ scopes }))).status).toBe(403);
  expect((await f.read(f.token({ environment: 'development' }))).status).toBe(403);
  await getDb()
    .update(appGrants)
    .set({ scopes: ['acting-as:offline'] })
    .where(eq(appGrants.id, f.grant.id));
  expect((await f.read()).status).toBe(404);
  await getDb().delete(appGrants).where(eq(appGrants.id, f.grant.id));
  expect((await f.read()).status).toBe(404);
});
it('revocation wins over a recreated grant and reads never warm an authority cache', async () => {
  const f = await fixture();
  expect((await f.read()).status).toBe(200);
  await revokeServiceActingAs(f.beneficiary, f.app.id);
  await getDb()
    .insert(appGrants)
    .values({ userId: f.beneficiary, applicationId: f.app.id, scopes: required });
  expect((await f.read()).status).toBe(404);
});
it.each([
  'credential',
  'expiredKey',
  'keyScopes',
  'app',
  'appScopes',
  'subject',
  'subjectFence',
  'owner',
  'ownerFence',
  'ownerClaim',
] as const)('refuses live %s changes even with an unchanged signed token', async (change) => {
  const f = await fixture();
  const token = f.token();
  expect((await f.read(token)).status).toBe(200);
  if (change === 'credential')
    await getDb()
      .update(applicationCredentials)
      .set({ status: 'revoked' })
      .where(eq(applicationCredentials.id, f.credential.id));
  if (change === 'expiredKey')
    await getDb()
      .update(applicationCredentials)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(applicationCredentials.id, f.credential.id));
  if (change === 'keyScopes')
    await getDb()
      .update(applicationCredentials)
      .set({ scopes: ['user:read'] })
      .where(eq(applicationCredentials.id, f.credential.id));
  if (change === 'app')
    await getDb()
      .update(applications)
      .set({ status: 'suspended' })
      .where(eq(applications.id, f.app.id));
  if (change === 'appScopes')
    await getDb()
      .update(applications)
      .set({ scopes: ['acting-as:offline'] })
      .where(eq(applications.id, f.app.id));
  if (change === 'subject' || change === 'owner')
    await getDb()
      .update(users)
      .set({ accountStatus: 'archived' })
      .where(eq(users.id, change === 'subject' ? f.beneficiary : f.owner));
  if (change === 'subjectFence' || change === 'ownerFence')
    await getDb()
      .insert(accountClosureFences)
      .values({ accountId: change === 'subjectFence' ? f.beneficiary : f.owner });
  const response = await f.read(
    change === 'ownerClaim' ? f.token({ ownerAccountId: await accessAccount() }) : token,
  );
  expect(response.status).toBe(404);
});
it('filters canceled source grants from a still-authorized read', async () => {
  const f = await fixture();
  await updateProductAccessSourceState({
    sourceId: f.source.source.id,
    productId: f.products[0].id,
    status: 'canceled',
    period: f.period,
    cancelAtPeriodEnd: false,
    providerObservedAt: new Date(+f.now + 1000),
    providerBinding: f.providerBinding,
  });
  const response = await f.read();
  expect(response.status).toBe(200);
  expect(response.body.data.grants).toEqual([]);
});
it('uses the live workload binding, never a service key beside it', async () => {
  const f = await fixture();
  const subject = `arn:aws:iam::123456789012:role/synthetic-product-${randomUUID()}`;
  const [binding] = await getDb()
    .insert(applicationWorkloadIdentities)
    .values({
      applicationId: f.app.id,
      provider: 'aws-iam',
      subject,
      description: 'Synthetic local-only fixture',
      scopes: required,
    })
    .returning();
  await ensureWorkloadAttributionIdentity({
    bindingId: binding.id,
    applicationId: f.app.id,
    subject,
  });
  const token = f.token({ credentialId: workloadAttestationHandle(subject) });
  // Simulate only workload deployment classification; retain real test signing keys.
  const production = jest.spyOn(environment, 'isProduction').mockReturnValue(true);
  try {
    expect((await f.read(token)).status).toBe(200);
    await getDb()
      .update(applicationWorkloadIdentities)
      .set({ scopes: ['user:read'] })
      .where(eq(applicationWorkloadIdentities.id, binding.id));
    expect((await f.read(token)).status).toBe(404);
    await getDb()
      .update(applicationWorkloadIdentities)
      .set({ scopes: required, expiresAt: new Date(Date.now() - 1000) })
      .where(eq(applicationWorkloadIdentities.id, binding.id));
    expect((await f.read(token)).status).toBe(404);
    await getDb()
      .delete(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.id, binding.id));
    expect((await f.read(token)).status).toBe(404);
  } finally {
    production.mockRestore();
  }
});
