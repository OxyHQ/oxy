/**
 * Node-ingest scheduling (self-sovereign identity layer — F5b node → Oxy).
 *
 * The single decision point for HOW the background node-ingest work runs,
 * mirroring `backgroundJobs.ts`:
 *
 *   - **BullMQ path** (`REDIS_URL` set): a dedicated queue carries two job kinds —
 *     a repeatable, fleet-wide PULL SWEEP (deduped by a stable scheduler id, so
 *     exactly one schedule exists across the fleet — the "leader-gated" effect)
 *     and on-demand per-user INGEST jobs (deduped by a per-user jobId, so a user
 *     with an ingest already in flight is never enqueued twice). One in-process
 *     worker drains the queue.
 *
 *   - **In-process fallback** (no `REDIS_URL`, e.g. local dev / tests): an
 *     unref'd interval runs the same pull sweep, and a deduped in-process queue
 *     (drained sequentially) handles on-demand `notify` hints — same semantics,
 *     no Redis required.
 *
 * NOTHING here is ever awaited in a request's read path. `enqueueNodeIngest` is a
 * fire-and-forget hint: it only schedules a re-pull of the user's OWN node, which
 * the worker then fully re-verifies. The actual node I/O lives entirely in
 * `nodeSync.ingestFromNode` (SSRF-safe `safeFetch`, background only).
 */

import { Queue, Worker, type Job } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { userNodes } from '../db/schema/userNodes';
import { ingestFromNode } from '../services/nodeSync.service';
import { logger } from '../utils/logger';
import { getQueueConnectionOptions } from './connection';
import { isQueueEnabled } from './queueManager';
import { COMPLETED_JOBS_RETENTION, FAILED_JOBS_RETENTION } from './constants';
import {
  NODE_INGEST_QUEUE_NAME,
  NODE_INGEST_SWEEP_SCHEDULER_ID,
  NODE_INGEST_SWEEP_JOB,
  NODE_INGEST_USER_JOB,
  NODE_INGEST_SWEEP_INTERVAL_MS,
  NODE_INGEST_SWEEP_BATCH,
} from '../utils/nodes.constants';

/** Job payload: the sweep job carries no data; a user job carries `{ userId }`. */
interface NodeIngestJobData {
  userId?: string;
}

/* -------------------------------------------------------------------------- */
/*  Shared sweep                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Enqueue an ingest for every `mode:'pull'` node that is not revoked (least-
 * recently-synced first, bounded batch). Each enqueue is deduped, so a node still
 * mid-ingest is not re-scheduled. Reads Oxy's own `user_nodes` rows only — it
 * does NOT touch any node (the worker does, in the background).
 *
 * **`NULLS FIRST` is load-bearing, exactly as in `sweepNodeLiveness`.** Mongo
 * sorts a missing `lastSyncedAt` ahead of every date on an ascending sort;
 * Postgres puts NULLs LAST by default. A node that has NEVER been ingested IS
 * the least-recently-synced one, so with the default ordering a freshly
 * registered node would sit behind {@link NODE_INGEST_SWEEP_BATCH} already-synced
 * ones and never be picked up at all.
 */
export async function sweepPullNodes(): Promise<void> {
  const nodes = await getDb()
    .select({ userId: userNodes.userId })
    .from(userNodes)
    .where(
      and(
        eq(userNodes.mode, 'pull'),
        // The statuses are ENUMERATED rather than written `<> 'revoked'`: a
        // status added later is not silently swept just because it is not
        // `revoked`. This is the Mongo `$in` verbatim.
        inArray(userNodes.status, ['active', 'unreachable']),
      ),
    )
    .orderBy(sql`${userNodes.lastSyncedAt} asc nulls first`)
    .limit(NODE_INGEST_SWEEP_BATCH);

  for (const node of nodes) {
    enqueueNodeIngest(node.userId);
  }
}

/* -------------------------------------------------------------------------- */
/*  BullMQ path                                                               */
/* -------------------------------------------------------------------------- */

let queue: Queue<NodeIngestJobData> | null = null;
let worker: Worker<NodeIngestJobData> | null = null;

/* -------------------------------------------------------------------------- */
/*  In-process fallback                                                       */
/* -------------------------------------------------------------------------- */

const pending = new Set<string>();
const inFlight = new Set<string>();
let fallbackTimer: ReturnType<typeof setInterval> | null = null;
let draining = false;
let stopped = false;

/**
 * Sequentially drain the in-process pending set (bounds outbound concurrency to
 * one ingest at a time). Self-guards against overlapping drains and exits between
 * items once `stopped`. Each ingest is non-throwing (`ingestFromNode` is
 * background-safe); a stray error is still caught so the drain never dies.
 */
