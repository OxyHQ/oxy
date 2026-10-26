/** The rollback bridge must provision and resolve authority after the later DROP. */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { users } from '../../db/schema/users';
import { deploymentCredentialEnvironment } from '../../utils/credentialEnvironment';
import { resolveLiveAgencyWorkloadByHandle } from '../agencyServicePrincipal.service';
import {
  bindWorkloadIdentity,
  listWorkloadIdentityBindings,
} from '../workloadIdentityBinding.service';

let originalColumnPresent = false;
let currentColumnPresent = false;
let constraint: string | null = null;
let historicalValues: { id: string; scopes: string[] }[] = [];

beforeAll(async () => {
  await connectPostgres();
  // Jest owns a disposable migrated database. Never run this DDL against the
  // configured base database, a shared application database or production.
  const [database] = await getDb().execute<{ name: string }>(
    sql`SELECT current_database() AS name`,
  );
  if (!/^oxy_test_[0-9a-f]{16}$/.test(database.name))
    throw new Error('Disposable Jest database required.');
  const columns = await getDb().execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='application_workload_identities' AND column_name='scopes'
  `);
  originalColumnPresent = columns.length > 0;
  currentColumnPresent = originalColumnPresent;
  if (!originalColumnPresent) return;
  historicalValues = await getDb().execute<{ id: string; scopes: string[] }>(sql`
    SELECT id, scopes FROM application_workload_identities
  `);
  const [check] = await getDb().execute<{ definition: string }>(sql`
    SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='public.application_workload_identities'::regclass
      AND conname='application_workload_identities_scopes_check'
  `);
  constraint = check?.definition ?? null;
});

afterAll(async () => {
  try {
    if (originalColumnPresent && !currentColumnPresent) {
      await getDb().execute(sql`
        ALTER TABLE application_workload_identities ADD COLUMN scopes text[] NOT NULL DEFAULT '{}'::text[]
      `);
      for (const row of historicalValues) {
        await getDb().execute(sql`
          UPDATE application_workload_identities SET scopes=${sql.param(row.scopes)}::text[] WHERE id=${row.id}
        `);
      }
      if (constraint) {
        await getDb().execute(sql`
          ALTER TABLE application_workload_identities ADD CONSTRAINT application_workload_identities_scopes_check
          ${sql.raw(constraint)}
        `);
      }
    }
    if (!originalColumnPresent && currentColumnPresent) {
      await getDb().execute(sql`ALTER TABLE application_workload_identities DROP COLUMN scopes`);
    }
  } finally {
    await closePostgres();
  }
});

const actor = { isPlatformStaff: true, describedAs: 'column compatibility test' };

async function application() {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: 'Scope column compatibility',
      ownerAccountId: owner.id,
      isOfficial: true,
      status: 'active',
      scopes: ['user:read'],
    })
    .returning({ id: applications.id });
  return app;
}

describe.each([true, false])('physical workload scopes column present=%s', (present) => {
  beforeAll(async () => {
    if (present === currentColumnPresent) return;
    if (present) {
      await getDb().execute(
        sql`ALTER TABLE application_workload_identities ADD COLUMN scopes text[] NOT NULL DEFAULT '{}'::text[]`,
      );
    } else {
      await getDb().execute(sql`ALTER TABLE application_workload_identities DROP COLUMN scopes`);
    }
    currentColumnPresent = present;
  });

  it('provisions concurrently, preserves typed metadata and attribution, and reruns idempotently', async () => {
    const app = await application();
    const expiry = new Date(Date.now() + 3_600_000);
    const request = {
      applicationId: app.id,
      subject: `arn:aws:iam::237343248947:role/test-${randomUUID()}`,
      environment: deploymentCredentialEnvironment(),
      description: "quoted ' description",
      expiresAt: expiry,
      actor,
    };
    const results = await Promise.all([
      bindWorkloadIdentity(request),
      bindWorkloadIdentity(request),
    ]);
    expect(results.filter((result) => result.state === 'created')).toHaveLength(1);
    expect(results[0].binding.id).toBe(results[1].binding.id);
    expect(results[0].binding.createdAt).toBeInstanceOf(Date);
    expect(results[0].binding.expiresAt).toEqual(expiry);
    expect(results[0].binding.description).toBe(request.description);
    expect(results[0].binding).not.toHaveProperty('scopes');
    expect(await listWorkloadIdentityBindings(app.id)).toEqual([results[0].binding]);
    expect(await bindWorkloadIdentity(request)).toMatchObject({
      state: 'unchanged',
      binding: { id: results[0].binding.id },
    });
    const [attribution] = await getDb()
      .select({
        bindingId: applicationCredentials.workloadIdentityId,
        scopes: applicationCredentials.scopes,
      })
      .from(applicationCredentials)
      .where(eq(applicationCredentials.id, results[0].binding.attestationId));
    expect(attribution).toEqual({ bindingId: results[0].binding.id, scopes: [] });
    const [externalCeiling] = await getDb()
      .select({ scopes: applications.scopes })
      .from(applications)
      .where(eq(applications.id, app.id));
    expect(externalCeiling.scopes).toEqual(['user:read']);
  });

  it('resolves live scope-free authority and expiry while rejecting repointing and environment drift', async () => {
    const app = await application();
    const other = await application();
    const request = {
      applicationId: app.id,
      subject: `arn:aws:iam::237343248947:role/test-${randomUUID()}`,
      environment: deploymentCredentialEnvironment(),
      actor,
    };
    const result = await bindWorkloadIdentity(request);
    const resolve = () => resolveLiveAgencyWorkloadByHandle(app.id, result.binding.attestationId);
    expect(await resolve()).toMatchObject({
      applicationId: app.id,
      environment: request.environment,
    });
    expect(await resolve()).not.toHaveProperty('scopes');
    await expect(
      bindWorkloadIdentity({ ...request, applicationId: other.id }),
    ).rejects.toMatchObject({ reason: 'subject_bound_elsewhere' });
    await expect(
      bindWorkloadIdentity({
        ...request,
        environment: request.environment === 'staging' ? 'production' : 'staging',
      }),
    ).rejects.toMatchObject({
      reason: 'environment_conflict',
    });
    await getDb()
      .update(applicationWorkloadIdentities)
      .set({ expiresAt: new Date(0) })
      .where(eq(applicationWorkloadIdentities.id, result.binding.id));
    expect(await resolve()).toBeNull();
  });

  it.each([
    'auth/read-service-authority-inventory.mjs',
    'inference/read-internal-pilot-readiness.mjs',
    'agency/read-oxy-profile-registrar-preflight.mjs',
  ])('keeps the actual read-only operator %s compatible with this physical schema', (script) => {
    const root = resolve(__dirname, '../../../../..');
    const moduleUrl = pathToFileURL(resolve(root, 'scripts', script)).href;
    const output = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    const {readInventory} = await import(${JSON.stringify(moduleUrl)});
    const result = await readInventory('oxy', process.env.DATABASE_URL);
    const binding = result.tables.application_workload_identities;
    process.stdout.write(JSON.stringify({
      readOnly: result.readOnly, status: binding.status,
      scopesProjected: binding.rows.some(row => Object.hasOwn(row, 'scopes')),
      environmentsProjected: binding.rows.every(row => Object.hasOwn(row, 'environment')),
    }));
  `,
      ],
      { cwd: resolve(root, 'packages/api'), env: process.env, encoding: 'utf8' },
    );
    expect(JSON.parse(output)).toEqual({
      readOnly: true,
      status: 'complete',
      scopesProjected: false,
      environmentsProjected: true,
    });
  });
});
