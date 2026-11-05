/** The rollback bridge must provision and resolve authority after the later DROP. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { applicationWorkloadIdentities } from '../../db/schema/applicationWorkloadIdentities';
import { users } from '../../db/schema/users';
import { createTestDatabase, dropTestDatabase } from '../../db/testDatabase';
import { deploymentCredentialEnvironment } from '../../utils/credentialEnvironment';
import { resolveLiveAgencyWorkloadByHandle } from '../agencyServicePrincipal.service';
import {
  bindWorkloadIdentity,
  listWorkloadIdentityBindings,
} from '../workloadIdentityBinding.service';

const originalDatabaseUrl = process.env.DATABASE_URL;
let ownDatabaseUrl: string | undefined;
let currentColumnPresent = false;
let operatorBindingId: string;

beforeAll(async () => {
  // Operator inventories are deliberately bounded. Other suites leave more
  // than 20 catalog:oxy applications in the worker database; this schema test
  // needs its own migrated database, not altered production inventory limits.
  ownDatabaseUrl = await createTestDatabase();
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
  currentColumnPresent = columns.length > 0;
  const app = await application({
    // The inference operator selects this fixed pilot id; catalog:oxy also
    // includes the same synthetic application in the registrar's projection.
    id: '6a2f851751b784a86fd0e934',
    capabilities: ['catalog:oxy'],
  });
  const result = await bindWorkloadIdentity({
    applicationId: app.id,
    subject: `arn:aws:iam::237343248947:role/test-operator-${randomUUID()}`,
    environment: deploymentCredentialEnvironment(),
    actor,
  });
  operatorBindingId = result.binding.id;
}, 60_000);

afterAll(async () => {
  try {
    await closePostgres();
  } finally {
    try {
      if (ownDatabaseUrl) await dropTestDatabase(ownDatabaseUrl);
    } finally {
      if (originalDatabaseUrl === undefined) Reflect.deleteProperty(process.env, 'DATABASE_URL');
      else process.env.DATABASE_URL = originalDatabaseUrl;
    }
  }
}, 60_000);

const actor = { isPlatformStaff: true, describedAs: 'column compatibility test' };

async function application(values: { id?: string; capabilities?: string[] } = {}) {
  const [owner] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  const [app] = await getDb()
    .insert(applications)
    .values({
      name: 'Scope column compatibility',
      ownerAccountId: owner.id,
      isOfficial: true,
      status: 'active',
      scopes: ['user:read'],
      ...values,
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
      applicationsStatus: result.tables.applications.status,
      fixtureIncluded: binding.rows.some(row => row.id === ${JSON.stringify(operatorBindingId)}),
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
      applicationsStatus: 'complete',
      fixtureIncluded: true,
      scopesProjected: false,
      environmentsProjected: true,
    });
  });
});

describe('generated physical cleanup and bounded operational evidence', () => {
  const root = resolve(__dirname, '../../../../..');
  const moduleUrl = pathToFileURL(
    resolve(root, 'scripts/auth/read-workload-schema-cleanup.mjs'),
  ).href;
  const runOperator = (code: string, runtime = process.execPath) =>
    JSON.parse(
      execFileSync(
        runtime,
        [
          '--input-type=module',
          '-e',
          `
      const { readWorkloadSchemaCleanup, compareWorkloadSchemaCleanup } = await import(${JSON.stringify(moduleUrl)});
      ${code}
    `,
        ],
        { cwd: resolve(root, 'packages/api'), env: process.env, encoding: 'utf8' },
      ),
    );
  const readReceipt = () =>
    runOperator(
      `process.stdout.write(JSON.stringify(await readWorkloadSchemaCleanup(process.env.DATABASE_URL)));`,
    );

  it('drops only the retired column/check and preserves binding metadata, relations and external scope schema', async () => {
    const oldSnapshot = JSON.parse(
      readFileSync(resolve(root, 'packages/api/drizzle/meta/0219_snapshot.json'), 'utf8'),
    );
    const oldCheck =
      oldSnapshot.tables['public.application_workload_identities'].checkConstraints
        .application_workload_identities_scopes_check.value;
    await getDb().execute(
      sql`ALTER TABLE application_workload_identities ADD COLUMN scopes text[] NOT NULL DEFAULT '{}'::text[]`,
    );
    currentColumnPresent = true;
    await getDb().execute(
      sql.raw(
        `ALTER TABLE application_workload_identities ADD CONSTRAINT application_workload_identities_scopes_check CHECK (${oldCheck})`,
      ),
    );
    const app = await application();
    await bindWorkloadIdentity({
      applicationId: app.id,
      subject: `arn:aws:iam::237343248947:role/drop-${randomUUID()}`,
      environment: deploymentCredentialEnvironment(),
      actor,
    });

    const [externalCredential] = await getDb()
      .insert(applicationCredentials)
      .values({
        applicationId: app.id,
        name: 'External ceiling preserved',
        publicKey: `oxy_dk_${randomUUID()}`,
        secretHash: 'test-only-secret-hash',
        type: 'service',
        environment: 'production',
        scopes: ['user:read'],
        status: 'active',
      })
      .returning({ id: applicationCredentials.id });

    // Unexpected dependencies must be reviewed, never silently CASCADE-dropped.
    await getDb().execute(
      sql`CREATE VIEW workload_scope_cleanup_test_view AS SELECT scopes FROM application_workload_identities`,
    );
    const blocked = readReceipt();
    expect(blocked.unexpectedDependencies.length).toBeGreaterThan(0);
    expect(
      runOperator(
        `try { compareWorkloadSchemaCleanup(${JSON.stringify(blocked)}, ${JSON.stringify(blocked)}); process.stdout.write('false'); } catch { process.stdout.write('true'); }`,
      ),
    ).toBe(true);
    await getDb().execute(sql`DROP VIEW workload_scope_cleanup_test_view`);
    await getDb().execute(
      sql`CREATE FUNCTION workload_scope_cleanup_test_function() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM NEW.scopes; RETURN NEW; END;$$`,
    );
    await getDb().execute(
      sql`CREATE TRIGGER workload_scope_cleanup_test_trigger BEFORE UPDATE ON application_workload_identities FOR EACH ROW EXECUTE FUNCTION workload_scope_cleanup_test_function()`,
    );
    const triggerBlocked = readReceipt();
    expect(triggerBlocked.triggerScopeReferences.count).toBe(1);
    expect(
      runOperator(
        `try { compareWorkloadSchemaCleanup(${JSON.stringify(triggerBlocked)}, ${JSON.stringify(triggerBlocked)}); process.stdout.write('false'); } catch { process.stdout.write('true'); }`,
      ),
    ).toBe(true);
    await getDb().execute(
      sql`DROP TRIGGER workload_scope_cleanup_test_trigger ON application_workload_identities`,
    );
    await getDb().execute(sql`DROP FUNCTION workload_scope_cleanup_test_function()`);
    // SQL-language string bodies are not reliably represented by pg_depend.
    await getDb().execute(
      sql`CREATE FUNCTION workload_scope_cleanup_test_routine() RETURNS integer LANGUAGE sql AS $$SELECT cardinality(scopes) FROM application_workload_identities LIMIT 1$$`,
    );
    const routineBlocked = readReceipt();
    expect(routineBlocked.routineReferences.count).toBe(1);
    expect(routineBlocked.routineScopeReferences.count).toBe(1);
    expect(
      runOperator(
        `try { compareWorkloadSchemaCleanup(${JSON.stringify(routineBlocked)}, ${JSON.stringify(routineBlocked)}); process.stdout.write('false'); } catch { process.stdout.write('true'); }`,
      ),
    ).toBe(true);
    await getDb().execute(sql`DROP FUNCTION workload_scope_cleanup_test_routine()`);
    const before = readReceipt();
    expect(before).toMatchObject({
      readOnly: true,
      legacyColumnPresent: true,
      legacyConstraintPresent: true,
      unexpectedDependencies: [],
    });
    expect(before.bindings.count).toBeGreaterThan(0);
    expect(before.workloadAttribution.count).toBeGreaterThan(0);

    const migration = readFileSync(
      resolve(root, 'packages/api/drizzle/0220_drop_workload_scope_column.sql'),
      'utf8',
    );
    expect(migration).toContain('-- oxy:deploy-phase=post');
    await getDb().transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout='3000ms'`);
      for (const statement of migration.split('--> statement-breakpoint')) {
        if (statement.trim()) await tx.execute(sql.raw(statement));
      }
    });
    currentColumnPresent = false;
    const after = readReceipt();
    const bunReceipt = runOperator(
      `process.stdout.write(JSON.stringify(await readWorkloadSchemaCleanup(process.env.DATABASE_URL)));`,
      'bun',
    );
    expect(bunReceipt.bindings).toEqual(after.bindings);
    expect(bunReceipt.externalScopeColumns).toEqual(after.externalScopeColumns);

    const result = runOperator(
      `process.stdout.write(JSON.stringify(compareWorkloadSchemaCleanup(${JSON.stringify(before)}, ${JSON.stringify(after)})));`,
    );
    expect(result).toMatchObject({ verified: true, columnRemoved: true });
    expect(after).toMatchObject({ legacyColumnPresent: false, legacyConstraintPresent: false });
    for (const key of [
      'bindings',
      'workloadAttribution',
      'bindingRelations',
      'externalScopeColumns',
      'externalScopeChecks',
    ]) {
      expect(after[key]).toEqual(before[key]);
      const changed = { ...after, [key]: { ...after[key], sha256: '0'.repeat(64) } };
      expect(
        runOperator(
          `try { compareWorkloadSchemaCleanup(${JSON.stringify(before)}, ${JSON.stringify(changed)}); process.stdout.write('false'); } catch { process.stdout.write('true'); }`,
        ),
      ).toBe(true);
    }
    const [ceiling] = await getDb()
      .select({ scopes: applications.scopes })
      .from(applications)
      .where(eq(applications.id, app.id));
    expect(ceiling.scopes).toEqual(['user:read']);
    const [credentialCeiling] = await getDb()
      .select({ scopes: applicationCredentials.scopes })
      .from(applicationCredentials)
      .where(eq(applicationCredentials.id, externalCredential.id));
    expect(credentialCeiling.scopes).toEqual(['user:read']);
  });
});
