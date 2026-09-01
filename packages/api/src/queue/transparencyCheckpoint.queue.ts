/**
 * Transparency-checkpoint scheduling.
 *
 * Publishes the periodic signed commitment to every subject's chain head. The
 * cadence is a SECURITY parameter, not a cost one: it bounds how long an
 * equivocation could go unpublished (and, once phase 2 lands, unanchored).
 *
 * Mirrors `nodeIngest.queue.ts` exactly, for the same reason:
 *   - **BullMQ path** (`REDIS_URL` set): one repeatable job deduped by a stable
 *     scheduler id, so exactly ONE schedule exists across the fleet.
 *   - **In-process fallback** (no `REDIS_URL`, e.g. local dev / tests): an
 *     unref'd interval, so it can never hold the event loop open.
 *
 * Fleet-wide scheduling is a nicety here, not the safety net: the real mutex is
 * the unique index on `TransparencyCheckpoint.index`, and the service adopts the
 * winner's root on collision. Two signed roots for one index is exactly the
 * equivocation the log exists to detect, so that guarantee must not depend on
 * scheduling being perfect.
 *
 * A publish failure is logged and retried on the next tick — it never blocks
 * record writes. Gaps in `index` are impossible by construction: the next run
 * derives its index from the newest stored checkpoint, so a missed period is
 * simply published late and the chain stays contiguous.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { buildCheckpoint, getLatestCheckpoint } from '../services/transparency.service';
import { logger } from '../utils/logger';
import { getQueueConnectionOptions } from './connection';
import { isQueueEnabled } from './queueManager';
import { COMPLETED_JOBS_RETENTION, FAILED_JOBS_RETENTION } from './constants';

/** Queue name. BullMQ rejects `:` in queue names — use dashes. */
const CHECKPOINT_QUEUE_NAME = 'transparency-checkpoint';
const CHECKPOINT_SCHEDULER_ID = 'transparency-checkpoint-publish';
const CHECKPOINT_JOB = 'transparency-checkpoint-publish';

/**
 * How often a checkpoint is published (6 hours). Shortening this tightens the
 * detection window; lengthening it widens the blind spot between commitments.
 */
export const CHECKPOINT_INTERVAL_MS = 6 * 60 * 60 * 1000;

let queue: Queue | null = null;
let worker: Worker | null = null;
let fallbackTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Publish one checkpoint for the period ending now. Never throws — a failure is
 * logged and the next tick retries.
 */
export async function publishCheckpoint(periodEnd: number): Promise<void> {
  try {
    const checkpoint = await buildCheckpoint(periodEnd);
    logger.info('Published transparency checkpoint', {
      index: checkpoint.index,
      treeSize: checkpoint.treeSize,
      root: checkpoint.root,
    });
  } catch (err) {
    logger.error(
      'Transparency checkpoint publish failed',
      err instanceof Error ? err : new Error(String(err)),
      { component: 'transparencyCheckpoint' },
    );
  }
}

/**
 * Publish a genesis checkpoint on boot when the log is empty, and surface a
 * distinct error when signing is misconfigured so silent 404s do not linger.
 */
async function bootstrapTransparencyPublishing(): Promise<void> {
  const latest = await getLatestCheckpoint();
  if (!process.env.OXY_PRIVATE_KEY) {
    if (!latest) {
      logger.error(
        'Transparency log cannot publish: OXY_PRIVATE_KEY is not configured and no checkpoint exists yet',
        { component: 'transparencyCheckpoint' },
      );
    } else {
      logger.warn(
        'Transparency log cannot publish new checkpoints: OXY_PRIVATE_KEY is not configured',
        { component: 'transparencyCheckpoint', latestIndex: latest.index },
      );
    }
    return;
  }

  if (!latest) {
    await publishCheckpoint(Date.now());
  }
}

/** Start the unref'd in-process publish interval (fallback path). */
function startFallback(): void {
  if (fallbackTimer) return;
  fallbackTimer = setInterval(() => {
    void publishCheckpoint(Date.now());
  }, CHECKPOINT_INTERVAL_MS);
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
      'Transparency checkpoint queue teardown failed',
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}

/**
 * Start checkpoint publishing: BullMQ when Redis is configured, otherwise the
 * in-process interval. Never throws — a queue setup failure logs and falls back.
 */
export async function startTransparencyCheckpointJobs(): Promise<void> {
  if (!isQueueEnabled()) {
    startFallback();
    logger.info('Transparency checkpoints using in-process interval fallback (REDIS_URL unset)');
    void bootstrapTransparencyPublishing();
    return;
  }

  try {
    queue = new Queue(CHECKPOINT_QUEUE_NAME, {
      connection: getQueueConnectionOptions(),
      defaultJobOptions: {
        removeOnComplete: COMPLETED_JOBS_RETENTION,
        removeOnFail: FAILED_JOBS_RETENTION,
      },
    });
    queue.on('error', (err: Error) =>
      logger.error('Transparency checkpoint queue error', { error: err.message }),
    );

    worker = new Worker(
      CHECKPOINT_QUEUE_NAME,
      async (_job: Job) => {
        await publishCheckpoint(Date.now());
      },
      { connection: getQueueConnectionOptions() },
    );
    worker.on('error', (err: Error) =>
      logger.error('Transparency checkpoint worker error', { error: err.message }),
    );

    await queue.upsertJobScheduler(
      CHECKPOINT_SCHEDULER_ID,
      { every: CHECKPOINT_INTERVAL_MS },
      { name: CHECKPOINT_JOB },
    );

    logger.info('Transparency checkpoints started via BullMQ (durable, fleet-wide scheduling)');
  } catch (err) {
    logger.error(
      'Transparency checkpoint BullMQ setup failed — falling back to in-process interval',
      err instanceof Error ? err : new Error(String(err)),
    );
    await teardownQueue();
    startFallback();
  }

  void bootstrapTransparencyPublishing();
}

/** Stop publishing (test teardown / graceful shutdown). */
export async function stopTransparencyCheckpointJobs(): Promise<void> {
  if (fallbackTimer) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
  await teardownQueue();
}
