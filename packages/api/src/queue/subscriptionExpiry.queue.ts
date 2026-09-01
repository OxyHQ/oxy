/**
 * Subscription status projection scheduling.
 *
 * Runs `projectExpiredSubscriptions` (`db/subscriptionStatus.ts`), which
 * relabels a lapsed subscription `active → expired`. It DELETES NOTHING: the
 * Mongo TTL index this replaces destroyed the record of what a user bought, and
 * removing that data loss is the point.
 *
 * Mirrors `conductRiskExpiry.queue.ts` exactly:
 *   - **BullMQ path** (`REDIS_URL` set): one repeatable job deduped by a stable
 *     scheduler id, so exactly ONE schedule exists across the fleet.
 *   - **In-process fallback** (no `REDIS_URL`, e.g. local dev / tests): an
 *     unref'd interval, so it can never hold the event loop open.
 *
 * The cadence is a REPORTING parameter, not an entitlement one. Every read
 * derives expiry for itself (`resolveUserSubscriptionPlan` filters
 * `end_date > now()` in SQL; `formatSubscriptionResponse` computes `expired` at
 * serialization time), so a missed tick delays a label on a dashboard and
 * entitles nobody. Hourly is therefore ample — and unlike the TTL index it
 * replaces, being behind is never a correctness failure.
 *
 * A failed run is logged and retried on the next tick; the projection is
 * idempotent, so a lost pass loses nothing.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { getDb } from '../config/postgres';
import { projectExpiredSubscriptions } from '../db/subscriptionStatus';
import { logger } from '../utils/logger';
import { getQueueConnectionOptions } from './connection';
import { isQueueEnabled } from './queueManager';
import { COMPLETED_JOBS_RETENTION, FAILED_JOBS_RETENTION } from './constants';

/** Queue name. BullMQ rejects `:` in queue names — use dashes. */
const EXPIRY_QUEUE_NAME = 'subscription-expiry';
const EXPIRY_SCHEDULER_ID = 'subscription-expiry-projection';
const EXPIRY_JOB = 'subscription-expiry-projection';

/** Hourly. See the header for why this is a reporting parameter, not a gate. */
export const SUBSCRIPTION_EXPIRY_INTERVAL_MS = 60 * 60 * 1000;

let queue: Queue | null = null;
let worker: Worker | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Run one projection pass. Never throws — a failure is logged and the next tick
 * retries, because the projection is idempotent and losing one pass only delays
 * a label.
 */
export async function runSubscriptionExpiryProjection(): Promise<void> {
  try {
    const result = await projectExpiredSubscriptions(getDb());
    if (result.expired > 0) {
      logger.info('Subscription expiry projection applied', {
        expired: result.expired,
        truncated: result.truncated,
      });
    }
  } catch (err) {
    logger.error(
      'Subscription expiry projection failed',
      err instanceof Error ? err : new Error(String(err)),
      { component: 'subscriptionExpiry' },
    );
  }
}

/** Start the unref'd in-process projection interval (fallback path). */
function startFallback(): void {
  if (fallbackTimer) return;
  fallbackTimer = setInterval(() => {
    void runSubscriptionExpiryProjection();
  }, SUBSCRIPTION_EXPIRY_INTERVAL_MS);
  // Never hold the event loop open — an interval on a module singleton hangs
  // Jest runs and delays shutdown otherwise.
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
      'Subscription expiry queue teardown failed',
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}

/**
 * Start the projection: BullMQ when Redis is configured, otherwise the
 * in-process interval. Never throws — a queue setup failure logs and falls back.
 */
export async function startSubscriptionExpiryJobs(): Promise<void> {
  if (!isQueueEnabled()) {
    startFallback();
    logger.info('Subscription expiry using in-process interval fallback (REDIS_URL unset)');
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
      logger.error('Subscription expiry queue error', { error: err.message }),
    );

    worker = new Worker(
      EXPIRY_QUEUE_NAME,
      async (_job: Job) => {
        await runSubscriptionExpiryProjection();
      },
      { connection: getQueueConnectionOptions() },
    );
    worker.on('error', (err: Error) =>
      logger.error('Subscription expiry worker error', { error: err.message }),
    );

    await queue.upsertJobScheduler(
      EXPIRY_SCHEDULER_ID,
      { every: SUBSCRIPTION_EXPIRY_INTERVAL_MS },
      { name: EXPIRY_JOB },
    );

    logger.info('Subscription expiry started via BullMQ (durable, fleet-wide scheduling)');
  } catch (err) {
    logger.error(
      'Subscription expiry BullMQ setup failed — falling back to in-process interval',
      err instanceof Error ? err : new Error(String(err)),
    );
    await teardownQueue();
    startFallback();
  }
}

/** Stop the projection (test teardown / graceful shutdown). */
export async function stopSubscriptionExpiryJobs(): Promise<void> {
  if (fallbackTimer) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
  await teardownQueue();
}
