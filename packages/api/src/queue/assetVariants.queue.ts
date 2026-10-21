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
 *   - **BullMQ path** (`QUEUE_REDIS_URL` set in production): the HTTP process owns only the Queue
 *     producer. A standalone process owns the Worker with an explicit, small
 *     concurrency, so sharp/ffmpeg never competes with HTTP health checks.
 *     A failing job is a FAILED job — retried with backoff and visible in the
 *     queue — rather than a swallowed log line.
 *
 *   - **In-process fallback** (no queue Redis URL, e.g. local dev / tests): a deduped
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
 * ## Redis holds a bounded window; Postgres holds the backlog
 *
 * Every upload used to add a job, so the queue WAS the backlog: on 2026-10-20 a
 * bulk import left 398,416 jobs (~380 MB) on the 384 MB noeviction node, every
 * write failed, workers could not even complete a job, and their loop logged
 * ~1,600 errors a second (~1.6 GB of logs an hour). Now:
 *
 *   - every request for renditions is a row of `file_rendition_requests`
 *     (`services/renditionRequests.ts`), the durable backlog;
 *   - an upload adds its job directly only while the queue is shorter than
 *     {@link ASSET_VARIANT_DIRECT_ENQUEUE_MAX_DEPTH}, so a user's upload is not
 *     stuck behind a bulk import; otherwise it leaves the request due;
 *   - the worker process runs a scheduler that, under a Postgres advisory lock
 *     (one of the fleet at a time), tops the queue up to
 *     {@link ASSET_VARIANT_QUEUE_TARGET_DEPTH} from the oldest due requests at a
 *     lower priority, and takes any job beyond the direct bound back into the
 *     table (the backlog a pre-bound producer left);
 *   - a job settles its request when it is built or given up on; a request is
 *     LEASED while its job is queued, so a job lost with Redis is found again
 *     when the lease runs out.
 *
 * Completed and failed jobs are not kept in Redis (`removeOnComplete`/
 * `removeOnFail`): the table and the logs are the record, and a kept job would
 * make a later request for the same file a no-op under its job id.
 *
 * ## Redis errors back off
 *
 * BullMQ's worker loop retries a failed script (an OOM under noeviction) with no
 * delay: it emits `error` and fetches again. The worker therefore pauses itself
 * on an error and resumes after a bounded exponential backoff, and every error
 * stream here is logged as a rate-limited summary, never one line per attempt.
 *
 * Queue name MUST NOT contain `:` (BullMQ throws) — `asset-variants`.
 */

import { createHash } from 'node:crypto';
import { normalizeInfrastructureRegion } from '@oxy.so/telemetry/collector';
import { sql } from 'drizzle-orm';
import { observeAssetJob } from '../services/workerActivity.service';
import { Queue, Worker, type Job, type JobsOptions } from 'bullmq';
import { getDb } from '../config/postgres';
import { logger } from '../utils/logger';
import { getAssetVariantQueueConnectionOptions, getAssetVariantQueueUrl } from './connection';
import { VariantService } from '../services/variantService';
import { s3Service } from '../services/s3ServiceSingleton';
import {
  adoptRenditionRequests,
  claimDueRenditionRequests,
  countRenditionRequests,
  oldestRenditionRequestAt,
  recordRenditionRequest,
  releaseRenditionRequest,
  type RenditionRequest,
  settleRenditionRequest,
} from '../services/renditionRequests';

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
const ASSET_VARIANT_METRIC_INTERVAL_MS = 60_000;
const ASSET_VARIANT_METRIC_NAMESPACE = 'Oxy/Queues';

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

/**
 * The depth (waiting, prioritized and delayed jobs) the scheduler keeps the
 * queue topped up to from `file_rendition_requests`. About a megabyte of Redis.
 */
export const ASSET_VARIANT_QUEUE_TARGET_DEPTH = 1_000;
/**
 * Below this depth an upload adds its own job (ahead of the scheduler's, which
 * carry a lower priority); at or above it the upload leaves its request to the
 * scheduler. Jobs beyond it are taken back into the table.
 */
