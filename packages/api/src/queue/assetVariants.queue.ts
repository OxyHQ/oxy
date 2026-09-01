/**
 * Background variant generation for uploaded assets.
 *
 * The single decision point for HOW an asset's rendition set gets built, and the
 * reason this module exists rather than a direct call:
 *
 * `AssetService.queueVariantGeneration` was a method named `queue…` that queued
 * nothing — it awaited `variantService.generateVariants` directly. The eight
 * call sites do not await it, so the HTTP RESPONSE was never blocked; what was
 * unbounded was the CONCURRENCY. Every upload immediately started up to seven
 * sharp encodes (image) or three x264 transcodes plus HLS segmentation (video),
 * in this process, with nothing limiting how many ran at once. On a 512 CPU /
 * 1024 MiB Fargate task that pins the container at 100% CPU and ~1023 MiB, and
 * the JS thread then loses the CPU for long enough to miss the ELB's 5 s
 * `/health` probe three times running — so the load balancer kills a task that
 * is merely starved, mid-upload, and the work is lost.
 *
 *   - **BullMQ path** (`REDIS_URL` set): one job per file, deduped by a stable
 *     per-file jobId, drained by a worker with an explicit, small concurrency.
 *     A failing job is a FAILED job — retried with backoff and visible in the
 *     queue — rather than a swallowed log line.
 *
 *   - **In-process fallback** (no `REDIS_URL`, e.g. local dev / tests): a deduped
 *     pending set drained SEQUENTIALLY. This is deliberately not a fallback to
 *     the old inline call: running generation inline is the bug, so reproducing
 *     it whenever Redis is missing would reintroduce the outage in exactly the
 *     environment least able to absorb it. One file at a time is strictly
 *     better-bounded than the unbounded fan-out it replaces.
 *
 * `enqueueAssetVariantGeneration` is fire-and-forget and NEVER throws into its
 * caller — a queue outage must not fail an upload that already stored its bytes.
 * That is the one thing the old code got right and is preserved.
 *
 * Queue name MUST NOT contain `:` (BullMQ throws) — `asset-variants`.
 */

import { createHash } from 'node:crypto';
import { Queue, Worker, type Job } from 'bullmq';
import { logger } from '../utils/logger';
import { getQueueConnectionOptions } from './connection';
import { isQueueEnabled } from './queueManager';
import { COMPLETED_JOBS_RETENTION, FAILED_JOBS_RETENTION } from './constants';
import { VariantService } from '../services/variantService';
import { s3Service } from '../services/s3ServiceSingleton';

/**
 * The rendition pipeline this queue drains into, built on FIRST USE.
 *
 * Built from `s3ServiceSingleton` rather than reached through
 * `assetServiceSingleton`: this module is imported BY `assetService.ts`, and
 * that singleton constructs an `AssetService` at module-evaluation time, so
 * importing it here resolves the half-initialised class to `undefined` and
 * throws at boot. `VariantService` holds nothing but the storage client, so a
 * second instance over the SHARED client is identical in behaviour to the one
 * `AssetService` keeps.
 *
 * Lazy rather than a module-level `const` for the same family of reason. This
 * module sits in the import graph of anything that touches `assetService`, so
 * constructing at import time runs `new VariantService(...)` before the
 * importing module's own top-level bindings exist — which a test that replaces
 * `VariantService` with a class closing over its `const` spies hits as a TDZ
 * `ReferenceError` at import, in a suite that has nothing to do with queueing.
 * A queue module has no business doing construction work just to be imported.
 */
let variantService: VariantService | null = null;

function getVariantService(): VariantService {
  variantService ??= new VariantService(s3Service);
  return variantService;
}

/** BullMQ queue name (no `:` allowed). */
const ASSET_VARIANTS_QUEUE = 'asset-variants';
/** Job name for a single file's rendition set. */
const ASSET_VARIANTS_JOB = 'generate';

