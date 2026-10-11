/** Stub only bearer transport; sessions, managed authority, credential and grants are real PostgreSQL rows. */
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { accountMembers, applicationCredentials, sessions } from '../../db/schema';
import type { AccessTokenIdentity } from '../../utils/sessionUtils';
import {
  productAccessFixture,
  accessAccount,
} from '../../services/__fixtures__/productAccessFixtures';
import { recordProductAccessPeriod } from '../../services/productAccessPersistence.service';
import { insertBearerSession } from '../__fixtures__/bearerSessionFixtures';
let identity: AccessTokenIdentity;
jest.mock('../../middleware/auth', () => ({
  ...jest.requireActual('../../middleware/auth'),
  authMiddleware: (req: { oxyToken: AccessTokenIdentity }, _res: unknown, next: () => void) => {
    req.oxyToken = identity;
    next();
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
import router from '../productAccess';
const app = express();
app.use('/v1/products', router);
jest.setTimeout(60_000);
beforeAll(connectPostgres);
afterAll(closePostgres);
async function fixture() {
  const f = await productAccessFixture();
  const operator = await accessAccount();
  const [member] = await getDb()
    .insert(accountMembers)
    .values({ accountId: f.beneficiary, memberUserId: operator, role: 'admin' })
    .returning();
  const clientId = `i07-client-${randomUUID()}`;
  const [credential] = await getDb()
    .insert(applicationCredentials)
    .values({
      name: 'Synthetic client fixture',
      applicationId: f.app.id,
      type: 'public',
      environment: 'production',
      publicKey: clientId,
      scopes: ['user:read'],
    })
    .returning();
  const sessionId = await insertBearerSession(f.beneficiary, operator);
  await getDb()
    .update(sessions)
    .set({ applicationId: f.app.id, clientId, scopes: ['user:read'] })
    .where(eq(sessions.sessionId, sessionId));
  identity = {
    version: 2,
    subjectAccountId: f.beneficiary,
    principalUserId: operator,
    sessionId,
    applicationId: f.app.id,
    clientId,
    scopes: ['user:read'],
    deviceSessionId: null,
    deviceContextId: null,
  };
  await recordProductAccessPeriod(f.input());
  const read = (subject = f.beneficiary, product = f.products[0].id) =>
    request(app).get(
      `/v1/products/${encodeURIComponent(product)}/access/${encodeURIComponent(subject)}`,
    );
  return { ...f, operator, member, credential, sessionId, read };
}
it('operated subject B reads its product rights with real live authority and no financial fields', async () => {
  const f = await fixture();
  const response = await f.read();
  expect(response.status).toBe(200);
  expect(response.body.data.subjectAccountId).toBe(f.beneficiary);
  expect(response.body.data.capabilities).toHaveLength(1);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(JSON.stringify(response.body)).not.toMatch(/payer|provider|price|balance/);
});
it('operator A acting as B cannot read A or another authorized account C', async () => {
  const f = await fixture();
  const other = await accessAccount('bot');
  await getDb()
    .insert(accountMembers)
    .values({ accountId: other, memberUserId: f.operator, role: 'admin' });
  expect((await f.read(f.operator)).status).toBe(404);
  expect((await f.read(other)).status).toBe(404);
});
it('credential environments and common expiry/rotation predicate are enforced', async () => {
  const f = await fixture();
  for (const update of [
    { environment: 'development' as const },
    { environment: 'production' as const, expiresAt: new Date(Date.now() - 1000) },
    { status: 'deprecated' as const, expiresAt: null },
  ]) {
    await getDb()
      .update(applicationCredentials)
      .set(update)
      .where(eq(applicationCredentials.id, f.credential.id));
    expect((await f.read()).status).toBe(403);
  }
  await getDb()
    .update(applicationCredentials)
    .set({ status: 'deprecated', expiresAt: new Date(Date.now() + 60_000) })
    .where(eq(applicationCredentials.id, f.credential.id));
  expect((await f.read()).status).toBe(200);
});
it('membership and permission revocations take effect without a cached read', async () => {
  const f = await fixture();
  expect((await f.read()).status).toBe(200);
  await getDb()
    .update(accountMembers)
    .set({ permissionRevokes: ['account:read'] })
    .where(eq(accountMembers.id, f.member.id));
  expect((await f.read()).status).toBe(403);
  await getDb()
    .update(accountMembers)
    .set({ permissionRevokes: [], status: 'removed' })
    .where(eq(accountMembers.id, f.member.id));
  expect((await f.read()).status).toBe(401);
});
it('current session binding, scope and live state are mandatory', async () => {
  const f = await fixture();
  identity.clientId = 'wrong';
  expect((await f.read()).status).toBe(401);
  identity.clientId = f.credential.publicKey;
  identity.scopes = [];
  expect((await f.read()).status).toBe(403);
  identity.scopes = ['user:read'];
  await getDb()
    .update(sessions)
    .set({ isActive: false })
    .where(eq(sessions.sessionId, f.sessionId));
  expect((await f.read()).status).toBe(401);
});
it('another product application and malformed parameters fail closed', async () => {
  const f = await fixture();
  const other = await productAccessFixture();
  expect((await f.read(f.beneficiary, other.products[0].id)).status).toBe(404);
  expect((await f.read(f.beneficiary, 'x'.repeat(161))).status).toBe(400);
  expect((await f.read(f.beneficiary, 'missing-product')).status).toBe(503);
});
it('an unbound shared session has no implicit application audience', async () => {
  const f = await fixture();
  await getDb()
    .update(sessions)
    .set({ applicationId: null, clientId: null })
    .where(eq(sessions.sessionId, f.sessionId));
  identity.applicationId = null;
  identity.clientId = null;
  expect((await f.read()).status).toBe(403);
});
it('personal and managed beneficiaries use the same product rights resolver', async () => {
  const f = await fixture();
  const source = f.input();
  source.source.beneficiaryAccountId = f.operator;
  source.segment.beneficiaryAccountId = f.operator;
  await recordProductAccessPeriod(source);
  const sessionId = await insertBearerSession(f.operator);
  await getDb()
    .update(sessions)
    .set({ applicationId: f.app.id, clientId: f.credential.publicKey, scopes: ['user:read'] })
    .where(eq(sessions.sessionId, sessionId));
  identity.subjectAccountId = f.operator;
  identity.sessionId = sessionId;
  const response = await f.read(f.operator);
  expect(response.status).toBe(200);
  expect(response.body.data.capabilities).toHaveLength(1);
});

it('returns only active per-grant periods behind the same subject and product boundary', async () => {
  const f = await fixture();
  const url = `/v1/products/${encodeURIComponent(f.products[0].id)}/access/${encodeURIComponent(f.beneficiary)}/grants`;
  const response = await request(app).get(url);
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body.data.grants).toHaveLength(1);
  expect(response.body.data.grants[0]).toMatchObject({
    beneficiaryAccountId: f.beneficiary,
    origin: 'bundle',
  });
  expect(JSON.stringify(response.body)).not.toContain('providerSubscriptionId');
  identity.subjectAccountId = f.operator;
  expect((await request(app).get(url)).status).toBe(404);
});