export const ASSET_VARIANT_DIRECT_ENQUEUE_MAX_DEPTH = 2_000;
/** How long a queued job holds its request before the request is due again. */
export const ASSET_VARIANT_REQUEST_LEASE_MS = 30 * 60_000;
/** Jobs beyond the direct bound taken back into the table per scheduler pass. */
export const ASSET_VARIANT_ADOPTION_BATCH = 2_000;
/** Priority of the scheduler's backlog jobs (BullMQ: unprioritized jobs go first). */
export const ASSET_VARIANT_BACKLOG_PRIORITY = 10;

const SCHEDULER_INTERVAL_MS = 10_000;
/** The next pass when the last one still took jobs back: the backlog drains briskly. */
const SCHEDULER_ADOPTING_INTERVAL_MS = 1_000;
const SCHEDULER_FAILURE_BACKOFF_MAX_MS = 5 * 60_000;
export const WORKER_ERROR_BACKOFF_MIN_MS = 1_000;
export const WORKER_ERROR_BACKOFF_MAX_MS = 60_000;
const ERROR_SUMMARY_INTERVAL_MS = 60_000;
/** Advisory lock of the scheduler: one pass at a time across the worker fleet. */
const SCHEDULER_LOCK = 'oxy:asset-variant-scheduler';

interface AssetVariantsJobData {
  fileId: string;
  /** The request this job settles (ISO, millisecond precision); absent on a pre-bound job. */
  requestedAt?: string;
  activitySourceRegion?: string;
}

const JOB_OPTIONS: JobsOptions = {
  attempts: ASSET_VARIANT_JOB_ATTEMPTS,
  backoff: { type: 'exponential', delay: ASSET_VARIANT_BACKOFF_MS },
  removeOnComplete: true,
  removeOnFail: true,
};

/** The region a job is produced in, read when the work is asked for. */
function producerRegion(): string | undefined {
  return normalizeInfrastructureRegion(process.env.AWS_REGION) || undefined;
}

function jobData(
  fileId: string,
  request: RenditionRequest | null,
  activitySourceRegion = producerRegion(),
): AssetVariantsJobData {
  return {
    fileId,
    ...(request ? { requestedAt: request.requestedAt.toISOString() } : {}),
    ...(activitySourceRegion ? { activitySourceRegion } : {}),
  };
}

function requestOf(data: AssetVariantsJobData): RenditionRequest | null {
  if (!data.requestedAt) return null;
  const requestedAt = new Date(data.requestedAt);
  return Number.isNaN(requestedAt.getTime()) ? null : { fileId: data.fileId, requestedAt };
}

/**
 * One error stream, logged as a summary at most once per interval: the first
 * occurrence at once, then how many followed and the latest message.
 */
export class ThrottledErrorLog {
  private suppressed = 0;
  private lastLoggedAt = Number.NEGATIVE_INFINITY;
  private latest = '';