/**
 * Jobs processed at once by ONE worker.
 *
 * Deliberately 1, and not a tuning knob to reach for casually: a single
 * `generateVariants` is already a sequential run of up to seven sharp encodes or
 * three x264 transcodes, each of which saturates the fractional vCPU this task
 * is entitled to. Raising it re-creates the contention this module exists to
 * remove. It is the TASK that should get bigger first.
 */
export const ASSET_VARIANT_WORKER_CONCURRENCY = 1;

/** Retry attempts for a failed generation, with exponential backoff. */
const ASSET_VARIANT_JOB_ATTEMPTS = 3;
const ASSET_VARIANT_BACKOFF_MS = 30_000;

interface AssetVariantsJobData {
  fileId: string;
}

/**
 * Stable per-file job id so a file already queued/active is never enqueued
 * twice — the dedup is fleet-wide, at the queue layer.
 *
 * BullMQ custom job ids MUST NOT contain `:` — a `:` throws "Custom Id cannot
 * contain :", the enqueue fails, and the file silently never gets variants. File
 * ids are uuids today and carry no colon, but hashing removes the question
 * permanently rather than depending on an id format staying that way.
 */
export function assetVariantsJobId(fileId: string): string {
  return `av-${createHash('sha256').update(fileId).digest('hex')}`;
}

/* -------------------------------------------------------------------------- */
/*  BullMQ path                                                               */
/* -------------------------------------------------------------------------- */

let queue: Queue<AssetVariantsJobData> | null = null;
let worker: Worker<AssetVariantsJobData> | null = null;

/* -------------------------------------------------------------------------- */
/*  In-process fallback                                                       */
/* -------------------------------------------------------------------------- */

const pending = new Set<string>();
const inFlight = new Set<string>();
let draining = false;
let stopped = false;

/**
 * Which start/stop cycle the current drain belongs to.
 *
 * A drain awaits generation, and generation can hang — a wedged ffmpeg is the
 * realistic case. A plain `draining` boolean would then stay `true` forever and
 * the fallback would silently never process another file, which is the opposite
 * failure from the unbounded one this module fixes but just as total. Bumping
 * the epoch on stop retires the parked drain (it exits at its next checkpoint
 * instead of competing with the drain that comes after the next start) without
 * needing to cancel a promise nothing can cancel.
 */
let epoch = 0;

/**
 * Sequentially drain the in-process pending set — one file's rendition set at a
 * time. Self-guards against overlapping drains and exits once `stopped` or once
 * its epoch has been retired. A failure is logged and the drain continues; there
 * is no durable queue to retry from on this path, and the lazy read path
 * (`assetService.ensureVariant`) still materialises any single variant a client
 * actually asks for.
 */
