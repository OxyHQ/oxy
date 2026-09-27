/**
 * Moderation reconciliation, run by the system — never by a person.
 *
 * `reconcileModerationIncident` repairs the two silent shapes a dropped
 * background job leaves behind (points deducted with no strike; a consequence
 * still active after a later revision superseded it). It used to be reachable
 * only from a staff route, which put a person in charge of WHEN and for WHOM a
 * standing got repaired. Now every API task schedules this sweep; a
 * transaction-scoped advisory lock lets exactly one run at a time and the rest
 * skip, and it walks every incident whose effects changed in the recent window.
 *
 * Reconciliation is idempotent — a healthy incident is examined and nothing is
 * written — so sweeping an incident more than once is only reads.
 */
import { desc, gte, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { moderationEffects } from '../db/schema/moderationEffects';
import { logger } from '../utils/logger';
import moderationReputationService from './moderationReputation.service';

/** How far back a changed effect makes its incident worth re-checking. */
export const MODERATION_RECONCILE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Time between sweeps. */
export const MODERATION_RECONCILE_INTERVAL_MS = 10 * 60 * 1000;
/** Incidents reconciled per sweep; the rest wait for the next one. */
export const MODERATION_RECONCILE_BATCH_SIZE = 50;
const FIRST_RUN_DELAY_MS = 60 * 1000;
const LOCK_NAMESPACE = 'moderation-reconcile-sweep';

export interface ModerationReconcileSweepResult {
  status: 'swept' | 'locked';
  incidents: number;
  repaired: number;
  failed: number;
}

/**
 * One sweep. Reconciles up to `batchSize` incidents whose effects changed since
 * `now - windowMs`, most recently changed first. A failing incident is logged
 * and skipped; the sweep never throws for one.
 */
export async function runModerationReconcileSweep(
  options: { now?: Date; windowMs?: number; batchSize?: number } = {},
): Promise<ModerationReconcileSweepResult> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - (options.windowMs ?? MODERATION_RECONCILE_WINDOW_MS));
  const batchSize = options.batchSize ?? MODERATION_RECONCILE_BATCH_SIZE;

  return getDb().transaction(async (tx) => {
    const [lock] = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${LOCK_NAMESPACE}, 0)) as locked`,
    );
    if (lock?.locked !== true) return { status: 'locked', incidents: 0, repaired: 0, failed: 0 };

    const changed = await tx
      .select({
        incidentId: moderationEffects.incidentId,
        lastChange: sql<Date>`max(${moderationEffects.updatedAt})`.as('last_change'),
      })
      .from(moderationEffects)
      .where(gte(moderationEffects.updatedAt, since))
      .groupBy(moderationEffects.incidentId)
      .orderBy(desc(sql`last_change`))
      .limit(batchSize);

    let repaired = 0;
    let failed = 0;
    for (const { incidentId } of changed) {
      try {
        const result = await moderationReputationService.reconcileModerationIncident(incidentId);
        const fixed = result.strikesRepaired + result.supersededReversed;
        if (fixed > 0) {
          repaired += 1;
          logger.warn('[ModerationReconcile] Repaired an incident', {
            incidentId,
            strikesRepaired: result.strikesRepaired,
            supersededReversed: result.supersededReversed,
          });
        }
      } catch (error) {
        failed += 1;
        logger.error(
          '[ModerationReconcile] Incident failed to reconcile',
          error instanceof Error ? error : new Error(String(error)),
          { incidentId },
        );
      }
    }
    return { status: 'swept', incidents: changed.length, repaired, failed };
  });
}

let firstRun: ReturnType<typeof setTimeout> | null = null;
let interval: ReturnType<typeof setInterval> | null = null;
let running = false;

function tick(): void {
  if (running) return;
  running = true;
  runModerationReconcileSweep()
    .catch((error: unknown) =>
      logger.error(
        '[ModerationReconcile] Sweep failed',
        error instanceof Error ? error : new Error(String(error)),
      ),
    )
    .finally(() => {
      running = false;
    });
}

/** Schedule the sweep on this task. Every task does; the lock picks one per run. */
export function startModerationReconcileWorker(): void {
  if (interval) return;
  firstRun = setTimeout(tick, FIRST_RUN_DELAY_MS);
  interval = setInterval(tick, MODERATION_RECONCILE_INTERVAL_MS);
  firstRun.unref?.();
  interval.unref?.();
}

export function stopModerationReconcileWorker(): void {
  if (firstRun) clearTimeout(firstRun);
  if (interval) clearInterval(interval);
  firstRun = null;
  interval = null;
}
