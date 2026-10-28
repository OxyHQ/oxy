import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { managedApplicationDeployments } from '../../db/schema/managedApplicationDeployments';
import { users } from '../../db/schema/users';
import { registerManagedApplicationDeployment } from '../managedApplicationDeployment.service';
import { bindWorkloadIdentity } from '../workloadIdentityBinding.service';
const staff = { isPlatformStaff: true, describedAs: 'fixture operator' };
const role = () => `arn:aws:iam::237343248947:role/managed-${randomUUID()}`;
beforeAll(connectPostgres);
afterAll(closePostgres);
async function fixture() {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning();
  if (!owner) throw new Error('Missing owner');
  return {
    deploymentId: randomUUID(),
    ownerAccountId: owner.id,
    origin: `https://${randomUUID()}.example.com`,
    environment: 'production' as const,
    backendRoleArn: role(),
    workerRoleArn: role(),
    mcpRoleArn: role(),
  };
}
it('registers distinct deployments and repeats without changing identities', async () => {
  const input = await fixture();
  const first = await registerManagedApplicationDeployment(input, staff);
  expect(first.state).toBe('created');
  expect(await registerManagedApplicationDeployment(input, staff)).toEqual({
    ...first,
    state: 'unchanged',
  });
  const other = await registerManagedApplicationDeployment(await fixture(), staff);
  expect(other.applicationId).not.toBe(first.applicationId);
  expect(other.publicClientId).not.toBe(first.publicClientId);
});
it('refuses nonstaff, non-origin URLs and shared roles before writing', async () => {
  const input = await fixture();
  await expect(
    registerManagedApplicationDeployment(input, { ...staff, isPlatformStaff: false }),
  ).rejects.toThrow('staff');
  await expect(
    registerManagedApplicationDeployment({ ...input, origin: `${input.origin}/path` }, staff),
  ).rejects.toThrow('origin');
  await expect(
    registerManagedApplicationDeployment({ ...input, workerRoleArn: input.backendRoleArn }, staff),
  ).rejects.toThrow('distinct');
  expect(
    await getDb()
      .select()
      .from(managedApplicationDeployments)
      .where(eq(managedApplicationDeployments.deploymentId, input.deploymentId)),
  ).toHaveLength(0);
});
it('refuses declaration drift in owner, origin, environment and every workload', async () => {
  const input = await fixture();
  await registerManagedApplicationDeployment(input, staff);
  const other = await fixture();
  for (const patch of [
    { ownerAccountId: other.ownerAccountId },
    { origin: other.origin },
    { environment: 'staging' as const },
    { backendRoleArn: role() },
    { workerRoleArn: role() },
    { mcpRoleArn: role() },
  ]) {
    await expect(
      registerManagedApplicationDeployment({ ...input, ...patch }, staff),
    ).rejects.toThrow('drift');
  }
});
it('rolls back application, origin, public client and earlier roles if the last role fails; retry succeeds', async () => {
  const input = await fixture();
  const [other] = await getDb()
    .insert(applications)
    .values({ name: 'Existing service', ownerAccountId: input.ownerAccountId, type: 'first_party' })
    .returning();
  if (!other) throw new Error('Missing app');
  await bindWorkloadIdentity({
    applicationId: other.id,
    subject: input.mcpRoleArn,
    environment: input.environment,
    actor: staff,
  });
  await expect(registerManagedApplicationDeployment(input, staff)).rejects.toMatchObject({
    reason: 'subject_bound_elsewhere',
  });
  expect(
    await getDb().select().from(applications).where(eq(applications.websiteUrl, input.origin)),
  ).toHaveLength(0);
  expect(
    await getDb()
      .select()
      .from(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.subject, input.backendRoleArn)),
  ).toHaveLength(0);
  await getDb().delete(applications).where(eq(applications.id, other.id));
  expect((await registerManagedApplicationDeployment(input, staff)).state).toBe('created');
});
it('does not restore a revoked workload or reactivate a suspended application', async () => {
  const input = await fixture();
  const registered = await registerManagedApplicationDeployment(input, staff);
  await getDb()
    .delete(applicationWorkloadIdentities)
    .where(eq(applicationWorkloadIdentities.subject, input.workerRoleArn));
  await expect(registerManagedApplicationDeployment(input, staff)).rejects.toThrow('revoked');
  expect(
    await getDb()
      .select()
      .from(applicationWorkloadIdentities)
      .where(eq(applicationWorkloadIdentities.subject, input.workerRoleArn)),
  ).toHaveLength(0);
  await getDb()
    .update(applications)
    .set({ status: 'suspended' })
    .where(eq(applications.id, registered.applicationId));
  await expect(registerManagedApplicationDeployment(input, staff)).rejects.toThrow('revoked');
});
it('does not take over an origin already assigned to another deployment', async () => {
  const input = await fixture();
  await registerManagedApplicationDeployment(input, staff);
  await expect(
    registerManagedApplicationDeployment({ ...(await fixture()), origin: input.origin }, staff),
  ).rejects.toThrow('another application');
});

