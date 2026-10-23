#!/usr/bin/env bun
/**
 * Environment preflight for the observed production cohort. Dry-run is default.
 * Apply only after the nullable-column migration and before enabling v2 clients:
 * bun run scripts/provision-workload-environments.ts --environment production [--apply]
 * Exact id/app/provider/subject matching and one locked transaction prevent drift.
 * No grants, scope fields, credentials, owners or other metadata are changed.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import { LEGACY_WORKLOAD_BINDINGS } from '../src/config/legacyWorkloadTransition';
import { applicationWorkloadIdentities } from '../src/db/schema/applicationWorkloadIdentities';
import { applications } from '../src/db/schema/applications';
import { isTrustedApplication } from '../src/utils/trustedApplication';

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  if (args.filter((value) => value !== '--apply').join(' ') !== '--environment production') {
    throw new Error(
      'Expected --environment production [--apply]; the reviewed cohort belongs to production.',
    );
  }
  await connectPostgres();
  try {
    const report = await getDb().transaction(async (tx) => {
      const changes: Array<{ bindingId: string; applicationId: string; state: string }> = [];
      // Validate the whole cohort before any write. Locks also make CAS outcomes stable.
      for (const expected of LEGACY_WORKLOAD_BINDINGS) {
        const [binding] = await tx
          .select()
          .from(applicationWorkloadIdentities)
          .where(eq(applicationWorkloadIdentities.id, expected.id))
          .for('update');
        if (
          !binding ||
          binding.applicationId !== expected.applicationId ||
          binding.provider !== expected.provider ||
          binding.subject !== expected.subject
        ) {
          throw new Error(
            `Binding ${expected.id} differs from the reviewed inventory; refresh the inventory before provisioning.`,
          );
        }
        if (binding.environment !== null && binding.environment !== 'production')
          throw new Error(`Binding ${expected.id} already belongs to another environment.`);
        if (binding.expiresAt && binding.expiresAt <= new Date())
          throw new Error(`Binding ${expected.id} has expired.`);
        const [app] = await tx
          .select()
          .from(applications)
          .where(eq(applications.id, expected.applicationId))
          .for('share');
        if (!app || app.status !== 'active' || !isTrustedApplication(app))
          throw new Error(`Application ${expected.applicationId} is unavailable.`);
        changes.push({
          bindingId: expected.id,
          applicationId: expected.applicationId,
          state: binding.environment === null ? 'needs_provisioning' : 'unchanged',
        });
      }
      if (apply)
        for (const change of changes) {
          if (change.state === 'unchanged') continue;
          const rows = await tx
            .update(applicationWorkloadIdentities)
            .set({ environment: 'production', updatedAt: new Date() })
            .where(
              and(
                eq(applicationWorkloadIdentities.id, change.bindingId),
                eq(applicationWorkloadIdentities.applicationId, change.applicationId),
                isNull(applicationWorkloadIdentities.environment),
              ),
            )
            .returning({ id: applicationWorkloadIdentities.id });
          if (rows.length !== 1)
            throw new Error(`Binding ${change.bindingId} changed concurrently.`);
          change.state = 'provisioned';
        }
      return changes;
    });
    process.stdout.write(
      `${JSON.stringify({ apply, environment: 'production', bindings: report })}\n`,
    );
  } finally {
    await closePostgres();
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Provisioning failed');
    process.exitCode = 1;
  });
