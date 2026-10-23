import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { provisionWorkloadEnvironments } from '../../../scripts/provision-workload-environments';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { LEGACY_WORKLOAD_BINDINGS } from '../../config/legacyWorkloadTransition';
import { applicationWorkloadIdentities as bindings } from '../../db/schema/applicationWorkloadIdentities';
import { applications } from '../../db/schema/applications';
import { users } from '../../db/schema/users';

const ids = LEGACY_WORKLOAD_BINDINGS.map((binding) => binding.id);
const appIds = [...new Set(LEGACY_WORKLOAD_BINDINGS.map((binding) => binding.applicationId))];
let owner: string;
let previousApps: Array<typeof applications.$inferSelect> = [];
let extraIds: string[] = [];
beforeAll(async () => {
  await connectPostgres();
  previousApps = await getDb().select().from(applications).where(inArray(applications.id, appIds));
  const [row] = await getDb().insert(users).values({}).returning({ id: users.id });
  owner = row.id;
  await getDb()
    .insert(applications)
    .values(
      appIds.map((id) => ({
        id,
        ownerAccountId: owner,
        name: `Preflight ${id}`,
        status: 'active' as const,
        type: 'first_party' as const,
      })),
    )
    .onConflictDoNothing();
});
beforeEach(async () => {
  await getDb()
    .update(applications)
    .set({ status: 'active', type: 'first_party', isOfficial: false, isInternal: false })
    .where(inArray(applications.id, appIds));
  await getDb().delete(bindings).where(inArray(bindings.id, ids));
  await getDb()
    .insert(bindings)
    .values(
      LEGACY_WORKLOAD_BINDINGS.map((binding) => ({
        ...binding,
        scopes: ['user:read'],
        description: 'preserved registry metadata',
      })),
    );
});
afterEach(async () => {
  if (extraIds.length) await getDb().delete(bindings).where(inArray(bindings.id, extraIds));
  extraIds = [];
});
afterAll(async () => {
  await getDb().delete(bindings).where(inArray(bindings.id, ids));
  await getDb()
    .delete(applications)
    .where(and(inArray(applications.id, appIds), eq(applications.ownerAccountId, owner)));
  for (const row of previousApps)
    await getDb()
      .update(applications)
      .set({
        status: row.status,
        type: row.type,
        isOfficial: row.isOfficial,
        isInternal: row.isInternal,
      })
      .where(eq(applications.id, row.id));
  await getDb().delete(users).where(eq(users.id, owner));
  await closePostgres();
});
async function cohortRows() {
  return getDb().select().from(bindings).where(inArray(bindings.id, ids)).orderBy(bindings.id);
}

it('dry-runs exactly the reviewed cohort without changing any row', async () => {
  const before = await cohortRows();
  const report = await provisionWorkloadEnvironments(getDb(), false);
  expect(report.bindings).toHaveLength(27);
  expect(report.bindings.every((binding) => binding.state === 'needs_provisioning')).toBe(true);
  expect(report.cohortEnvironmentReady).toBe(false);
  expect(report.fleetReadiness).toBe('not_assessed');
  expect(await cohortRows()).toEqual(before);
});

it('applies once, preserves authority metadata and never adopts a newly discovered workload', async () => {
  const extra = randomUUID();
  extraIds.push(extra);
  await getDb()
    .insert(bindings)
    .values({
      id: extra,
      applicationId: appIds[0],
      provider: 'aws-iam',
      subject: `arn:aws:iam::237343248947:role/unreviewed-${extra}`,
      scopes: ['files:read'],
    });
  const before = await cohortRows();
  const report = await provisionWorkloadEnvironments(getDb(), true);
  expect(report.cohortEnvironmentReady).toBe(true);
  expect(report.requiresInventoryReview).toBe(true);
  expect(report.outsideCohort).toContainEqual({
    id: extra,
    applicationId: appIds[0],
    provider: 'aws-iam',
    subject: `arn:aws:iam::237343248947:role/unreviewed-${extra}`,
    environment: null,
  });
  for (const row of report.outsideCohort)
    expect(Object.keys(row).sort()).toEqual([
      'applicationId',
      'environment',
      'id',
      'provider',
      'subject',
    ]);
  const after = await cohortRows();
  expect(after.every((row) => row.environment === 'production')).toBe(true);
  const stable = (row: (typeof after)[number]) => {
    const { environment: _environment, updatedAt: _updatedAt, ...rest } = row;
    return rest;
  };
  expect(after.map(stable)).toEqual(before.map(stable));
  const again = await provisionWorkloadEnvironments(getDb(), true);
  expect(again.bindings.every((binding) => binding.state === 'unchanged')).toBe(true);
  expect(await cohortRows()).toEqual(after);
  const [unreviewed] = await getDb().select().from(bindings).where(eq(bindings.id, extra));
  expect(unreviewed.environment).toBeNull();
  expect(unreviewed.scopes).toEqual(['files:read']);
});

it.each([
  'subject',
  'provider',
  'application',
  'missing',
  'environment',
  'expired',
  'external-app',
])('rolls back the whole cohort when the last binding has %s drift', async (kind) => {
  const last = LEGACY_WORKLOAD_BINDINGS[LEGACY_WORKLOAD_BINDINGS.length - 1];
  if (kind === 'missing') await getDb().delete(bindings).where(eq(bindings.id, last.id));
  else if (kind === 'external-app')
    await getDb()
      .update(applications)
      .set({ type: 'third_party', isOfficial: false, isInternal: false })
      .where(eq(applications.id, last.applicationId));
  else
    await getDb()
      .update(bindings)
      .set(
        kind === 'application'
          ? { applicationId: appIds[0] }
          : kind === 'subject'
            ? { subject: 'changed' }
            : kind === 'provider'
              ? { provider: 'changed' }
              : kind === 'environment'
                ? { environment: 'staging' }
                : { expiresAt: new Date(0) },
      )
      .where(eq(bindings.id, last.id));
  const before = await cohortRows();
  await expect(provisionWorkloadEnvironments(getDb(), true)).rejects.toThrow();
  expect(await cohortRows()).toEqual(before);
});

it('serializes two concurrent attempts without rewriting already provisioned rows', async () => {
  const results = await Promise.all([
    provisionWorkloadEnvironments(getDb(), true),
    provisionWorkloadEnvironments(getDb(), true),
  ]);
  expect(
    results
      .map((report) => report.bindings.filter((binding) => binding.state === 'provisioned').length)
      .sort((a, b) => a - b),
  ).toEqual([0, 27]);
});
