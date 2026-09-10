import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import type { ServiceTokenPayload } from '../../middleware/serviceToken';
import { resolveLiveAgencyServicePrincipal } from '../agencyServicePrincipal.service';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

async function principalFixture() {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const [application] = await getDb().insert(applications).values({
    name: `Agency coordinator ${randomUUID()}`,
    ownerAccountId: owner.id,
    status: 'active',
    isInternal: true,
    scopes: ['capabilities:read', 'capability-tickets:issue'],
    capabilities: ['agency:coordinate'],
  }).returning({ id: applications.id });
  const [credential] = await getDb().insert(applicationCredentials).values({
    applicationId: application.id,
    name: 'Agency test credential',
    publicKey: `oxy_dk_${randomUUID()}`,
    secretHash: 'test-only-secret-hash',
    type: 'service',
    environment: 'production',
    scopes: ['capabilities:read', 'capability-tickets:issue'],
    status: 'active',
  }).returning({ id: applicationCredentials.id });
  const token: ServiceTokenPayload = {
    type: 'service',
    appId: application.id,
    appName: 'Agency coordinator',
    credentialId: credential.id,
    ownerAccountId: owner.id,
    environment: 'production',
    scopes: ['capabilities:read', 'capability-tickets:issue'],
  };
  return { application, credential, token };
}

describe('live agency service principal', () => {
  it('intersects token, credential and current application scopes', async () => {
    const fixture = await principalFixture();
    await getDb().update(applications).set({ scopes: ['capabilities:read'] })
      .where(eq(applications.id, fixture.application.id));

    const principal = await resolveLiveAgencyServicePrincipal(fixture.token);

    expect(principal?.scopes).toEqual(['capabilities:read']);
    expect(principal?.capabilities).toContain('agency:coordinate');
  });

  it('rejects a credential revoked after its service JWT was minted', async () => {
    const fixture = await principalFixture();
    await getDb().update(applicationCredentials).set({ status: 'revoked' })
      .where(eq(applicationCredentials.id, fixture.credential.id));

    await expect(resolveLiveAgencyServicePrincipal(fixture.token)).resolves.toBeNull();
  });

  it('rejects an application whose platform trust is removed after mint', async () => {
    const fixture = await principalFixture();
    await getDb().update(applications).set({ isInternal: false, type: 'third_party' })
      .where(eq(applications.id, fixture.application.id));

    await expect(resolveLiveAgencyServicePrincipal(fixture.token)).resolves.toBeNull();
  });
});
