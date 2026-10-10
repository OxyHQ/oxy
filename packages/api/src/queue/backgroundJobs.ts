/**
 * Background-jobs entry point.
 *
 * This module is the single decision point for how scheduled background work
 * runs:
 *
 *   - If BullMQ queues are enabled (`REDIS_URL` set) → start the in-process
 *     worker and register the repeatable scheduler. The scheduler enqueues one
 *     job per interval for the WHOLE fleet (deduped by a stable scheduler id),
 *     and exactly one worker across the fleet processes each job. The legacy
 *     per-replica `setInterval` is NOT started.
 *
 *   - If queues are disabled (no `REDIS_URL`, e.g. local dev / tests) → fall
 *     back to the legacy in-process `setInterval` cron. This runs on every
 *     replica, which is acceptable for single-process local development.
 *
 * Boot never crashes if Redis is unavailable: registration failures are logged
 * and we fall back to the in-process cron. Connection-level errors are handled
 * by the connection's `error` handler (see `connection.ts`) and never throw
 * into boot.
 */

import { logger } from '../utils/logger';
import { runEmailMaintenance, startSnoozeCron, stopSnoozeCron } from '../cron/snooze.cron';
import {
  QUEUE_NAMES,
  JOB_SCHEDULER_IDS,
  JOB_NAMES,
  EMAIL_MAINTENANCE_INTERVAL_MS,
} from './constants';
import { isQueueEnabled, startWorker, registerRepeatableJob, closeQueues } from './queueManager';

/**
 * Tracks which scheduling path is active so shutdown stops the right one.
 * `stopSnoozeCron()` is itself a no-op when the interval was never started, but
 * this flag keeps the shutdown intent explicit.
 */
let fallbackActive = false;

/**
 * Start background jobs. Chooses the durable BullMQ path when queues are
 * enabled, otherwise the in-process fallback. Never throws.
 */
export async function startBackgroundJobs(): Promise<void> {
  if (!isQueueEnabled()) {
    logger.warn(
      'BullMQ queues disabled (REDIS_URL unset) — using in-process cron fallback for email maintenance',
    );
    startSnoozeCron();
    fallbackActive = true;
    return;
  }

  try {
    // Worker processes the repeatable email-maintenance job using the SAME
    // shared runner as the legacy cron — no duplicated business logic.
    startWorker(QUEUE_NAMES.EMAIL_MAINTENANCE, async () => {
      await runEmailMaintenance();
    });

    await registerRepeatableJob(
      QUEUE_NAMES.EMAIL_MAINTENANCE,
      JOB_SCHEDULER_IDS.EMAIL_MAINTENANCE,
      { every: EMAIL_MAINTENANCE_INTERVAL_MS },
      JOB_NAMES.EMAIL_MAINTENANCE_TICK,
    );

    logger.info('Background jobs started via BullMQ (durable, fleet-wide scheduling)');
  } catch (err) {
    // If anything about queue setup fails, do not crash boot and do not silently
    // lose the work — fall back to the in-process cron and tear down any
    // partially-created queue resources.
    logger.error(
      'BullMQ background-jobs setup failed — falling back to in-process cron',
      err instanceof Error ? err : new Error(String(err)),
    );
    await closeQueues().catch((closeErr) =>
      logger.warn('Failed to clean up partial queue resources after setup error', {
        error: closeErr instanceof Error ? closeErr.message : String(closeErr),
      }),
    );
    startSnoozeCron();
    fallbackActive = true;
  }
}

/**
 * Stop background jobs. Closes BullMQ workers/queues/connections and stops the
 * in-process fallback if it was started. Safe to call regardless of which path
 * ran. Intended to be called from the server's graceful-shutdown sequence
 * BEFORE the shared cache Redis client and MongoDB are closed.
 */
export async function stopBackgroundJobs(): Promise<void> {
  if (fallbackActive) {
    stopSnoozeCron();
    fallbackActive = false;
  }
  await closeQueues();
}