async function drainInProcess(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (pending.size > 0 && !stopped) {
      const userId = pending.values().next().value as string;
      pending.delete(userId);
      if (inFlight.has(userId)) continue;
      inFlight.add(userId);
      try {
        await ingestFromNode(userId);
      } catch (err) {
        logger.error(
          'In-process node ingest failed',
          err instanceof Error ? err : new Error(String(err)),
          { component: 'nodeIngest', userId },
        );
      } finally {
        inFlight.delete(userId);
      }
    }
  } finally {
    draining = false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Schedule a background ingest for `userId`'s node — a deduped, fire-and-forget
 * hint. With BullMQ it adds a per-user job (jobId = the user job name + userId)
 * that BullMQ ignores while one is already queued/active. In the fallback it adds
 * to the in-process pending set (skipped if already pending or in flight) and
 * kicks a drain on the next tick. NEVER throws into the caller.
 */
export function enqueueNodeIngest(userId: string): void {
  if (queue) {
    void queue
      .add(
        NODE_INGEST_USER_JOB,
        { userId },
        {
          jobId: `${NODE_INGEST_USER_JOB}:${userId}`,
          removeOnComplete: COMPLETED_JOBS_RETENTION,
          removeOnFail: FAILED_JOBS_RETENTION,
        },
      )
      .catch((err: unknown) =>
        logger.warn('Failed to enqueue node ingest job', {
          component: 'nodeIngest',
          userId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return;
  }

  if (stopped) return;
  if (pending.has(userId) || inFlight.has(userId)) return;
  pending.add(userId);
  setImmediate(() => {
    void drainInProcess();
  });
}

/**
 * Start the node-ingest subsystem. BullMQ (durable, fleet-wide) when queues are
 * enabled, otherwise the in-process interval fallback. Never throws — a queue
 * setup failure logs and falls back to the interval.
 */
export async function startNodeIngestJobs(): Promise<void> {
  stopped = false;

  if (!isQueueEnabled()) {
    startFallback();
    logger.info('Node ingest using in-process interval fallback (REDIS_URL unset)');
    return;
  }

  try {
    queue = new Queue<NodeIngestJobData>(NODE_INGEST_QUEUE_NAME, {
      connection: getQueueConnectionOptions(),
      defaultJobOptions: {
        removeOnComplete: COMPLETED_JOBS_RETENTION,
        removeOnFail: FAILED_JOBS_RETENTION,
      },
    });
    queue.on('error', (err: Error) =>
      logger.error('Node ingest queue error', { error: err.message }),
    );

    worker = new Worker<NodeIngestJobData>(
      NODE_INGEST_QUEUE_NAME,
      async (job: Job<NodeIngestJobData>) => {
        if (job.name === NODE_INGEST_SWEEP_JOB) {
          await sweepPullNodes();
          return;
        }
        const userId = job.data.userId;
        if (userId) {
          await ingestFromNode(userId);
        }
      },
      { connection: getQueueConnectionOptions() },
    );
    worker.on('failed', (job, err: Error) =>
      logger.error('Node ingest job failed', { jobName: job?.name, jobId: job?.id, error: err.message }),
    );
    worker.on('error', (err: Error) =>
      logger.error('Node ingest worker error', { error: err.message }),
    );

    await queue.upsertJobScheduler(
      NODE_INGEST_SWEEP_SCHEDULER_ID,
      { every: NODE_INGEST_SWEEP_INTERVAL_MS },
      { name: NODE_INGEST_SWEEP_JOB },
    );

    logger.info('Node ingest started via BullMQ (durable, fleet-wide scheduling)');
  } catch (err) {
    logger.error(
      'Node ingest BullMQ setup failed — falling back to in-process interval',
      err instanceof Error ? err : new Error(String(err)),
    );
    await teardownQueue();
    startFallback();
  }
}

/** Start the unref'd in-process pull-sweep interval (fallback path). */
function startFallback(): void {
  if (fallbackTimer) return;
  fallbackTimer = setInterval(() => {
    sweepPullNodes().catch((err) =>
      logger.error('Node ingest pull sweep failed', err instanceof Error ? err : new Error(String(err))),
    );
  }, NODE_INGEST_SWEEP_INTERVAL_MS);
  fallbackTimer.unref();
}

/** Close the BullMQ worker + queue (and the connections they own). */
async function teardownQueue(): Promise<void> {
  const w = worker;
  const q = queue;
  worker = null;
  queue = null;
  if (w) {
    await w.close().catch((err) =>
      logger.warn('Node ingest worker close failed', { error: err instanceof Error ? err.message : String(err) }),
    );
  }
  if (q) {
    await q.close().catch((err) =>
      logger.warn('Node ingest queue close failed', { error: err instanceof Error ? err.message : String(err) }),
    );
  }
}

/**
 * Stop the node-ingest subsystem. Closes BullMQ resources and stops the fallback
 * interval. Safe to call regardless of which path ran. Intended for the server's
 * graceful-shutdown sequence (BEFORE the shared Redis client and MongoDB close).
 */
export async function stopNodeIngestJobs(): Promise<void> {
  stopped = true;
  if (fallbackTimer) {
    clearInterval(fallbackTimer);
    fallbackTimer = null;
  }
  pending.clear();
  await teardownQueue();
}
