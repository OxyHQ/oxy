/**
 * Federated avatar retry sweep scheduling.
 *
 * Runs `runFederatedAvatarRetrySweep` (`services/federation/avatarRetry.ts`),
 * which re-mirrors the source picture of every federated user whose last mirror
 * failed and left it without a stored avatar (`federation_avatar_retry_at` due).
 * This is what makes a failed mirror a DEFERRED success instead of a permanent
 * default avatar: nothing else guarantees a user is ever resolved again.
 *
 * Same shape as `subscriptionExpiry.queue.ts`:
 *   - **BullMQ path** (`REDIS_URL` set): one repeatable job deduped by a stable
 *     scheduler id, so exactly ONE schedule exists across the fleet.
 *   - **In-process fallback** (no `REDIS_URL`): an unref'd interval.
 *
 * Each tick is bounded (users per tick, concurrency), polite per origin, and
 * idempotent: rows are claimed with a lease, so an overlapping or crashed tick
 * loses nothing.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { runFederatedAvatarRetrySweep } from '../services/federation/avatarRetry';
import { logger } from '../utils/logger';
import { getQueueConnectionOptions } from './connection';
import { isQueueEnabled } from './queueManager';
import { COMPLETED_JOBS_RETENTION, FAILED_JOBS_RETENTION } from './constants';

/** Queue name. BullMQ rejects `:` in queue names — use dashes. */
const RETRY_QUEUE_NAME = 'federated-avatar-retry';
const RETRY_SCHEDULER_ID = 'federated-avatar-retry-sweep';
const RETRY_JOB = 'federated-avatar-retry-sweep';

/** Every five minutes — the first transient backoff step. */
export const FEDERATED_AVATAR_RETRY_INTERVAL_MS = 5 * 60 * 1000;
/** Users retried per tick, and how many at once. */
const USERS_PER_TICK = 200;
const CONCURRENCY = 4;

let queue: Queue | null = null;
let worker: Worker | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;

/** Run one sweep. Never throws — the next tick retries whatever is still due. */
export async function runFederatedAvatarRetryTick(): Promise<void> {
  try {
    const summary = await runFederatedAvatarRetrySweep({ maxUsers: USERS_PER_TICK, concurrency: CONCURRENCY });
    if (summary.claimed > 0) logger.info('Federated avatar retry sweep', { ...summary });
  } catch (err) {
    logger.error(
      'Federated avatar retry sweep failed',
      err instanceof Error ? err : new Error(String(err)),
      { component: 'federatedAvatarRetry' },
    );
  }
}

/** Start the unref'd in-process sweep interval (fallback path). */
function startFallback(): void {
  if (fallbackTimer) return;
  fallbackTimer = setInterval(() => {
    void runFederatedAvatarRetryTick();
  }, FEDERATED_AVATAR_RETRY_INTERVAL_MS);
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
      'Federated avatar retry queue teardown failed',
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}

/**
 * Start the sweep: BullMQ when Redis is configured, otherwise the
 * in-process interval. Never throws — a queue setup failure logs and falls back.
 */
export async function startFederatedAvatarRetryJobs(): Promise<void> {
  if (!isQueueEnabled()) {
    startFallback();
    logger.info('Federated avatar retry using in-process interval fallback (REDIS_URL unset)');
    return;
  }

  try {
    queue = new Queue(RETRY_QUEUE_NAME, {
      connection: getQueueConnectionOptions(),
      defaultJobOptions: {
        removeOnComplete: COMPLETED_JOBS_RETENTION,
        removeOnFail: FAILED_JOBS_RETENTION,
      },
    });
    queue.on('error', (err: Error) =>
      logger.error('Federated avatar retry queue error', { error: err.message }),
    );

    worker = new Worker(
      RETRY_QUEUE_NAME,
      async (_job: Job) => {
        await runFederatedAvatarRetryTick();
      },
      { connection: getQueueConnectionOptions() },
    );
    worker.on('error', (err: Error) =>
      logger.error('Federated avatar retry worker error', { error: err.message }),
    );

    await queue.upsertJobScheduler(
      RETRY_SCHEDULER_ID,
      { every: FEDERATED_AVATAR_RETRY_INTERVAL_MS },
      { name: RETRY_JOB },
    );

    logger.info('Federated avatar retry started via BullMQ (durable, fleet-wide scheduling)');
  } catch (err) {
    logger.error(
      'Federated avatar retry BullMQ setup failed — falling back to in-process interval',
      err instanceof Error ? err : new Error(String(err)),
    );
    await teardownQueue();
    startFallback();
  }
}

/** Stop the sweep (test teardown / graceful shutdown). */
export async function stopFederatedAvatarRetryJobs(): Promise<void> {
  if (fallbackTimer) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
  await teardownQueue();
}
