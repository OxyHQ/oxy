/** Dry-run by default; APPLY=1 requires the exact observed hash, actor and reason. */
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../src/config/postgres';
import {
  applications,
  applicationWorkloadIdentities,
  securityActivities,
  users,
  supervisionProfiles,
} from '../src/db/schema';
import {
  SAFETY_CONSUMERS,
  safetyWorkloadSubject,
  type SafetyConsumer,
} from '../src/config/safetyConsumers';
import {
  safetyConsumerPlan,
  type SafetyConsumerObservation,
} from '../src/scripts/safetyConsumerPlan';
import { requireNativeProductBootstrapApproval } from '../src/scripts/nativeProductAgentsBootstrapPlan';
const consumer = process.env.SAFETY_CONSUMER;
const stage = process.env.SAFETY_STAGE;
if (
  !consumer ||
  !Object.hasOwn(SAFETY_CONSUMERS, consumer) ||
  (stage !== 'base' && stage !== 'capability')
)
  throw new Error(
    'Set SAFETY_CONSUMER=clarity|mention|allo|mercaria and SAFETY_STAGE=base|capability',
  );
const selected = consumer as SafetyConsumer;
const actions = (process.env.SAFETY_ACTIONS ?? '').split(',').filter(Boolean);
await connectPostgres();
try {
  const report = await getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('safety-consumer-provisioning'))`);
    const target = SAFETY_CONSUMERS[selected];
    const [application] = await tx
      .select({
        id: applications.id,
        ownerAccountId: applications.ownerAccountId,
        type: applications.type,
        status: applications.status,
        scopes: applications.scopes,
        capabilities: applications.capabilities,
      })
      .from(applications)
      .where(eq(applications.id, target.applicationId))
      .for('update');
    if (!application) throw new Error('Canonical application is missing');
    const rows = await tx
      .select({
        id: applicationWorkloadIdentities.id,
        applicationId: applicationWorkloadIdentities.applicationId,
        provider: applicationWorkloadIdentities.provider,
        subject: applicationWorkloadIdentities.subject,
        scopes: applicationWorkloadIdentities.scopes,
        expiresAt: applicationWorkloadIdentities.expiresAt,
      })
      .from(applicationWorkloadIdentities)
      .where(
        and(
          eq(applicationWorkloadIdentities.provider, 'aws-iam'),
          inArray(applicationWorkloadIdentities.subject, target.roles.map(safetyWorkloadSubject)),
        ),
      )
      .orderBy(applicationWorkloadIdentities.subject)
      .for('update');
    const [owner] = await tx
      .select({
        id: users.id,
        status: users.accountStatus,
        kind: users.kind,
        reputation: users.reputationTier,
      })
      .from(users)
      .where(eq(users.id, target.ownerAccountId))
      .for('share');
    if (!owner) throw new Error('Canonical application owner is missing');
    const [supervised] = await tx
      .select({ id: supervisionProfiles.childAccountId })
      .from(supervisionProfiles)
      .where(
        and(
          eq(supervisionProfiles.childAccountId, owner.id),
          ne(supervisionProfiles.status, 'ended'),
        ),
      )
      .limit(1);
    const before: SafetyConsumerObservation = {
      owner: { ...owner, supervised: !!supervised },
      application,
      workloads: rows.map((row) => ({ ...row, expiresAt: row.expiresAt?.toISOString() ?? null })),
    };
    const result = safetyConsumerPlan(selected, stage, actions, before);
    if (process.env.APPLY === '1') {
      const approval = requireNativeProductBootstrapApproval(result.planSha256, process.env);
      const after = result.plan.after;
      if (
        JSON.stringify(application.scopes) !== JSON.stringify(after.application.scopes) ||
        JSON.stringify(application.capabilities) !== JSON.stringify(after.application.capabilities)
      )
        await tx
          .update(applications)
          .set({ scopes: after.application.scopes, capabilities: after.application.capabilities })
          .where(eq(applications.id, application.id));
      for (const desired of after.workloads) {
        const observed = rows.find((row) => row.id === desired.id);
        if (JSON.stringify(observed?.scopes) !== JSON.stringify(desired.scopes))
          await tx
            .update(applicationWorkloadIdentities)
            .set({ scopes: desired.scopes })
            .where(eq(applicationWorkloadIdentities.id, desired.id));
      }
      await tx.insert(securityActivities).values({
        userId: target.ownerAccountId,
        eventType: 'security_settings_changed',
        eventDescription: 'Reviewed safety consumer policy authority provisioned',
        severity: 'high',
        metadata: {
          operation: 'provision_safety_consumer',
          actor: approval.actor,
          reason: approval.reason,
          consumer: selected,
          stage,
          actions,
          planSha256: result.planSha256,
        },
      });
    }
    return { mode: process.env.APPLY === '1' ? 'apply' : 'dry-run', ...result };
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await closePostgres();
}
