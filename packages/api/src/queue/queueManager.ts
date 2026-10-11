/**
 * Queue manager: lifecycle for BullMQ queues, workers, and repeatable
 * schedulers. This is the single owner of every Queue/Worker instance so that
 * `closeQueues()` can shut the whole subsystem down cleanly.
 *
 * Design notes:
 *   - Queues and Workers are constructed from plain connection OPTIONS (see
 *     `connection.ts`); BullMQ builds the underlying connections itself. The
 *     Queue gets one command connection and each Worker gets its OWN dedicated
 *     blocking connection — a worker's blocking connection must not be shared
 *     with a queue's command connection. Closing the Queue/Worker closes the
 *     connection it owns.
 *   - Repeatable jobs are registered via BullMQ v5's `upsertJobScheduler` with a
 *     STABLE scheduler id, so registering on every boot/replica updates the one
 *     schedule rather than creating duplicates.
 */

import { Queue, Worker, type Processor, type RepeatOptions } from 'bullmq';
import { logger } from '../utils/logger';
import { COMPLETED_JOBS_RETENTION, FAILED_JOBS_RETENTION, type QueueName } from './constants';
import { getQueueConnectionOptions } from './connection';

/**
 * Queues are background infrastructure. They are enabled only when a
 * `REDIS_URL` is configured; without it, callers fall back to the legacy
 * in-process scheduling so local dev and tests never require Redis.
 */
export function isQueueEnabled(): boolean {
  return Boolean(process.env.REDIS_URL);
}

/**
 * Job data and result for the maintenance jobs in this subsystem. The scheduled
 * jobs carry no payload and return nothing — they invoke shared runners by side
 * effect — so a concrete `void`/`void` shape keeps the Queue/Worker generics
 * invariant-friendly when stored in the tracking collections below.
 */
export type MaintenanceJobData = void;
export type MaintenanceJobResult = void;

/** One Queue instance per queue name, created lazily and reused. */
const queues = new Map<QueueName, Queue<MaintenanceJobData, MaintenanceJobResult>>();
/** All workers we have started, closed together on shutdown. */
const workers = new Set<Worker<MaintenanceJobData, MaintenanceJobResult>>();

/**
 * Get (or lazily create) the Queue for a given name. BullMQ builds the queue's
 * command connection from the supplied options.
 *
 * @throws Error if queues are not enabled — callers must gate on
 *   `isQueueEnabled()`.
 */
export function getQueue(name: QueueName): Queue<MaintenanceJobData, MaintenanceJobResult> {
  if (!isQueueEnabled()) {
    throw new Error('getQueue called while queues are disabled (REDIS_URL unset)');
  }

  const existing = queues.get(name);
  if (existing) return existing;

  const queue = new Queue<MaintenanceJobData, MaintenanceJobResult>(name, {
    connection: getQueueConnectionOptions(),
    defaultJobOptions: {
      removeOnComplete: COMPLETED_JOBS_RETENTION,
      removeOnFail: FAILED_JOBS_RETENTION,
    },
  });

  queue.on('error', (err: Error) =>
    logger.error('BullMQ queue error', { queue: name, error: err.message }),
  );

  queues.set(name, queue);
  return queue;
}

/**
 * Start a worker for a given queue. BullMQ builds the worker's OWN dedicated
 * blocking connection from the supplied options. The returned worker is tracked
 * for shutdown.
 *
 * @throws Error if queues are not enabled — callers must gate on
 *   `isQueueEnabled()`.
 */
export function startWorker(
  name: QueueName,
  processor: Processor<MaintenanceJobData, MaintenanceJobResult>,
): Worker<MaintenanceJobData, MaintenanceJobResult> {
  if (!isQueueEnabled()) {
    throw new Error('startWorker called while queues are disabled (REDIS_URL unset)');
  }

  const worker = new Worker<MaintenanceJobData, MaintenanceJobResult>(name, processor, {
    connection: getQueueConnectionOptions(),
  });

  worker.on('failed', (job, err: Error) =>
    logger.error('BullMQ job failed', {
      queue: name,
      jobName: job?.name,
      jobId: job?.id,
      error: err.message,
    }),
  );
  worker.on('error', (err: Error) =>
    logger.error('BullMQ worker error', { queue: name, error: err.message }),
  );

  workers.add(worker);
  return worker;
}

/**
 * Idempotently register a repeatable job on a queue.
 *
 * Uses BullMQ v5 `upsertJobScheduler` keyed by a STABLE scheduler id, so calling
 * this on every boot and on every replica converges on a single schedule rather
 * than accumulating duplicates.
 *
 * @throws Error if queues are not enabled — callers must gate on
 *   `isQueueEnabled()`.
 */
export async function registerRepeatableJob(
  queueName: QueueName,
  schedulerId: string,
  repeat: Omit<RepeatOptions, 'key'>,
  jobName: string,
): Promise<void> {
  if (!isQueueEnabled()) {
    throw new Error('registerRepeatableJob called while queues are disabled (REDIS_URL unset)');
  }

  const queue = getQueue(queueName);
  await queue.upsertJobScheduler(schedulerId, repeat, { name: jobName });

  logger.info('Registered repeatable job', {
    queue: queueName,
    schedulerId,
    jobName,
    repeat,
  });
}

/**
 * Gracefully close all workers and queues. Closing each Worker/Queue also closes
 * the connection BullMQ built for it, so there is nothing else to tear down.
 * Safe to call even when nothing was started. Workers are closed before queues
 * so in-flight jobs finish before their queue's connection is torn down.
 */
export async function closeQueues(): Promise<void> {
  const openWorkers = Array.from(workers);
  workers.clear();
  await Promise.all(
    openWorkers.map(async (worker) => {
      try {
        await worker.close();
      } catch (err) {
        logger.warn('BullMQ worker close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  const openQueues = Array.from(queues.values());
  queues.clear();
  await Promise.all(
    openQueues.map(async (queue) => {
      try {
        await queue.close();
      } catch (err) {
        logger.warn('BullMQ queue close failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}