it('keeps Files ownership separate from platform authority and preserves the verified requester’s own library', async () => {
  const { files } = await import('../../db/schema/files');
  const { findFileById } = await import('../fileRepository');
  const { mayApplicationRead } = await import('../fileReference.service');
  const { mediaPrivacyService } = await import('../mediaPrivacyService');
  const declarationA = await fixture();
  const declarationB = await fixture();
  const a = await registerManagedApplicationDeployment(declarationA, staff);
  const b = await registerManagedApplicationDeployment(declarationB, staff);
  const [assetA, assetB, personal] = await getDb()
    .insert(files)
    .values(
      [
        { ownerApplicationId: a.applicationId },
        { ownerApplicationId: b.applicationId },
        { ownerUserId: declarationB.ownerAccountId },
      ].map((owner) => ({
        ...owner,
        sha256: randomUUID().replaceAll('-', '').repeat(2),
        size: 1,
        mime: 'image/png',
        ext: '.png',
        visibility: 'private' as const,
        storageKey: `test/${randomUUID()}`,
      })),
    )
    .returning();
  if (!assetA || !assetB || !personal) throw new Error('Missing file fixtures');
  const fileA = await findFileById(assetA.id);
  const fileB = await findFileById(assetB.id);
  const ownLibrary = await findFileById(personal.id);
  if (!fileA || !fileB || !ownLibrary) throw new Error('Missing loaded fixtures');
  expect(mayApplicationRead(fileA, a.applicationId)).toBe(true);
  expect(mayApplicationRead(fileB, a.applicationId)).toBe(false);
  expect(mayApplicationRead(fileA, b.applicationId)).toBe(false);
  expect(mayApplicationRead(ownLibrary, a.applicationId)).toBe(false);
  expect(
    (await mediaPrivacyService.checkMediaAccess(ownLibrary, declarationA.ownerAccountId)).allowed,
  ).toBe(false);
  expect(
    (await mediaPrivacyService.checkMediaAccess(ownLibrary, declarationB.ownerAccountId)).allowed,
  ).toBe(true);
});

it('serializes concurrent retries without duplicating public clients or workload identities', async () => {
  const input = await fixture();
  const results = await Promise.all([
    registerManagedApplicationDeployment(input, staff),
    registerManagedApplicationDeployment(input, staff),
  ]);
  expect(results.map((result) => result.state).sort()).toEqual(['created', 'unchanged']);
  expect(new Set(results.map((result) => result.applicationId)).size).toBe(1);
  expect(new Set(results.map((result) => result.publicClientId)).size).toBe(1);
});
it.each(['owner', 'origin', 'public client', 'expired workload'] as const)(
  'refuses live registry drift: %s',
  async (change) => {
    const { applicationCredentials } = await import('../../db/schema/applicationCredentials');
    const { applicationWebOrigins } = await import('../../db/schema/applicationRecognition');
    const input = await fixture();
    const registered = await registerManagedApplicationDeployment(input, staff);
    if (change === 'owner') {
      const replacement = await fixture();
      await getDb()
        .update(applications)
        .set({ ownerAccountId: replacement.ownerAccountId })
        .where(eq(applications.id, registered.applicationId));
    } else if (change === 'origin') {
      await getDb()
        .delete(applicationWebOrigins)
        .where(eq(applicationWebOrigins.applicationId, registered.applicationId));
    } else if (change === 'public client') {
      await getDb()
        .update(applicationCredentials)
        .set({ status: 'revoked' })
        .where(eq(applicationCredentials.publicKey, registered.publicClientId));
    } else {
      await getDb()
        .update(applicationWorkloadIdentities)
        .set({ expiresAt: new Date(0) })
        .where(eq(applicationWorkloadIdentities.subject, input.backendRoleArn));
    }
    await expect(registerManagedApplicationDeployment(input, staff)).rejects.toThrow(
      'revoked or changed',
    );
  },
);
it('refuses an origin that another application commits after the initial availability read', async () => {
  const { declareApplicationWebOrigins } = await import('../applicationRecognition.service');
  const input = await fixture();
  const apps = await getDb()
    .insert(applications)
    .values(
      ['one', 'two'].map((name) => ({
        name,
        ownerAccountId: input.ownerAccountId,
        type: 'first_party' as const,
      })),
    )
    .returning();
  const [firstApp, secondApp] = apps;
  if (!firstApp || !secondApp) throw new Error('Missing applications');
  let release = () => {};
  let announce = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const first = getDb().transaction(async (tx) => {
    await declareApplicationWebOrigins(firstApp.id, [input.origin], tx);
    announce();
    await gate;
  });
  await ready;
  // Catch immediately: the expected rejection must not become an unhandled promise.
  const second = declareApplicationWebOrigins(secondApp.id, [input.origin]).then(
    () => 'accepted',
    () => 'refused',
  );
  try {
    const deadline = Date.now() + 5000;
    let blocked = false;
    while (!blocked && Date.now() < deadline) {
      const rows = await getDb().execute(
        sql`select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%insert into "application_web_origins"%'`,
      );
      blocked = rows.length > 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(blocked).toBe(true);
  } finally {
    release();
    await first;
  }
  expect(await second).toBe('refused');
});
