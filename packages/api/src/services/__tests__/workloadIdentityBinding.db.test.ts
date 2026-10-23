/** Staff provisioning preserves identity and requires an explicit environment. */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { users } from '../../db/schema/users';
import {
  bindWorkloadIdentity,
  listWorkloadIdentityBindings,
  parseBindWorkloadIdentityArgv,
} from '../workloadIdentityBinding.service';
const STAFF = { isPlatformStaff: true, describedAs: 'test operator' };
const role = () => `arn:aws:iam::237343248947:role/test-${randomUUID()}`;
beforeAll(connectPostgres);
afterAll(closePostgres);
async function appFixture(overrides: Partial<typeof applications.$inferInsert> = {}) {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning();
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: 'Binding test',
      ownerAccountId: owner.id,
      isOfficial: true,
      status: 'active',
      scopes: [],
      ...overrides,
    })
    .returning();
  return app;
}
it('creates an attributable identity without scopes, canonicalizes its role and reruns idempotently', async () => {
  const app = await appFixture();
  const roleName = `test-${randomUUID()}`;
  const request = {
    applicationId: app.id,
    subject: `arn:aws:sts::237343248947:assumed-role/${roleName}/task`,
    environment: 'development' as const,
    actor: STAFF,
  };
  const first = await bindWorkloadIdentity(request);
  expect(first).toMatchObject({
    state: 'created',
    binding: {
      environment: 'development',
      scopes: [],
      subject: `arn:aws:iam::237343248947:role/${roleName}`,
    },
  });
  const [attribution] = await getDb()
    .select()
    .from(applicationCredentials)
    .where(eq(applicationCredentials.id, first.binding.attestationId));
  expect(attribution.type).toBe('workload');
  const [before] = await getDb()
    .select()
    .from(applicationWorkloadIdentities)
    .where(eq(applicationWorkloadIdentities.id, first.binding.id));
  expect(await bindWorkloadIdentity(request)).toMatchObject({
    state: 'unchanged',
    binding: { id: first.binding.id },
  });
  const [after] = await getDb()
    .select()
    .from(applicationWorkloadIdentities)
    .where(eq(applicationWorkloadIdentities.id, first.binding.id));
  expect(after.updatedAt).toEqual(before.updatedAt);
  expect(await listWorkloadIdentityBindings(app.id)).toHaveLength(1);
});
it('requires staff and an explicit environment before creating a binding', async () => {
  const app = await appFixture();
  const request = { applicationId: app.id, subject: role() };
  await expect(bindWorkloadIdentity({ ...request, actor: STAFF })).rejects.toMatchObject({
    reason: 'environment_required',
  });
  await expect(
    bindWorkloadIdentity({ ...request, environment: 'development' }),
  ).rejects.toMatchObject({ reason: 'staff_required' });
  expect(await listWorkloadIdentityBindings(app.id)).toHaveLength(0);
});
it('backfills only a null environment with compare-and-set, without changing historical metadata', async () => {
  const app = await appFixture();
  const subject = role();
  const [row] = await getDb()
    .insert(applicationWorkloadIdentities)
    .values({
      applicationId: app.id,
      provider: 'aws-iam',
      subject,
      scopes: ['user:read'],
      description: 'before',
    })
    .returning();
  const request = {
    applicationId: app.id,
    subject,
    environment: 'production' as const,
    actor: STAFF,
  };
  const results = await Promise.all([bindWorkloadIdentity(request), bindWorkloadIdentity(request)]);
  expect(results.filter((result) => result.state === 'updated')).toHaveLength(1);
  expect(results.every((result) => result.binding.environment === 'production')).toBe(true);
  expect(results[0].binding).toMatchObject({
    id: row.id,
    description: 'before',
    scopes: ['user:read'],
  });
  await expect(bindWorkloadIdentity({ ...request, environment: 'staging' })).rejects.toMatchObject({
    reason: 'environment_conflict',
  });
});
it('never repoints an existing role', async () => {
  const app = await appFixture();
  const another = await appFixture();
  const request = {
    applicationId: app.id,
    subject: role(),
    environment: 'development' as const,
    actor: STAFF,
  };
  await bindWorkloadIdentity(request);
  await expect(
    bindWorkloadIdentity({ ...request, applicationId: another.id }),
  ).rejects.toMatchObject({ reason: 'subject_bound_elsewhere' });
});
it.each([{ isOfficial: false, type: 'third_party' as const }, { status: 'suspended' as const }])(
  'rejects an unavailable own application %o',
  async (overrides) => {
    const app = await appFixture(overrides);
    await expect(
      bindWorkloadIdentity({
        applicationId: app.id,
        subject: role(),
        environment: 'development',
        actor: STAFF,
      }),
    ).rejects.toBeDefined();
    expect(await listWorkloadIdentityBindings(app.id)).toHaveLength(0);
  },
);
it('rejects obsolete scope provisioning from scripts and typed callers', async () => {
  const app = await appFixture();
  await expect(
    bindWorkloadIdentity({
      applicationId: app.id,
      subject: role(),
      environment: 'development',
      scopes: [],
      actor: STAFF,
    }),
  ).rejects.toMatchObject({ reason: 'workload_scopes_unsupported' });
  expect(() =>
    parseBindWorkloadIdentityArgv(['--app-id', app.id, '--subject', role(), '--scopes=']),
  ).toThrow('remove --scopes');
});
it('parses explicit environment and rejects malformed invocations', () => {
  expect(
    parseBindWorkloadIdentityArgv([
      '--app-id',
      'app',
      '--subject',
      role(),
      '--environment',
      'staging',
    ]),
  ).toMatchObject({ mode: 'bind', request: { applicationId: 'app', environment: 'staging' } });
  expect(() =>
    parseBindWorkloadIdentityArgv([
      '--app-id',
      'app',
      '--subject',
      role(),
      '--environment',
      'prod',
    ]),
  ).toThrow();
  expect(() =>
    parseBindWorkloadIdentityArgv(['--app-id', 'app', '--list', '--environment', 'staging']),
  ).toThrow();
});