async function drainInProcess(): Promise<void> {
  if (draining) return;
  draining = true;
  const myEpoch = epoch;
  try {
    while (pending.size > 0 && !stopped && myEpoch === epoch) {
      const fileId = pending.values().next().value as string;
      pending.delete(fileId);
      if (inFlight.has(fileId)) continue;
      inFlight.add(fileId);
      try {
        await getVariantService().generateVariants(fileId);
      } catch (err) {
        logger.error('In-process asset variant generation failed', {
          component: 'assetVariants',
          fileId,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        inFlight.delete(fileId);
      }
    }
  } finally {
    // Only the drain that still owns the epoch may release the guard; a retired
    // one must not unlock a live successor.
    if (myEpoch === epoch) {
      draining = false;
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Schedule variant generation for `fileId` — a deduped, fire-and-forget hint.
 * With BullMQ it adds a per-file job that BullMQ ignores while one is already
 * queued/active. In the fallback it adds to the in-process pending set (skipped
 * if already pending or in flight) and kicks a drain on the next tick.
 *
 * NEVER throws into the caller, and never awaits generation: an upload's
 * response must not depend on a transcode.
 */
export function enqueueAssetVariantGeneration(fileId: string): void {
  if (queue) {
    void queue
      .add(
        ASSET_VARIANTS_JOB,
        { fileId },
        {
          jobId: assetVariantsJobId(fileId),
          attempts: ASSET_VARIANT_JOB_ATTEMPTS,
          backoff: { type: 'exponential', delay: ASSET_VARIANT_BACKOFF_MS },
          removeOnComplete: COMPLETED_JOBS_RETENTION,
          removeOnFail: FAILED_JOBS_RETENTION,
        },
      )
      .catch((err: unknown) =>
        logger.warn('Failed to enqueue asset variant job', {
          component: 'assetVariants',
          fileId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return;
  }

  if (stopped) return;
  if (pending.has(fileId) || inFlight.has(fileId)) return;
  pending.add(fileId);
  setImmediate(() => {
    void drainInProcess();
  });
}

/**
 * Start the asset-variant subsystem. BullMQ (durable, fleet-wide dedup) when
 * queues are enabled, otherwise the sequential in-process fallback. Never throws
 * — a queue setup failure logs and falls back.
 */
export async function startAssetVariantJobs(): Promise<void> {
  stopped = false;

  if (!isQueueEnabled()) {
    logger.info('Asset variant generation using in-process fallback (REDIS_URL unset)');
    return;
  }

  try {
    queue = new Queue<AssetVariantsJobData>(ASSET_VARIANTS_QUEUE, {
      connection: getQueueConnectionOptions(),
      defaultJobOptions: {
        removeOnComplete: COMPLETED_JOBS_RETENTION,
        removeOnFail: FAILED_JOBS_RETENTION,
      },
    });
    queue.on('error', (err: Error) =>
      logger.error('Asset variant queue error', { error: err.message }),
    );

    worker = new Worker<AssetVariantsJobData>(
      ASSET_VARIANTS_QUEUE,
      async (job: Job<AssetVariantsJobData>) => {
        const fileId = job.data.fileId;
        if (fileId) {
          // Deliberately NOT wrapped in a try/catch: a throw is what marks the
          // job failed, so a total generation loss is observable in the queue
          // and retried, instead of looking identical to a healthy upload.
          await getVariantService().generateVariants(fileId);
        }
      },
      {
        connection: getQueueConnectionOptions(),
        concurrency: ASSET_VARIANT_WORKER_CONCURRENCY,
      },
    );
    worker.on('failed', (job, err: Error) =>
      logger.error('Asset variant job failed', {
        jobId: job?.id,
        fileId: job?.data?.fileId,
        attemptsMade: job?.attemptsMade,
        error: err.message,
      }),
    );
    worker.on('error', (err: Error) =>
      logger.error('Asset variant worker error', { error: err.message }),
    );

    logger.info('Asset variant generation started via BullMQ (durable, fleet-wide dedup)', {
      concurrency: ASSET_VARIANT_WORKER_CONCURRENCY,
    });
  } catch (err) {
    logger.error(
      'Asset variant BullMQ setup failed — falling back to in-process',
      err instanceof Error ? err : new Error(String(err)),
    );
    await teardownQueue();
  }
}

/** Close the BullMQ worker + queue (and the connections they own). */
async function teardownQueue(): Promise<void> {
  const w = worker;
  const q = queue;
  worker = null;
  queue = null;
  if (w) {
    await w.close().catch((err) =>
      logger.warn('Asset variant worker close failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  if (q) {
    await q.close().catch((err) =>
      logger.warn('Asset variant queue close failed', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/**
 * Stop the asset-variant subsystem. Closes BullMQ resources and clears the
 * fallback set. Safe to call regardless of which path ran. Intended for the
 * server's graceful-shutdown sequence (BEFORE the shared Redis client closes).
 */
export async function stopAssetVariantJobs(): Promise<void> {
  stopped = true;
  pending.clear();
  inFlight.clear();
  // Retire the current drain — including one parked forever on a hung
  // generation — so a later start is not wedged by it.
  epoch += 1;
  draining = false;
  await teardownQueue();
}