  constructor(
    private readonly message: string,
    private readonly intervalMs = ERROR_SUMMARY_INTERVAL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  note(err: unknown, context: Record<string, unknown> = {}): void {
    this.latest = err instanceof Error ? err.message : String(err);
    const at = this.now();
    if (at - this.lastLoggedAt < this.intervalMs) {
      this.suppressed += 1;
      return;
    }
    logger.error(this.message, {
      component: 'assetVariants',
      error: this.latest,
      suppressedSinceLastLog: this.suppressed,
      ...context,
    });
    this.suppressed = 0;
    this.lastLoggedAt = at;
  }
}

// Fresh per start, so a restarted producer or worker reports its first error at once.
let producerErrors = new ThrottledErrorLog('Asset variant request could not be queued');
let schedulerErrors = new ThrottledErrorLog('Asset variant scheduler pass failed');
let settleErrors = new ThrottledErrorLog('Asset variant request could not be settled');

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
let metricInterval: NodeJS.Timeout | null = null;
let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerFailureDelayMs = SCHEDULER_INTERVAL_MS;
let stopWorkerErrorBackoff: (() => void) | null = null;

function isAssetVariantQueueEnabled(): boolean {
  return Boolean(getAssetVariantQueueUrl());
}

/** Jobs the queue holds that are not yet running: what bounds its memory. */
async function queueDepth(q: Queue<AssetVariantsJobData>): Promise<number> {
  const counts = await q.getJobCounts('waiting', 'prioritized', 'delayed', 'paused');
  return (
    (counts.waiting ?? 0) + (counts.prioritized ?? 0) + (counts.delayed ?? 0) + (counts.paused ?? 0)
  );
}

/**
 * `QueueDepth` is the queue's (bounded) depth and `PendingRenditionRequests`
 * the real backlog; `OldestWaitingJobAgeSeconds` is how long the backlog's
 * oldest request has waited — wherever it waits, Redis or the table — which is
 * what the age alarm and step scaling must react to.
 */
async function publishAssetVariantQueueMetrics(): Promise<void> {
  if (!queue) return;

  try {
    const [depth, pending, oldest] = await Promise.all([
      queueDepth(queue),
      countRenditionRequests(),
      oldestRenditionRequestAt(),
    ]);
    const oldestWaitingJobAgeSeconds = oldest
      ? Math.max(0, Math.floor((Date.now() - oldest.getTime()) / 1000))
      : 0;

    logger.info('Asset variant queue metrics', {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: ASSET_VARIANT_METRIC_NAMESPACE,
            Dimensions: [['QueueName']],
            Metrics: [
              { Name: 'QueueDepth', Unit: 'Count' },
              { Name: 'PendingRenditionRequests', Unit: 'Count' },
              { Name: 'OldestWaitingJobAgeSeconds', Unit: 'Seconds' },
            ],
          },
        ],
      },
      QueueName: ASSET_VARIANTS_QUEUE,
      QueueDepth: depth,
      PendingRenditionRequests: pending,
      OldestWaitingJobAgeSeconds: oldestWaitingJobAgeSeconds,
    });
  } catch (err) {
    logger.error(
      'Failed to publish asset variant queue metrics',
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}

function publishAssetVariantPermanentFailure(): void {
  logger.info('Asset variant permanent failure metric', {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: ASSET_VARIANT_METRIC_NAMESPACE,
          Dimensions: [['QueueName']],
          Metrics: [{ Name: 'PermanentJobFailures', Unit: 'Count' }],
        },
      ],
    },
    QueueName: ASSET_VARIANTS_QUEUE,
    PermanentJobFailures: 1,
  });
}

/** Settle a job's request, never failing the job over it: an unsettled request is built again. */
async function settle(request: RenditionRequest | null): Promise<void> {
  if (!request) return;
  try {
    await settleRenditionRequest(request);
  } catch (err) {
    settleErrors.note(err);
  }
}

/**
 * Pause the worker on an error and resume it after a bounded exponential
 * backoff, reset by the next completed job. BullMQ's loop would otherwise
 * retry a failing script at once, forever (see "Redis errors back off").
 * Returns the function that cancels a pending resume.
 */
export function backOffOnWorkerErrors(
  w: Pick<Worker<AssetVariantsJobData>, 'on' | 'pause' | 'resume'>,
  minMs = WORKER_ERROR_BACKOFF_MIN_MS,
  maxMs = WORKER_ERROR_BACKOFF_MAX_MS,
): () => void {
  const errors = new ThrottledErrorLog('Asset variant worker error');
  let delayMs = minMs;
  let resumeTimer: NodeJS.Timeout | null = null;
  w.on('error', (err: Error) => {
    errors.note(err, { backoffMs: delayMs });
    if (resumeTimer) return;
    const wait = delayMs;
    delayMs = Math.min(delayMs * 2, maxMs);
    void w.pause(true).catch((pauseErr: unknown) => errors.note(pauseErr, { step: 'pause' }));
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      w.resume();
    }, wait);
    resumeTimer.unref();
  });
  w.on('completed', () => {
    delayMs = minMs;
  });
  return () => {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = null;
  };
}

