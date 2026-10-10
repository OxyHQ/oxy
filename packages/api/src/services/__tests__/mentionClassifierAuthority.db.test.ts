import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { createTestDatabase, dropTestDatabase } from '../../db/testDatabase';
import { applications } from '../../db/schema/applications';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { users } from '../../db/schema/users';
import { MENTION_CLASSIFIER_IDENTITY as identity } from '../../config/mentionClassifierEconomics';
import { mentionClassifierAuthorityActive } from '../mentionClassifierEconomics.service';
import type { EdgePrincipal } from '../inferenceEdge.service';

const originalUrl = process.env.DATABASE_URL;
let databaseUrl: string | undefined;
const scopes = ['inference:invoke', 'inference:usage:read'] as const;
const principal: EdgePrincipal = {
  ...identity,
  lane: 'service_token',
  environment: 'production',
  scopes,
  applicationType: 'first_party',
  applicationIsInternal: false,
};
jest.setTimeout(60_000);
beforeAll(async () => {
  // Exact reviewed IDs are tested only in this independently owned, freshly migrated database.
  databaseUrl = await createTestDatabase();
  await connectPostgres();
  await getDb().insert(users).values({
    id: identity.ownerAccountId,
    username: 'mention-policy-fixture',
    email: 'mention-policy@example.test',
  });
  await getDb()
    .insert(applications)
    .values({
      id: identity.applicationId,
      ownerAccountId: identity.ownerAccountId,
      createdByUserId: identity.ownerAccountId,
      name: 'Synthetic Mention policy',
      type: 'first_party',
      isOfficial: true,
      isInternal: false,
      status: 'active',
      scopes: [...scopes],
    });
  await getDb()
    .insert(applicationWorkloadIdentities)
    .values({
      id: identity.bindingId,
      applicationId: identity.applicationId,
      provider: 'aws-iam',
      subject: identity.subject,
      scopes: [...scopes],
    });
  await getDb().insert(applicationCredentials).values({
    id: identity.credentialId,
    applicationId: identity.applicationId,
    name: 'Synthetic workload attribution',
    type: 'workload',
    publicKey: null,
    environment: 'production',
    workloadIdentityId: identity.bindingId,
    scopes: [],
    status: 'active',
  });
});
afterAll(async () => {
  try {
    await closePostgres();
  } finally {
    try {
      if (databaseUrl) await dropTestDatabase(databaseUrl);
    } finally {
      if (originalUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
      else process.env.DATABASE_URL = originalUrl;
    }
  }
});
beforeEach(async () => {
  await getDb()
    .update(applications)
    .set({
      status: 'active',
      scopes: [...scopes],
      ownerAccountId: identity.ownerAccountId,
      isInternal: false,
    })
    .where(eq(applications.id, identity.applicationId));
  await getDb()
    .update(users)
    .set({ accountStatus: 'active' })
    .where(eq(users.id, identity.ownerAccountId));
  await getDb()
    .update(applicationWorkloadIdentities)
    .set({ scopes: [...scopes], expiresAt: null, subject: identity.subject })
    .where(eq(applicationWorkloadIdentities.id, identity.bindingId));
  await getDb()
    .update(applicationCredentials)
    .set({ status: 'active', expiresAt: null, environment: 'production' })
    .where(eq(applicationCredentials.id, identity.credentialId));
});
it('accepts the own active official binding without setting is_internal', async () => {
  expect(await mentionClassifierAuthorityActive(principal)).toBe(true);
  const [row] = await getDb()
    .select({ isInternal: applications.isInternal })
    .from(applications)
    .where(eq(applications.id, identity.applicationId));
  expect(row.isInternal).toBe(false);
});
it.each(['app', 'binding'] as const)('honors live %s scope revocation', async (kind) => {
  if (kind === 'app')
    await getDb()
      .update(applications)
      .set({ scopes: ['inference:usage:read'] })
      .where(eq(applications.id, identity.applicationId));
  else
    await getDb()
      .update(applicationWorkloadIdentities)
      .set({ scopes: ['inference:usage:read'] })
      .where(eq(applicationWorkloadIdentities.id, identity.bindingId));
  expect(await mentionClassifierAuthorityActive(principal)).toBe(false);
});
it.each([
  'application',
  'owner',
  'credential',
  'expired-binding',
  'expired-credential',
  'foreign-role',
  'credential-environment',
] as const)('refuses %s lifecycle drift', async (kind) => {
  if (kind === 'application')
    await getDb()
      .update(applications)
      .set({ status: 'suspended' })
      .where(eq(applications.id, identity.applicationId));
  if (kind === 'owner')
    await getDb()
      .update(users)
      .set({ accountStatus: 'archived' })
      .where(eq(users.id, identity.ownerAccountId));
  if (kind === 'credential')
    await getDb()
      .update(applicationCredentials)
      .set({ status: 'revoked' })
      .where(eq(applicationCredentials.id, identity.credentialId));
  if (kind === 'expired-binding')
    await getDb()
      .update(applicationWorkloadIdentities)
      .set({ expiresAt: new Date(0) })
      .where(eq(applicationWorkloadIdentities.id, identity.bindingId));
  if (kind === 'expired-credential')
    await getDb()
      .update(applicationCredentials)
      .set({ expiresAt: new Date(0) })
      .where(eq(applicationCredentials.id, identity.credentialId));
  if (kind === 'foreign-role')
    await getDb()
      .update(applicationWorkloadIdentities)
      .set({ subject: 'arn:aws:iam::237343248947:role/foreign-fixture' })
      .where(eq(applicationWorkloadIdentities.id, identity.bindingId));
  if (kind === 'credential-environment')
    await getDb()
      .update(applicationCredentials)
      .set({ environment: 'staging' })
      .where(eq(applicationCredentials.id, identity.credentialId));
  expect(await mentionClassifierAuthorityActive(principal)).toBe(false);
});
it('does not substitute another principal or stronger live scopes for the authenticated request', async () => {
  expect(await mentionClassifierAuthorityActive({ ...principal, credentialId: 'wl_foreign' })).toBe(
    false,
  );
  expect(await mentionClassifierAuthorityActive({ ...principal, ownerAccountId: 'foreign' })).toBe(
    false,
  );
  expect(
    await mentionClassifierAuthorityActive({ ...principal, scopes: ['inference:invoke'] }),
  ).toBe(false);
});
