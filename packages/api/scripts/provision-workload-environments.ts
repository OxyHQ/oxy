#!/usr/bin/env bun
/** Stage-one environment backfill. Dry-run by default; never changes token issuance. */
import { and, eq, isNull, notInArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import { LEGACY_WORKLOAD_BINDINGS } from '../src/config/legacyWorkloadTransition';
import { applicationWorkloadIdentities as bindings } from '../src/db/schema/applicationWorkloadIdentities';
import { applications } from '../src/db/schema/applications';
import { isTrustedApplication } from '../src/utils/trustedApplication';

type Database = ReturnType<typeof getDb>;
const identityColumns = {
  id: bindings.id,
  applicationId: bindings.applicationId,
  provider: bindings.provider,
  subject: bindings.subject,
  environment: bindings.environment,
};

/** Fixed reviewed inventory only; callers cannot supply additional identities. */
export async function provisionWorkloadEnvironments(db: Database, apply: boolean) {
  const ids = LEGACY_WORKLOAD_BINDINGS.map((binding) => binding.id);
  if (ids.length !== 27 || new Set(ids).size !== 27)
    throw new Error('The reviewed workload inventory must contain exactly 27 distinct bindings.');
  return db.transaction(async (tx) => {
    const changes: Array<{ bindingId: string; applicationId: string; state: string }> = [];
    // Validate and lock the entire reviewed cohort before making any change.
    for (const expected of LEGACY_WORKLOAD_BINDINGS) {
      const [binding] = await tx
        .select({ ...identityColumns, expiresAt: bindings.expiresAt })
        .from(bindings)
        .where(eq(bindings.id, expected.id))
        .for('update');
      if (
        !binding ||
        binding.applicationId !== expected.applicationId ||
        binding.provider !== expected.provider ||
        binding.subject !== expected.subject
      )
        throw new Error(`Binding ${expected.id} differs from the reviewed inventory.`);
      if (binding.environment !== null && binding.environment !== 'production')
        throw new Error(`Binding ${expected.id} belongs to another environment.`);
      if (binding.expiresAt && binding.expiresAt <= new Date())
        throw new Error(`Binding ${expected.id} has expired.`);
      const [app] = await tx
        .select({
          id: applications.id,
          status: applications.status,
          type: applications.type,
          isOfficial: applications.isOfficial,
          isInternal: applications.isInternal,
        })
        .from(applications)
        .where(eq(applications.id, expected.applicationId))
        .for('share');
      if (app?.status !== 'active' || !isTrustedApplication(app))
        throw new Error(`Application ${expected.applicationId} is unavailable.`);
      changes.push({
        bindingId: expected.id,
        applicationId: expected.applicationId,
        state: binding.environment === null ? 'needs_provisioning' : 'unchanged',
      });
    }
    if (apply) {
      for (let index = 0; index < changes.length; index++) {
        const change = changes[index];
        if (change.state === 'unchanged') continue;
        const expected = LEGACY_WORKLOAD_BINDINGS[index];
        const updated = await tx
          .update(bindings)
          .set({ environment: 'production', updatedAt: new Date() })
          .where(
            and(
              eq(bindings.id, expected.id),
              eq(bindings.applicationId, expected.applicationId),
              eq(bindings.provider, expected.provider),
              eq(bindings.subject, expected.subject),
              isNull(bindings.environment),
            ),
          )
          .returning({ id: bindings.id });
        if (updated.length !== 1) throw new Error(`Binding ${expected.id} changed concurrently.`);
        change.state = 'provisioned';
      }
    }
    // New rows are visible for review, but are never adopted into the write cohort.
    // Select only public registry metadata: no credentials, scopes, owners or secrets.
    const outsideCohort = await tx
      .select(identityColumns)
      .from(bindings)
      .where(notInArray(bindings.id, ids))
      .orderBy(bindings.id);
    return {
      apply,
      environment: 'production',
      bindings: changes,
      outsideCohort,
      cohortEnvironmentReady: changes.every((change) => change.state !== 'needs_provisioning'),
      requiresInventoryReview: outsideCohort.length > 0,
      // Bindings alone cannot establish caller, receiver or deployment readiness.
      fleetReadiness: 'not_assessed',
    };
  });
}

export async function main(args = process.argv.slice(2)) {
  const apply = args.includes('--apply');
  if (
    args.filter((arg) => arg === '--apply').length > 1 ||
    args.filter((arg) => arg !== '--apply').join(' ') !== '--environment production'
  )
    throw new Error('Expected --environment production [--apply].');
  await connectPostgres();
  try {
    process.stdout.write(
      `${JSON.stringify(await provisionWorkloadEnvironments(getDb(), apply))}\n`,
    );
  } finally {
    await closePostgres();
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Workload environment preflight failed');
    process.exitCode = 1;
  });
