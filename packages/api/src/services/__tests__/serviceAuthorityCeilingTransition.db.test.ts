import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { appGrants } from '../../db/schema/appGrants';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';
import { workloadTokenEnvironment } from '../../utils/credentialEnvironment';
import { resolveServiceActingAsGrant } from '../serviceActingAs.service';
import { bindWorkloadIdentity } from '../workloadIdentityBinding.service';

const originalScopes = [
  'capabilities:read',
  'inference:invoke',
  'user:read',
  'capability-tickets:issue',
];
const finalScopes = [...originalScopes, 'acting-as:offline'];
// Synthetic operator fixture only; not a claim about a live staff identity.
const staff = {
  isPlatformStaff: true,
  describedAs: 'synthetic authorized operator fixture',
};

beforeAll(async () => {
  await connectPostgres();
});
afterAll(async () => {
  await closePostgres();
});

it('refuses workload scope provisioning and preserves external grants without authorizing bare account IDs', async () => {
  const db = getDb();
  const [owner, subject, otherSubject] = await db.insert(users).values([{}, {}, {}]).returning();
  const [app, otherApp] = await db
    .insert(applications)
    .values([
      {
        name: `Ceiling ${randomUUID()}`,
        ownerAccountId: owner.id,
        type: 'internal',
        isOfficial: true,
        status: 'active',
        scopes: finalScopes,
      },
      {
        name: `Other ${randomUUID()}`,
        ownerAccountId: owner.id,
        type: 'internal',
        isOfficial: true,
        status: 'active',
        scopes: finalScopes,
      },
    ])
    .returning();
  const role = `arn:aws:iam::237343248947:role/oxy-ceiling-test-${randomUUID()}`;
  const first = await bindWorkloadIdentity({
    applicationId: app.id,
    subject: role,
    environment: workloadTokenEnvironment(),
    actor: staff,
  });
  const [grant] = await db
    .insert(appGrants)
    .values({
      userId: subject.id,
      applicationId: app.id,
      scopes: ['acting-as:offline', 'inference:invoke'],
    })
    .returning();
  const context = {
    credentialId: first.binding.attestationId,
    ownerAccountId: owner.id,
    environment: workloadTokenEnvironment(),
  };
  const before = await resolveServiceActingAsGrant(app.id, subject.id, context);
  expect(before.authorized).toBe(false);
  expect(before.scopes).toEqual([]);
  for (const actor of [staff, { isPlatformStaff: false, describedAs: 'unprivileged fixture' }]) {
    await expect(
      bindWorkloadIdentity({
        applicationId: app.id,
        subject: role,
        scopes: finalScopes,
        environment: workloadTokenEnvironment(),
        actor,
      }),
    ).rejects.toMatchObject({ reason: 'workload_scopes_unsupported' });
  }
  expect((await resolveServiceActingAsGrant(app.id, subject.id, context)).authorized).toBe(false);
  expect((await resolveServiceActingAsGrant(app.id, otherSubject.id, context)).authorized).toBe(
    false,
  );
  expect((await resolveServiceActingAsGrant(otherApp.id, subject.id, context)).authorized).toBe(
    false,
  );
  expect(
    (
      await resolveServiceActingAsGrant(app.id, subject.id, {
        ...context,
        ownerAccountId: otherSubject.id,
      })
    ).authorized,
  ).toBe(false);
  expect(await db.select().from(appGrants).where(eq(appGrants.id, grant.id))).toEqual([grant]);
  expect(await db.select().from(applications).where(eq(applications.id, app.id))).toEqual([app]);
  const repeated = await bindWorkloadIdentity({
    applicationId: app.id,
    subject: role,
    environment: workloadTokenEnvironment(),
    actor: staff,
  });
  expect(repeated.state).toBe('unchanged');
  expect((await resolveServiceActingAsGrant(app.id, subject.id, context)).authorized).toBe(false);
  expect(await db.select().from(appGrants).where(eq(appGrants.id, grant.id))).toEqual([grant]);
});
