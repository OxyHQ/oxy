jest.mock('jsonwebtoken', () => jest.requireActual('jsonwebtoken'));
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import {
  applications,
  applicationCredentials,
  applicationWorkloadIdentities,
  users,
} from '../../db/schema';
import { bindWorkloadIdentity } from '../../services/workloadIdentityBinding.service';
import { mintServiceToken } from '../../services/serviceTokenMint.service';
import { serviceAuthMiddleware, type ServiceAuthRequest } from '../auth';
import { optionalUserOrServiceAuth } from '../optionalAuth';
import { userOrServiceAuthMiddleware } from '../userOrServiceAuth';
import { hasServiceAuthority } from '../../utils/serviceAuthority';

const server = express();
for (const [path, middleware] of [
  ['/service', serviceAuthMiddleware],
  ['/mixed', userOrServiceAuthMiddleware],
  ['/optional', optionalUserOrServiceAuth],
] as const) {
  server.get(path, middleware, (req: ServiceAuthRequest, res) => {
    if (!hasServiceAuthority(req.serviceApp, 'files:read'))
      return res.status(403).json({ error: 'scope_required' });
    return res.json(req.serviceApp);
  });
}
beforeAll(connectPostgres);
afterAll(closePostgres);
async function fixture() {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning();
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: 'Live mixed authority test',
      ownerAccountId: owner.id,
      status: 'active',
      isOfficial: true,
      scopes: ['files:read', 'files:write'],
    })
    .returning();
  const { binding } = await bindWorkloadIdentity({
    applicationId: app.id,
    subject: `arn:aws:iam::237343248947:role/test-live-${randomUUID()}`,
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
  const token = mintServiceToken(claims);
  return { owner, app, binding, claims, token };
}
for (const path of ['/service', '/mixed', '/optional']) {
  it(`${path} revalidates workload, application and owner on each call`, async () => {
    const f = await fixture();
    const read = () => request(server).get(path).auth(f.token, { type: 'bearer' });
    expect((await read()).status).toBe(200);
    await getDb()
      .update(applications)
      .set({ status: 'suspended' })
      .where(eq(applications.id, f.app.id));
    expect((await read()).status).toBe(401);
    await getDb()
      .update(applications)
      .set({ status: 'active' })
      .where(eq(applications.id, f.app.id));
    await getDb().update(users).set({ accountStatus: 'archived' }).where(eq(users.id, f.owner.id));
    expect((await read()).status).toBe(401);
    await getDb().update(users).set({ accountStatus: 'active' }).where(eq(users.id, f.owner.id));
    expect((await read()).status).toBe(200);
    await getDb()
      .delete(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.id, f.binding.id));
    expect((await read()).status).toBe(401);
  });
  it(`${path} narrows and revokes official-app customer credentials without promoting them`, async () => {
    const f = await fixture();
    const [credential] = await getDb()
      .insert(applicationCredentials)
      .values({
        applicationId: f.app.id,
        name: 'external customer',
        type: 'service',
        publicKey: randomUUID(),
        secretHash: 'fixture',
        environment: 'development',
        scopes: ['files:read'],
      })
      .returning();
    const token = mintServiceToken({
      ...f.claims,
      credentialId: credential.id,
      authority: 'external',
      scopes: ['files:read', 'files:write'],
    });
    const read = () => request(server).get(path).auth(token, { type: 'bearer' });
    const first = await read();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      authority: 'external',
      tier: 'external',
      scopes: ['files:read'],
    });
    await getDb()
      .update(applications)
      .set({ isOfficial: false, type: 'third_party' })
      .where(eq(applications.id, f.app.id));
    expect((await read()).status).toBe(200);
    await getDb()
      .update(applicationCredentials)
      .set({ scopes: ['files:write'] })
      .where(eq(applicationCredentials.id, credential.id));
    expect((await read()).status).toBe(403);
    await getDb()
      .update(applicationCredentials)
      .set({ scopes: ['files:read'], status: 'revoked' })
      .where(eq(applicationCredentials.id, credential.id));
    expect((await read()).status).toBe(401);
  });
}
