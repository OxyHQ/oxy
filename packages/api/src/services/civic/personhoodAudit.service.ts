/**
 * Random Personhood Audit Service (civic / Commons — Fase 3).
 *
 * Keeps the web-of-trust honest after the fact: a background sweep samples a
 * random subset of `isRealPerson` users and opens a `personhood_audit`
 * ValidationRequest for each, REUSING the Fase 2 jury (`openValidationRequest` →
 * `selectValidators` → `tallyAndResolve`). A juror votes `valid` (confirmed real
 * person) or `invalid` (fake) on the SAME `POST /civic/validations/:id/vote`
 * route as any other validation — no separate voting path.
 *
 * On resolution, `validator.service.tallyAndResolve` dispatches the
 * `personhood_audit` action to {@link resolvePersonhoodAuditOutcome}:
 *  - the majority jurors are rewarded `validation_correct`;
 *  - a `rejected` outcome (jury says fake) triggers the STAKING SLASH CASCADE —
 *    every active voucher of the subject is slashed and the subject recomputed.
 *
 * The sweep is wired into `server.ts` next to the Fase 2 validation sweep, behind
 * the same unref'd-interval guard.
 */

import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../config/postgres';
import { personhoodStatuses } from '../../db/schema/personhoodStatuses';
import { validationRequests } from '../../db/schema/validationRequests';
import {
  openValidationRequest,
  type ValidationRequestRow,
  type ValidationRequestView,
} from './validator.service';
import {
  recomputePersonhood,
  slashVouchersForFakeSubject,
} from './personhood.service';
import { reputationService } from '../reputation.service';
import { buildUserDid } from '../did.service';
import { VALIDATION_CORRECT_ACTION } from '../../utils/reputation.constants';
import {
  PERSONHOOD_AUDIT_ACTION,
  PERSONHOOD_AUDIT_BATCH,
  PERSONHOOD_AUDIT_SAMPLE_RATE,
} from '../../utils/civic.constants';
import { logger } from '../../utils/logger';

/** Stable per-subject idempotency key so at most one audit is open at a time. */
function auditSourceActionId(subjectUserId: string): string {
  return `personhood_audit:${subjectUserId}`;
}

/**
 * Open a random-audit jury request for a subject. Idempotent while an audit for
 * the same subject is already open (the underlying `openValidationRequest`
 * dedups on `sourceActionId`).
 */
export async function openPersonhoodAudit(subjectUserId: string): Promise<ValidationRequestView> {
  return openValidationRequest({
    subjectUserId,
    actionType: PERSONHOOD_AUDIT_ACTION,
    sourceActionId: auditSourceActionId(subjectUserId),
    payload: { kind: 'personhood_audit', subjectDid: buildUserDid(subjectUserId) },
  });
}

/**
 * Sample a random subset of `isRealPerson` users and open an audit for each that
 * does not already have one open. Returns the count of NEW audits opened. A no-op
 * when there are no real persons. Best-effort: individual failures are logged.
 */
export async function sweepPersonhoodAudits(): Promise<number> {
  const [totals] = await getDb()
    .select({ total: count() })
    .from(personhoodStatuses)
    .where(eq(personhoodStatuses.isRealPerson, true));
  const total = totals?.total ?? 0;
  if (total === 0) {
    return 0;
  }

  const sampleSize = Math.min(
    PERSONHOOD_AUDIT_BATCH,
    Math.max(1, Math.ceil(total * PERSONHOOD_AUDIT_SAMPLE_RATE)),
  );

  // Mongo's `$sample` becomes `order by random() limit N`. Both are a full pass
  // over the matching set; the sample is small and the sweep runs on an
  // unref'd interval, so the cost is the same order it always was.
  const sampled = await getDb()
    .select({ userId: personhoodStatuses.userId })
    .from(personhoodStatuses)
    .where(eq(personhoodStatuses.isRealPerson, true))
    .orderBy(sql`random()`)
    .limit(sampleSize);
  const subjectIds = sampled.map((row) => row.userId);
  if (subjectIds.length === 0) {
    return 0;
  }

  // Skip subjects who already have an open audit (avoids churning duplicate
  // requests across sweeps).
  const openExisting = await getDb()
    .select({ subjectUserId: validationRequests.subjectUserId })
    .from(validationRequests)
    .where(
      and(
        eq(validationRequests.actionType, PERSONHOOD_AUDIT_ACTION),
        inArray(validationRequests.subjectUserId, subjectIds),
        inArray(validationRequests.status, ['pending', 'quorum_met']),
      ),
    );
  const alreadyOpen = new Set(openExisting.map((row) => row.subjectUserId));

  let opened = 0;
  for (const subjectId of subjectIds) {
    if (alreadyOpen.has(subjectId)) {
      continue;
    }
    try {
      await openPersonhoodAudit(subjectId);
      opened += 1;
    } catch (error) {
      logger.warn('Failed to open personhood audit (non-fatal)', {
        component: 'civic.personhoodAudit',
        subjectId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return opened;
}

/**
 * Resolve a `personhood_audit` request (called by `tallyAndResolve` via a dynamic
 * import to avoid a validator↔audit module cycle). Rewards the majority jurors
 * and, on a `rejected` (fake) outcome, runs the staking slash cascade. Fully
 * best-effort so a reward/slash failure never 500s the last voter's request.
 */
export async function resolvePersonhoodAuditOutcome(
  request: ValidationRequestRow,
  outcome: 'validated' | 'rejected',
  winningValidatorIds: string[],
): Promise<void> {
  const subjectUserId = request.subjectUserId;

  for (const validatorId of winningValidatorIds) {
    try {
      await reputationService.award({
        userId: validatorId,
        actionType: VALIDATION_CORRECT_ACTION,
        sourceActionId: `${request.id}:${validatorId}:audit`,
        reason: 'Voted with the resolving majority on a personhood audit',
      });
    } catch (error) {
      logger.warn('Personhood audit juror reward failed (non-fatal)', {
        component: 'civic.personhoodAudit',
        validatorId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (outcome === 'rejected') {
    try {
      await slashVouchersForFakeSubject(subjectUserId, 'Failed a random personhood audit');
    } catch (error) {
      logger.warn('Personhood audit slash cascade failed (non-fatal)', {
        component: 'civic.personhoodAudit',
        subjectUserId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  // A `validated` audit re-affirms the subject — recompute so the status row's
  // freshness reflects the audit.
  try {
    await recomputePersonhood(subjectUserId);
  } catch (error) {
    logger.warn('Personhood audit re-affirm recompute failed (non-fatal)', {
      component: 'civic.personhoodAudit',
      subjectUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