export interface SchedulerPass {
  /** Another worker held the scheduler lock; nothing was done. */
  skipped: boolean;
  /** Jobs beyond the direct bound taken back into the table. */
  adopted: number;
  /** Due requests added to the queue. */
  enqueued: number;
}

/**
 * One scheduler pass, under a transaction-scoped advisory lock so the fleet
 * runs one at a time:
 *
 *  1. Jobs beyond {@link ASSET_VARIANT_DIRECT_ENQUEUE_MAX_DEPTH} in the waiting
 *     list (the oldest stay) are recorded as due requests — committed first —
 *     and then removed from Redis. A job that started meanwhile cannot be
 *     removed and simply runs; its request is then built twice at worst.
 *  2. The queue is topped up to {@link ASSET_VARIANT_QUEUE_TARGET_DEPTH} with
 *     the oldest due requests, leased in this transaction. If the add fails the
 *     transaction rolls back and the requests stay due.
 */
export async function runAssetVariantSchedulerPass(
  q: Queue<AssetVariantsJobData>,
): Promise<SchedulerPass> {
  return getDb().transaction(async (tx) => {
    const [lock] = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(hashtextextended(${SCHEDULER_LOCK}, 0)) as locked`,
    );
    if (!lock?.locked) return { skipped: true, adopted: 0, enqueued: 0 };

    let adopted = 0;
    const { waiting = 0 } = await q.getJobCounts('waiting');
    if (waiting > ASSET_VARIANT_DIRECT_ENQUEUE_MAX_DEPTH) {
      const excess = (
        await q.getJobs(
          ['waiting'],
          ASSET_VARIANT_DIRECT_ENQUEUE_MAX_DEPTH,
          ASSET_VARIANT_DIRECT_ENQUEUE_MAX_DEPTH + ASSET_VARIANT_ADOPTION_BATCH - 1,
          true,
        )
      ).filter((job): job is Job<AssetVariantsJobData> => Boolean(job?.data?.fileId));
      // Outside the transaction: the requests must be durable BEFORE the jobs go.
      await adoptRenditionRequests(
        excess.map((job) => ({
          fileId: job.data.fileId,
          requestedAt: requestOf(job.data)?.requestedAt ?? new Date(job.timestamp),
        })),
      );
      const removed = await Promise.all(
        excess.map((job) =>
          job.remove().then(
            () => true,
            () => false,
          ),
        ),
      );
      adopted = removed.filter(Boolean).length;
    }

    const room = ASSET_VARIANT_QUEUE_TARGET_DEPTH - (await queueDepth(q));
    const due = await claimDueRenditionRequests(room, ASSET_VARIANT_REQUEST_LEASE_MS, tx);
    if (due.length > 0) {
      await q.addBulk(
        due.map((request) => ({
          name: ASSET_VARIANTS_JOB,
          data: jobData(request.fileId, request),
          opts: {
            ...JOB_OPTIONS,
            jobId: assetVariantsJobId(request.fileId),
            priority: ASSET_VARIANT_BACKLOG_PRIORITY,
          },
        })),
      );
    }
    return { skipped: false, adopted, enqueued: due.length };
  });
}

function scheduleNextPass(delayMs: number): void {
  schedulerTimer = setTimeout(() => {
    schedulerTimer = null;
    void schedulerPass();
  }, delayMs);
  schedulerTimer.unref();
}

async function schedulerPass(): Promise<void> {
  const q = queue;
  if (!q || !worker) return;
  let next = SCHEDULER_INTERVAL_MS;
  try {
    const pass = await runAssetVariantSchedulerPass(q);
    schedulerFailureDelayMs = SCHEDULER_INTERVAL_MS;
    if (pass.adopted > 0) {
      next = SCHEDULER_ADOPTING_INTERVAL_MS;
      logger.info('Asset variant backlog taken back into Postgres', {
        component: 'assetVariants',
        adopted: pass.adopted,
      });
    }
  } catch (err) {
    schedulerErrors.note(err, { retryInMs: schedulerFailureDelayMs });
    next = schedulerFailureDelayMs;
    schedulerFailureDelayMs = Math.min(
      schedulerFailureDelayMs * 2,
      SCHEDULER_FAILURE_BACKOFF_MAX_MS,
    );
  }
  if (queue === q && worker) scheduleNextPass(next);
}

/* -------------------------------------------------------------------------- */
/*  In-process fallback                                                       */
/* -------------------------------------------------------------------------- */

const pending = new Set<string>();
const inFlight = new Set<string>();
let draining = false;
let stopped = true;

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
 * Record the request, and add its job when the queue has room — a user's upload
 * then goes ahead of the backlog. With no room, or when the queue cannot be
 * reached, the request stays due and the scheduler adds it. A request that
 * could not be recorded still gets its job when there is room (it then settles
 * nothing, like a pre-bound job).
 */
async function requestRenditions(
  q: Queue<AssetVariantsJobData>,
  fileId: string,
  region: string | undefined,
): Promise<void> {
  let room = false;
  try {
    room = (await queueDepth(q)) < ASSET_VARIANT_DIRECT_ENQUEUE_MAX_DEPTH;
  } catch (err) {
    producerErrors.note(err, { step: 'depth' });
  }
  let request: RenditionRequest | null = null;
  try {
    request = await recordRenditionRequest(fileId, room ? ASSET_VARIANT_REQUEST_LEASE_MS : null);
  } catch (err) {
    producerErrors.note(err, { step: 'record' });
  }
  if (!room) return;
  try {
    await q.add(ASSET_VARIANTS_JOB, jobData(fileId, request, region), {
      ...JOB_OPTIONS,
      jobId: assetVariantsJobId(fileId),
    });
  } catch (err) {
    producerErrors.note(err, { step: 'add' });
    if (request) {
      await releaseRenditionRequest(request).catch((releaseErr: unknown) =>
        producerErrors.note(releaseErr, { step: 'release' }),
      );
    }
  }
}

/**
 * Schedule variant generation for `fileId` — a deduped, fire-and-forget hint.
 * With BullMQ it records the request in Postgres and adds the per-file job when
 * the queue has room (BullMQ ignores the add while that job is queued or
 * active); the scheduler adds it otherwise. In the fallback it adds to the
 * in-process pending set (skipped if already pending or in flight) and kicks a
 * drain on the next tick.
 *
 * NEVER throws into the caller, and never awaits generation: an upload's
 * response must not depend on a transcode.
 */
export function enqueueAssetVariantGeneration(fileId: string): void {
  if (queue) {
    void requestRenditions(queue, fileId, producerRegion());
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
 * Start the producer used by the HTTP process. Development without Redis keeps
 * the sequential fallback; production requires a reachable durable queue and
 * fails startup rather than moving CPU-heavy work back into the API fleet.
 */
export async function startAssetVariantProducer(): Promise<void> {
  stopped = false;

  if (!isAssetVariantQueueEnabled()) {
    if (process.env.NODE_ENV === 'production') {
      stopped = true;
      throw new Error('QUEUE_REDIS_URL is required for the production asset-variant producer');
    }
    logger.info('Asset variant generation using in-process fallback (queue Redis URL unset)');
    return;
  }

  try {
    producerErrors = new ThrottledErrorLog('Asset variant request could not be queued');
    queue = new Queue<AssetVariantsJobData>(ASSET_VARIANTS_QUEUE, {
      connection: getAssetVariantQueueConnectionOptions(),
      defaultJobOptions: JOB_OPTIONS,
    });
    const queueErrors = new ThrottledErrorLog('Asset variant queue error');
    queue.on('error', (err: Error) => queueErrors.note(err));
    await queue.waitUntilReady();

    logger.info('Asset variant producer started via BullMQ (durable, fleet-wide dedup)');
  } catch (err) {
    await teardownQueue();
    if (process.env.NODE_ENV === 'production') {
      stopped = true;
      throw err;
    }
    logger.error(
      'Asset variant BullMQ producer setup failed — falling back to in-process',
      err instanceof Error ? err : new Error(String(err)),
    );
  }
}

/**
 * Start the standalone BullMQ consumer. This has no in-process fallback: the
 * worker process without Redis cannot receive jobs, so staying alive would be
 * a false health signal while work accumulates nowhere.
 */
export async function startAssetVariantWorker(): Promise<void> {
  if (!isAssetVariantQueueEnabled()) {
    throw new Error('QUEUE_REDIS_URL is required for the asset-variant worker');
  }
  if (worker) return;

  try {
    schedulerErrors = new ThrottledErrorLog('Asset variant scheduler pass failed');
    settleErrors = new ThrottledErrorLog('Asset variant request could not be settled');
    queue = new Queue<AssetVariantsJobData>(ASSET_VARIANTS_QUEUE, {
      connection: getAssetVariantQueueConnectionOptions(),
      defaultJobOptions: JOB_OPTIONS,
    });
    const queueErrors = new ThrottledErrorLog('Asset variant queue metrics connection error');
    queue.on('error', (err: Error) => queueErrors.note(err));
    worker = new Worker<AssetVariantsJobData>(
      ASSET_VARIANTS_QUEUE,
      async (job: Job<AssetVariantsJobData>) => {
        const fileId = job.data.fileId;
        if (fileId) {
          observeAssetJob(job.data.activitySourceRegion);
          // Deliberately NOT wrapped in a try/catch: a throw is what marks the
          // job failed, so a total generation loss is observable in the queue
          // and retried, instead of looking identical to a healthy upload.
          await getVariantService().generateVariants(fileId);
          await settle(requestOf(job.data));
        }
      },
      {
        connection: getAssetVariantQueueConnectionOptions(),
        concurrency: ASSET_VARIANT_WORKER_CONCURRENCY,
      },
    );
    worker.on('failed', (job, err: Error) => {
      logger.error('Asset variant job failed', {
        jobId: job?.id,
        fileId: job?.data?.fileId,
        attemptsMade: job?.attemptsMade,
        error: err.message,
      });
      if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
        publishAssetVariantPermanentFailure();
        // Given up on, as before the bound: the read path still renders any
        // single variant a client asks for (`assetService.ensureVariant`).
        void settle(requestOf(job.data));
      }
    });
    stopWorkerErrorBackoff = backOffOnWorkerErrors(worker);
    await Promise.all([queue.waitUntilReady(), worker.waitUntilReady()]);
    await publishAssetVariantQueueMetrics();
    metricInterval = setInterval(() => {
      void publishAssetVariantQueueMetrics();
    }, ASSET_VARIANT_METRIC_INTERVAL_MS);
    metricInterval.unref();
    scheduleNextPass(0);

    logger.info('Asset variant worker started via BullMQ', {
      concurrency: ASSET_VARIANT_WORKER_CONCURRENCY,
    });
  } catch (err) {
    await teardownQueue();
    throw err;
  }
}

/** Close the BullMQ worker + queue (and the connections they own). */
async function teardownQueue(): Promise<void> {
  if (metricInterval) {
    clearInterval(metricInterval);
    metricInterval = null;
  }
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  stopWorkerErrorBackoff?.();
  stopWorkerErrorBackoff = null;
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
export async function stopAssetVariantProducer(): Promise<void> {
  stopped = true;
  pending.clear();
  inFlight.clear();
  // Retire the current drain — including one parked forever on a hung
  // generation — so a later start is not wedged by it.
  epoch += 1;
  draining = false;
  await teardownQueue();
}

/** Stop the standalone consumer and close its BullMQ connection. */
export async function stopAssetVariantWorker(): Promise<void> {
  await teardownQueue();
}
