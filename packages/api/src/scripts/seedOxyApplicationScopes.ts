/** Official seed's DB-operator boundary, restricted to existing exact-ID scope unions.
 * No HTTP identity, staff session, credential or membership is manufactured here.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../config/postgres';
import {
  applications,
  applicationCredentials,
  applicationWorkloadIdentities,
  accountClosureFences,
  users,
} from '../db/schema';
import {
  intersectScopes,
  isValidApplicationScope,
  workloadBindingScopes,
} from '../utils/applicationScopes';
import { MENTION_CLASSIFIER_IDENTITY } from '../config/mentionClassifierEconomics';
import { selectSeedEntriesByExactIds } from './seedEntrySelection';
import { SEED_APPS } from './seedOxyApplicationsSpecs';

const sorted = (values: readonly string[]) => [...new Set(values)].sort();
const fail = (code: string): never => {
  throw new Error(code);
};
export interface ScopeSeedOptions {
  onlyAppIds: string;
  apply: boolean;
  expectedPlanSha256?: string;
}
export function scopeSeedOptions(env: NodeJS.ProcessEnv): ScopeSeedOptions {
  if (
    env.SCOPES_ONLY !== 'true' ||
    env.ONLY_APPS !== undefined ||
    !env.ONLY_APP_IDS ||
    (env.OXY_USERNAME !== undefined && env.OXY_USERNAME !== 'oxy')
  )
    fail('scope_seed_explicit_ids_required');
  if (env.DRY_RUN !== undefined && !['true', '1', 'false', '0'].includes(env.DRY_RUN))
    fail('scope_seed_invalid_dry_run');
  const apply = env.DRY_RUN !== 'true' && env.DRY_RUN !== '1';
  if (
    apply
      ? !/^[a-f0-9]{64}$/.test(env.EXPECTED_PLAN_SHA256 ?? '')
      : env.EXPECTED_PLAN_SHA256 !== undefined
  ) {
    fail('scope_seed_plan_hash_required');
  }
  return {
    onlyAppIds: env.ONLY_APP_IDS ?? fail('scope_seed_explicit_ids_required'),
    apply,
    ...(env.EXPECTED_PLAN_SHA256 === undefined
      ? {}
      : { expectedPlanSha256: env.EXPECTED_PLAN_SHA256 }),
  };
}

export async function seedOxyApplicationScopes(options: ScopeSeedOptions) {
  if (
    !options.onlyAppIds ||
    (options.apply && !/^[a-f0-9]{64}$/.test(options.expectedPlanSha256 ?? ''))
  ) {
    fail('scope_seed_plan_hash_required');
  }
  const selected = selectSeedEntriesByExactIds(SEED_APPS, options.onlyAppIds, {
    envVar: 'ONLY_APP_IDS',
    singular: 'application',
    plural: 'applications',
  })
    .map((spec) => ({
      ...spec,
      id: spec.id ?? fail('scope_seed_exact_id_required'),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return getDb().transaction(
    async (tx) => {
      await tx.execute(sql`SELECT set_config('statement_timeout','25000',true),
      set_config('lock_timeout','3000',true),set_config('idle_in_transaction_session_timeout','30000',true)`);
      // Closure uses the same user row FOR UPDATE before installing its fence.
      const readOwner = async (username: string) => {
        const query = tx
          .select({
            id: users.id,
            kind: users.kind,
            status: users.accountStatus,
            parentAccountId: users.parentAccountId,
            type: users.type,
          })
          .from(users)
          .where(sql`lower(btrim(${users.username})) = lower(btrim(${username}))`)
          .limit(2);
        const rows = await (options.apply ? query.for('update') : query);
        if (rows.length !== 1 || rows[0].status !== 'active' || rows[0].type !== 'local')
          fail('scope_seed_owner_not_active');
        const [fence] = await tx
          .select({ id: accountClosureFences.accountId })
          .from(accountClosureFences)
          .where(eq(accountClosureFences.accountId, rows[0].id));
        if (fence) fail('scope_seed_owner_fenced');
        return rows[0];
      };
      const platformOwner = await readOwner('oxy');
      const rows = [];
      for (const spec of selected) {
        const owner =
          spec.ownerAccountUsername === undefined
            ? platformOwner
            : await readOwner(spec.ownerAccountUsername);
        if (
          spec.ownerAccountUsername !== undefined &&
          (owner.kind !== 'project' || owner.parentAccountId !== platformOwner.id)
        ) {
          fail('scope_seed_dedicated_owner_mismatch');
        }
        const query = tx
          .select({
            id: applications.id,
            name: applications.name,
            createdByUserId: applications.createdByUserId,
            ownerAccountId: applications.ownerAccountId,
            type: applications.type,
            isInternal: applications.isInternal,
            isOfficial: applications.isOfficial,
            status: applications.status,
            scopes: applications.scopes,
          })
          .from(applications)
          .where(eq(applications.id, spec.id));
        const [app] = await (options.apply ? query.for('update') : query);
        if (
          !app ||
          app.name !== spec.name ||
          app.createdByUserId !== platformOwner.id ||
          app.ownerAccountId !== owner.id ||
          app.type !== spec.type ||
          app.isInternal !== (spec.type === 'internal') ||
          !app.isOfficial ||
          app.status !== 'active'
        )
          fail('scope_seed_application_identity_mismatch');
        if (!app.scopes.every(isValidApplicationScope)) fail('scope_seed_unknown_existing_scope');
        const desired = sorted([...app.scopes, ...(spec.scopes ?? ['user:read'])]);
        const bindingQuery = tx
          .select({
            id: applicationWorkloadIdentities.id,
            provider: applicationWorkloadIdentities.provider,
            subject: applicationWorkloadIdentities.subject,
            scopes: applicationWorkloadIdentities.scopes,
            expiresAt: applicationWorkloadIdentities.expiresAt,
          })
          .from(applicationWorkloadIdentities)
          .where(eq(applicationWorkloadIdentities.applicationId, app.id))
          .orderBy(asc(applicationWorkloadIdentities.id));
        const bindings = await (options.apply ? bindingQuery.for('update') : bindingQuery);
        const credentialQuery = tx
          .select({
            id: applicationCredentials.id,
            type: applicationCredentials.type,
            environment: applicationCredentials.environment,
            status: applicationCredentials.status,
            scopes: applicationCredentials.scopes,
            expiresAt: applicationCredentials.expiresAt,
            workloadIdentityId: applicationCredentials.workloadIdentityId,
          })
          .from(applicationCredentials)
          .where(eq(applicationCredentials.applicationId, app.id))
          .orderBy(asc(applicationCredentials.id));
        const credentials = await (options.apply ? credentialQuery.for('update') : credentialQuery);
        const expansions: Array<{
          kind: 'binding' | 'credential';
          id: string;
          added: string[];
        }> = [];
        for (const binding of bindings) {
          const before = workloadBindingScopes(binding.scopes, app.scopes);
          const added = workloadBindingScopes(binding.scopes, desired).filter(
            (scope) => !before.includes(scope),
          );
          const own =
            app.id === MENTION_CLASSIFIER_IDENTITY.applicationId &&
            binding.id === MENTION_CLASSIFIER_IDENTITY.bindingId &&
            binding.subject === MENTION_CLASSIFIER_IDENTITY.subject &&
            binding.provider === 'aws-iam';
          if (added.length && !own)
            expansions.push({
              kind: 'binding',
              id: binding.id,
              added: sorted(added),
            });
        }
        for (const credential of credentials) {
          if (credential.type === 'workload') continue; // Its binding, not attribution-row scopes, is authoritative.
          const before =
            credential.type === 'service' && !credential.scopes.length
              ? app.scopes
              : intersectScopes(credential.scopes, app.scopes);
          const after =
            credential.type === 'service' && !credential.scopes.length
              ? desired
              : intersectScopes(credential.scopes, desired);
          const added = after.filter((scope) => !before.includes(scope));
          if (added.length)
            expansions.push({
              kind: 'credential',
              id: credential.id,
              added: sorted(added),
            });
        }
        rows.push({
          identity: app,
          owner,
          ownerClosureFenced: false,
          before: [...app.scopes],
          desired,
          added: desired.filter((scope) => !app.scopes.includes(scope)),
          bindings,
          credentials,
          nonTargetExpansions: expansions,
        });
      }
      const plan = {
        kind: 'official-application-scopes-only-v1',
        platformOwner,
        applications: rows,
      };
      const planSha256 = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
      const refused = rows.some((row) => row.nonTargetExpansions.length > 0);
      if (options.apply && (options.expectedPlanSha256 !== planSha256 || refused)) {
        fail(refused ? 'scope_seed_non_target_expansion' : 'scope_seed_plan_changed');
      }
      let changed = 0;
      if (options.apply) {
        for (const row of rows) {
          if (!row.added.length) continue;
          // Preserve the timestamp too: the shared column has an automatic onUpdate hook.
          // Row lock plus exact prior scopes prevents lost updates; metadata values remain identical.
          const updated = await tx
            .update(applications)
            .set({
              scopes: row.desired,
              updatedAt: sql`${applications.updatedAt}`,
            })
            .where(
              and(
                eq(applications.id, row.identity.id),
                sql`${applications.scopes} = ${sql.param(row.before)}::text[]`,
              ),
            )
            .returning({ id: applications.id });
          if (updated.length !== 1) fail('scope_seed_scope_cas_failed');
          changed++;
        }
      }
      return {
        ...plan,
        planSha256,
        applied: options.apply,
        changed,
        applyEligible: !refused,
        authority: 'existing_official_seed_database_operator',
        sessionCreated: false,
        noCredentialOrMetadataWrites: true,
        oauthSessionGrantSemanticsNotEvaluated: true,
      };
    },
    {
      isolationLevel: options.apply ? 'serializable' : 'repeatable read',
      accessMode: options.apply ? 'read write' : 'read only',
    },
  );
}

/** Shipped Node entrypoint; the source Bun wrapper calls this exact implementation. */
export async function scopeSeedMain(
  args = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
) {
  if (args.length) fail('scope_seed_arguments_not_supported');
  const options = scopeSeedOptions(env);
  // Validate the exact-ID filter before even connecting, including unknown/duplicate IDs.
  selectSeedEntriesByExactIds(SEED_APPS, options.onlyAppIds, {
    envVar: 'ONLY_APP_IDS',
    singular: 'application',
    plural: 'applications',
  });
  await connectPostgres();
  try {
    console.log(JSON.stringify(await seedOxyApplicationScopes(options)));
  } finally {
    await closePostgres();
  }
}
if (require.main === module)
  scopeSeedMain().catch(() => {
    console.error(
      'Official scopes-only seed refused; inspect the reviewed plan and current state before retrying.',
    );
    process.exitCode = 1;
  });
