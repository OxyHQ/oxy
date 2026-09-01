/**
 * Conduct-risk expiry scheduling.
 *
 * Lets an active moderation consequence LAPSE. The ledger transaction stays
 * exactly where it is — the history is permanent — but the active risk decays and
 * the standing recovers, so a minor error does not become a life sentence. That
 * asymmetry between the record and the consequence is the whole design, and this
 * sweep is the half of it that actually runs.
 *
 * The cadence is a FAIRNESS parameter, not a cost one: it bounds how long someone
 * stays under a consequence that has already earned its way out. Hourly means the
 * worst case is an hour of over-restriction, which is the direction to err.
 *
 * Mirrors `transparencyCheckpoint.queue.ts` exactly:
 *   - **BullMQ path** (`REDIS_URL` set): one repeatable job deduped by a stable
 *     scheduler id, so exactly ONE schedule exists across the fleet.
 *   - **In-process fallback** (no `REDIS_URL`, e.g. local dev / tests): an unref'd
 *     interval, so it can never hold the event loop open.
 *
 * Fleet-wide scheduling is a nicety here rather than the safety net. The real
 * guarantee is that expiry is DERIVED: a strike is only counted while
 * `status: 'active'`, and the sweep is idempotent, so a missed tick delays the
 * recovery and loses nothing. A dropped job is a delay, never a corruption — the
 * same property the outbox pattern buys elsewhere, obtained here for free because
 * the durable record is the strike itself.
 *
 * A sweep failure is logged and retried on the next tick; it never blocks a
 * consequence from being applied.
 */

import { Queue, Worker, type Job } from 'bullmq';
import moderationReputationService from '../services/moderationReputation.service';
import {
  CONDUCT_EXPIRY_BATCH_SIZE,
  CONDUCT_EXPIRY_INTERVAL_MS,
} from '../utils/moderation.constants';
import { logger } from '../utils/logger';
import { getQueueConnectionOptions } from './connection';
import { isQueueEnabled } from './queueManager';
import { COMPLETED_JOBS_RETENTION, FAILED_JOBS_RETENTION } from './constants';

/** Queue name. BullMQ rejects `:` in queue names — use dashes. */
const EXPIRY_QUEUE_NAME = 'conduct-risk-expiry';
const EXPIRY_SCHEDULER_ID = 'conduct-risk-expiry-sweep';
const EXPIRY_JOB = 'conduct-risk-expiry-sweep';

let queue: Queue | null = null;
let worker: Worker | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Run one expiry sweep. Never throws — a failure is logged and the next tick
 * retries, because the sweep is idempotent and losing one pass only delays a
 * recovery.
 */
export async function runConductRiskExpirySweep(): Promise<void> {
  try {
    await moderationReputationService.expireConductStrikes(CONDUCT_EXPIRY_BATCH_SIZE);
  } catch (err) {
    logger.error(
      'Conduct risk expiry sweep failed',
      err instanceof Error ? err : new Error(String(err)),
      { component: 'conductRiskExpiry' },
    );
  }
}

/** Start the unref'd in-process sweep interval (fallback path). */
function startFallback(): void {
  if (fallbackTimer) return;
  fallbackTimer = setInterval(() => {
    void runConductRiskExpirySweep();
  }, CONDUCT_EXPIRY_INTERVAL_MS);
  // Never hold the event loop open — an interval on a module singleton hangs Jest
  // runs and delays shutdown otherwise.
  fallbackTimer.unref?.();
}

/** Close the BullMQ worker + queue (and the connections they own). */
async function teardownQueue(): Promise<void> {
  const w = worker;
  const q = queue;
  worker = null;
  queue = null;
  try {
    await w?.close();
    await q?.close();
  } catch (err) {
    logger.error(
      'Conduct risk expiry queue teardown failed',
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}

/**
 * Start the expiry sweep: BullMQ when Redis is configured, otherwise the
 * in-process interval. Never throws — a queue setup failure logs and falls back.
 */
export async function startConductRiskExpiryJobs(): Promise<void> {
  if (!isQueueEnabled()) {
    startFallback();
    logger.info('Conduct risk expiry using in-process interval fallback (REDIS_URL unset)');
    return;
  }

  try {
    queue = new Queue(EXPIRY_QUEUE_NAME, {
      connection: getQueueConnectionOptions(),
      defaultJobOptions: {
        removeOnComplete: COMPLETED_JOBS_RETENTION,
        removeOnFail: FAILED_JOBS_RETENTION,
      },
    });
    queue.on('error', (err: Error) =>
      logger.error('Conduct risk expiry queue error', { error: err.message }),
    );

    worker = new Worker(
      EXPIRY_QUEUE_NAME,
      async (_job: Job) => {
        await runConductRiskExpirySweep();
      },
      { connection: getQueueConnectionOptions() },
    );
    worker.on('error', (err: Error) =>
      logger.error('Conduct risk expiry worker error', { error: err.message }),
    );

    await queue.upsertJobScheduler(
      EXPIRY_SCHEDULER_ID,
      { every: CONDUCT_EXPIRY_INTERVAL_MS },
      { name: EXPIRY_JOB },
    );

    logger.info('Conduct risk expiry started via BullMQ (durable, fleet-wide scheduling)');
  } catch (err) {
    logger.error(
      'Conduct risk expiry BullMQ setup failed — falling back to in-process interval',
      err instanceof Error ? err : new Error(String(err)),
    );
    await teardownQueue();
    startFallback();
  }
}

/** Stop the sweep (test teardown / graceful shutdown). */
export async function stopConductRiskExpiryJobs(): Promise<void> {
  if (fallbackTimer) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
  await teardownQueue();
}
