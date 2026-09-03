#!/usr/bin/env bun
/**
 * Bootstrap the narrowly-scoped human reviewer required by the first Kaana
 * catalogue publication. Safe by default; only APPLY=1 mutates PostgreSQL.
 *
 * Required:
 *   DATABASE_URL
 *   STAFF_BOOTSTRAP_USER_ID   exact users.id; never username/name/order
 *
 * Required only with APPLY=1:
 *   STAFF_BOOTSTRAP_ACTOR     operator or automation identity for audit
 *   STAFF_BOOTSTRAP_REASON    reviewed change/ticket reason for audit
 */

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../src/config/postgres';
import { securityActivities, users } from '../src/db/schema';
import {
  planCatalogueReviewerBootstrap,
  type CatalogueReviewerBootstrapPlan,
} from '../src/scripts/catalogueReviewerBootstrapPlan';

const apply = process.env.APPLY === '1';
const userId = process.env.STAFF_BOOTSTRAP_USER_ID;
const actor = process.env.STAFF_BOOTSTRAP_ACTOR;
const reason = process.env.STAFF_BOOTSTRAP_REASON;

function requireExactUserId(): string {
  if (!userId || userId.length > 128 || userId.trim() !== userId) {
    throw new Error('STAFF_BOOTSTRAP_USER_ID must be a non-empty exact opaque user id');
  }
  return userId;
}

function requireApplyAuditInput(): { actor: string; reason: string } {
  if (!actor || !reason || actor.trim() !== actor || reason.trim() !== reason) {
    throw new Error(
      'APPLY=1 requires exact non-empty STAFF_BOOTSTRAP_ACTOR and STAFF_BOOTSTRAP_REASON',
    );
  }
  if (actor.length > 200 || reason.length > 500) {
    throw new Error('STAFF_BOOTSTRAP_ACTOR or STAFF_BOOTSTRAP_REASON is too long');
  }
  return { actor, reason };
}

async function execute(): Promise<CatalogueReviewerBootstrapPlan> {
  const exactUserId = requireExactUserId();
  const audit = apply ? requireApplyAuditInput() : null;

  return getDb().transaction(async (tx) => {
    const [current] = await tx
      .select({
        userId: users.id,
        isStaff: users.isStaff,
        staffCapabilities: users.staffCapabilities,
      })
      .from(users)
      .where(eq(users.id, exactUserId))
      .for('update');
    if (!current) throw new Error('STAFF_BOOTSTRAP_USER_ID does not identify an existing user');

    const plan = planCatalogueReviewerBootstrap(current);
    if (!apply || !plan.changed) return plan;

    await tx
      .update(users)
      .set({ isStaff: true, staffCapabilities: [...plan.nextCapabilities] })
      .where(eq(users.id, exactUserId));
    await tx.insert(securityActivities).values({
      userId: exactUserId,
      eventType: 'security_settings_changed',
      eventDescription: 'Catalogue reviewer staff capability bootstrapped',
      severity: 'high',
      metadata: {
        operation: 'bootstrap_catalogue_reviewer',
        capability: plan.capability,
        previousIsStaff: plan.previousIsStaff,
        previousCapabilities: plan.previousCapabilities,
        nextIsStaff: plan.nextIsStaff,
        nextCapabilities: plan.nextCapabilities,
        actor: audit!.actor,
        reason: audit!.reason,
      },
    });
    return plan;
  });
}

async function main(): Promise<void> {
  await connectPostgres();
  try {
    const plan = await execute();
    process.stdout.write(`${JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...plan })}\n`);
  } finally {
    await closePostgres();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
