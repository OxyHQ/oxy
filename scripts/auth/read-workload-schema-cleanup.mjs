/** Bounded, read-only before/after evidence for the workload scope-column DROP.
 * Importing connects nowhere. Run from packages/api with the reviewed DB-only
 * operator task; no task role, provider secret, bearer or application startup.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(`${process.cwd()}/package.json`);
const postgres = require('postgres');
const MAX_ROWS = 1000;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const summary = (rows) => {
  if (rows.length > MAX_ROWS) throw new Error('Workload metadata row bound exceeded');
  return { count: rows.length, sha256: digest(rows) };
};

export async function readWorkloadSchemaCleanup(databaseUrl) {
  if (!databaseUrl) throw new Error('Database URL required');
  const client = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 10,
    prepare: false,
    onnotice: () => {},
  });
  try {
    return await client.begin('isolation level repeatable read read only', async (tx) => {
      await tx`SET LOCAL statement_timeout='15000ms'`;
      await tx`SET LOCAL lock_timeout='3000ms'`;
      await tx`SET LOCAL idle_in_transaction_session_timeout='30000ms'`;
      await tx`SET LOCAL TIME ZONE 'UTC'`;
      const [safety] = await tx`
        SELECT current_setting('transaction_read_only') AS read_only,
          current_setting('transaction_isolation') AS isolation,
          current_database() AS database, transaction_timestamp()::text AS observed_at
      `;
      if (safety.read_only !== 'on' || safety.isolation !== 'repeatable read')
        throw new Error('Required read-only snapshot absent');

      const columns = await tx`
        SELECT a.attnum FROM pg_attribute a
        WHERE a.attrelid='public.application_workload_identities'::regclass
          AND a.attname='scopes' AND NOT a.attisdropped
      `;
      const checks = await tx`
        SELECT 1 FROM pg_constraint
        WHERE conrelid='public.application_workload_identities'::regclass
          AND conname='application_workload_identities_scopes_check'
      `;
      const unexpectedDependencies = columns.length
        ? await tx`
        SELECT d.classid::regclass::text AS catalog,
          pg_describe_object(d.classid,d.objid,d.objsubid) AS object
        FROM pg_depend d
        WHERE d.refclassid='pg_class'::regclass
          AND d.refobjid='public.application_workload_identities'::regclass
          AND d.refobjsubid=${columns[0].attnum}
          AND NOT (d.classid='pg_attrdef'::regclass AND EXISTS (
            SELECT 1 FROM pg_attrdef a WHERE a.oid=d.objid
              AND a.adrelid=d.refobjid AND a.adnum=d.refobjsubid))
          AND NOT (d.classid='pg_constraint'::regclass AND EXISTS (
            SELECT 1 FROM pg_constraint c WHERE c.oid=d.objid
              AND c.conrelid=d.refobjid AND c.conname='application_workload_identities_scopes_check'))
        ORDER BY catalog, object LIMIT ${MAX_ROWS + 1}
      `
        : [];
      if (unexpectedDependencies.length > MAX_ROWS)
        throw new Error('Dependency row bound exceeded');

      // Never read the retired scope values, secrets, tokens or personal data.
      const bindings = await tx`
        SELECT id, application_id, provider, subject, environment, description,
          expires_at::text, created_at::text, updated_at::text
        FROM application_workload_identities ORDER BY id LIMIT ${MAX_ROWS + 1}
      `;
      const attribution = await tx`
        SELECT id, application_id, workload_identity_id, type, environment, status,
          expires_at::text, created_at::text, updated_at::text
        FROM application_credentials WHERE type='workload' ORDER BY id LIMIT ${MAX_ROWS + 1}
      `;
      const relations = await tx`
        SELECT conrelid::regclass::text AS source, conname,
          confrelid::regclass::text AS target, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE contype='f' AND (
          conrelid='public.application_workload_identities'::regclass OR
          confrelid='public.application_workload_identities'::regclass)
        ORDER BY source,conname LIMIT ${MAX_ROWS + 1}
      `;
      // Catalog dependencies cannot discover every dynamic SQL string. Record
      // bounded routine-source matches without returning routine bodies, plus
      // trigger/view definitions. Split/computed dynamic identifiers still need
      // the separate source/operator audit documented in the rollout runbook.
      const routineReferences = await tx`
        SELECT n.nspname AS schema_name, p.proname,
          pg_get_function_identity_arguments(p.oid) AS arguments,
          p.prosrc AS source
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema')
          AND p.prosrc ILIKE '%application_workload_identities%'
        ORDER BY schema_name,p.proname,arguments LIMIT ${MAX_ROWS + 1}
      `;
      const routineScopeReferences = routineReferences.filter((row) =>
        /\bscopes\b/i.test(row.source),
      );
      const triggers = await tx`
        SELECT t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) AS definition,
          p.prosrc AS function_source
        FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE t.tgrelid='public.application_workload_identities'::regclass AND NOT t.tgisinternal
        ORDER BY t.tgname LIMIT ${MAX_ROWS + 1}
      `;
      const views = await tx`
        SELECT schemaname,viewname,definition FROM pg_views
        WHERE schemaname NOT IN ('pg_catalog','information_schema')
          AND definition ILIKE '%application_workload_identities%'
        UNION ALL
        SELECT schemaname,matviewname AS viewname,definition FROM pg_matviews
        WHERE schemaname NOT IN ('pg_catalog','information_schema')
          AND definition ILIKE '%application_workload_identities%'
        ORDER BY schemaname,viewname LIMIT ${MAX_ROWS + 1}
      `;
      const externalColumns = await tx`
        SELECT c.relname AS table_name, a.attname, format_type(a.atttypid,a.atttypmod) AS type,
          a.attnotnull, pg_get_expr(d.adbin,d.adrelid) AS default_expression
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid IN ('public.applications'::regclass,'public.application_credentials'::regclass)
          AND a.attname='scopes' AND NOT a.attisdropped ORDER BY c.relname
      `;
      const externalChecks = await tx`
        SELECT c.conrelid::regclass::text AS table_name,c.conname,pg_get_constraintdef(c.oid) AS definition
        FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
        WHERE c.contype='c' AND c.conrelid IN ('public.applications'::regclass,'public.application_credentials'::regclass)
          AND a.attname='scopes' AND NOT a.attisdropped ORDER BY table_name,c.conname
      `;
      if (externalColumns.length !== 2 || externalChecks.length < 2)
        throw new Error('External scope schema is incomplete');
      return {
        kind: 'workload-schema-cleanup',
        version: 1,
        readOnly: true,
        database: safety.database,
        observedAt: safety.observed_at,
        isolation: safety.isolation,
        legacyColumnPresent: columns.length === 1,
        legacyConstraintPresent: checks.length === 1,
        unexpectedDependencies,
        routineReferences: summary(routineReferences),
        routineScopeReferences: summary(routineScopeReferences),
        bindingTriggers: summary(triggers),
        triggerScopeReferences: summary(
          triggers.filter((row) => /\bscopes\b/i.test(row.function_source)),
        ),
        bindingViews: summary(views),
        bindings: summary(bindings),
        workloadAttribution: summary(attribution),
        bindingRelations: summary(relations),
        externalScopeColumns: summary(externalColumns),
        externalScopeChecks: summary(externalChecks),
      };
    });
  } finally {
    await client.end({ timeout: 5 });
  }
}

export function compareWorkloadSchemaCleanup(before, after) {
  for (const value of [before, after]) {
    if (
      value?.kind !== 'workload-schema-cleanup' ||
      value.version !== 1 ||
      value.readOnly !== true ||
      value.isolation !== 'repeatable read' ||
      !Array.isArray(value.unexpectedDependencies) ||
      value.unexpectedDependencies.length ||
      value.routineScopeReferences?.count !== 0 ||
      value.triggerScopeReferences?.count !== 0
    )
      throw new Error('Invalid or dependency-blocked cleanup receipt');
  }
  if (
    before.database !== after.database ||
    !before.legacyColumnPresent ||
    !before.legacyConstraintPresent ||
    after.legacyColumnPresent ||
    after.legacyConstraintPresent
  )
    throw new Error('Receipts do not describe the expected column removal');
  for (const key of [
    'routineReferences',
    'routineScopeReferences',
    'bindingTriggers',
    'triggerScopeReferences',
    'bindingViews',
    'bindings',
    'workloadAttribution',
    'bindingRelations',
    'externalScopeColumns',
    'externalScopeChecks',
  ]) {
    if (
      !Number.isSafeInteger(before[key]?.count) ||
      before[key].count < 0 ||
      before[key]?.count !== after[key]?.count ||
      !/^[a-f0-9]{64}$/.test(before[key]?.sha256 ?? '') ||
      before[key].sha256 !== after[key]?.sha256
    )
      throw new Error(`Cleanup changed ${key}`);
  }
  return {
    verified: true,
    columnRemoved: true,
    preserved: [
      'routineReferences',
      'routineScopeReferences',
      'bindingTriggers',
      'triggerScopeReferences',
      'bindingViews',
      'bindings',
      'workloadAttribution',
      'bindingRelations',
      'externalScopeColumns',
      'externalScopeChecks',
    ],
  };
}
