/**
 * Starting outbound email delivery NOW, not on the next sweep.
 *
 * `POST /email/messages` files the message and its `email_outbox` job in one
 * transaction and answers 202; the relay is spoken to here, afterwards. The
 * outbox row is the durable truth — lease, attempt count, retry schedule — so
 * this module only decides WHEN a worker looks at it:
 *
 *   - **BullMQ** (`QUEUE_REDIS_URL` or `REDIS_URL` set): one job per attempt,
 *     delayed by the retry backoff, taken by whichever API task is free. A
 *     crash between claim and outcome leaves the row leased, and the sweep in
 *     `emailOutbox.worker.ts` adopts it when the lease runs out.
 *   - **In process** (no Redis, e.g. local dev and tests): a timer.
 *
 * Either way the one-minute sweep stays as the net, so a job that is lost —
 * evicted, never enqueued because Redis blipped — costs a minute, not a message.
 *
 * {@link scheduleEmailDelivery} never throws into its caller: the message is
 * already filed and promised, and a queue outage must not turn that into a 500.
 */

import { Queue, Worker, type Job } from 'bullmq';
import { logger } from '../utils/logger';
import { getEmailDeliveryQueueConnectionOptions, getEmailDeliveryQueueUrl } from './connection';
import { COMPLETED_JOBS_RETENTION, FAILED_JOBS_RETENTION, QUEUE_NAMES } from './constants';

interface EmailDeliveryJobData {
  outboxId: string;
}

type DeliveryProcessor = (outboxId: string) => Promise<void>;

/** Registered by `emailDelivery.service.ts`, which imports this module. */
let processor: DeliveryProcessor | null = null;
let queue: Queue<EmailDeliveryJobData> | null = null;
let worker: Worker<EmailDeliveryJobData> | null = null;
const timers = new Set<NodeJS.Timeout>();

/** How many deliveries one API task runs at once. SMTP is I/O, not CPU. */
const WORKER_CONCURRENCY = 4;

export function registerEmailDeliveryProcessor(fn: DeliveryProcessor): void {
  processor = fn;
}

function isBullEnabled(): boolean {
  return Boolean(getEmailDeliveryQueueUrl());
}

function getQueue(): Queue<EmailDeliveryJobData> {
  if (!queue) {
    queue = new Queue<EmailDeliveryJobData>(QUEUE_NAMES.EMAIL_DELIVERY, {
      connection: getEmailDeliveryQueueConnectionOptions(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: COMPLETED_JOBS_RETENTION,
        removeOnFail: FAILED_JOBS_RETENTION,
      },
    });
    queue.on('error', (err: Error) =>
      logger.error('Email delivery queue error', { error: err.message }),
    );
  }
  return queue;
}

function runInProcess(outboxId: string, delayMs: number): void {
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (!processor) {
      logger.warn('Email delivery processor not registered; the sweep will deliver', { outboxId });
      return;
    }
    processor(outboxId).catch((error: unknown) =>
      logger.error('In-process email delivery failed', {
        outboxId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }, delayMs);
  timer.unref();
  timers.add(timer);
}

/**
 * Deliver `outboxId` after `delayMs`. Fire-and-forget; never throws.
 */
export function scheduleEmailDelivery(outboxId: string, delayMs = 0): void {
  if (!isBullEnabled()) {
    runInProcess(outboxId, delayMs);
    return;
  }
  getQueue()
    .add('deliver', { outboxId }, { delay: Math.max(0, delayMs) })
    .catch((error: unknown) => {
      // The row is durable; the sweep will pick it up. Say so, loudly.
      logger.error('Could not enqueue email delivery; the sweep will deliver it', {
        outboxId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

/** Start this task's delivery worker. No-op without a queue Redis. */
export function startEmailDeliveryWorker(): void {
  if (!isBullEnabled() || worker) return;
  worker = new Worker<EmailDeliveryJobData>(
    QUEUE_NAMES.EMAIL_DELIVERY,
    async (job: Job<EmailDeliveryJobData>) => {
      if (!processor) throw new Error('Email delivery processor not registered');
      await processor(job.data.outboxId);
    },
    { connection: getEmailDeliveryQueueConnectionOptions(), concurrency: WORKER_CONCURRENCY },
  );
  worker.on('failed', (job, err: Error) =>
    logger.error('Email delivery job failed; the sweep will retry it', {
      outboxId: job?.data.outboxId,
      error: err.message,
    }),
  );
  worker.on('error', (err: Error) => logger.error('Email delivery worker error', { error: err.message }));
}

export async function stopEmailDelivery(): Promise<void> {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  const closing: Array<Promise<void>> = [];
  if (worker) closing.push(worker.close());
  if (queue) closing.push(queue.close());
  worker = null;
  queue = null;
  await Promise.allSettled(closing);
}
