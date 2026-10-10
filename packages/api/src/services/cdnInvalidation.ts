/**
 * CloudFront invalidation for deleted public objects.
 *
 * Public media is served by `cloud.oxy.so` (CloudFront, origin path `/public`)
 * with `Cache-Control: public, max-age=31536000, immutable`. Deleting the S3
 * object therefore removes nothing a viewer can see: the edge keeps serving its
 * copy for up to a year. Every delete path (a user's delete, the federated
 * media delete, cache eviction, account erasure, a visibility downgrade that
 * moves an object out of `public/`) goes through `S3Service.deleteFile`, so the
 * invalidation hangs off that one call rather than off each caller.
 *
 * ## Shape
 *
 * - **Async and non-blocking.** `enqueueDeletedKey` is synchronous and never
 *   throws; the delete it follows has already succeeded. Requests go out from a
 *   debounced flush, so a video's playlist and its hundreds of HLS segments,
 *   deleted within one window, become ONE request.
 * - **Bounded count and cost.** Keys under `variants/` sit in one directory per
 *   content hash; when a window holds two or more keys from the same directory
 *   they collapse to one wildcard (`/variants/…/<sha>/*`), which CloudFront
 *   bills as one path. A lone key stays an exact path.
 * - **Never stalls on the wildcard ceiling.** CloudFront allows only 15
 *   wildcard paths in progress per distribution. A request carries at most
 *   {@link MAX_WILDCARDS_PER_REQUEST}; directories beyond that go out as their
 *   exact paths in the SAME request, and after a `TooManyInvalidationsInProgress`
 *   the queue sends exact paths only for {@link WILDCARD_COOLDOWN_MS}.
 * - **Loud on failure, bounded in memory.** Every failure is logged at `error`.
 *   A throttle retries with backoff and costs a path nothing; any other error
 *   counts against each path in the batch, and a path is dropped — named in the
 *   log — after {@link MAX_ATTEMPTS}. The queue holds at most
 *   {@link MAX_PENDING_PATHS}; past that the OLDEST are dropped and named.
 * - **No-op without configuration.** With `CDN_CLOUDFRONT_DISTRIBUTION_ID`
 *   unset the queue logs ONE warning and does nothing, so this code can deploy
 *   before the IAM grant and the environment variable exist.
 *
 * The queue is per process and in memory: a task killed between a delete and
 * its flush loses that invalidation. The flush window is seconds, and
 * `flushCdnInvalidations` runs, time-boxed, on graceful shutdown.
 */

import { randomUUID } from 'node:crypto';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { PUBLIC_KEY_PREFIX } from '../config/cdn';
import { logger } from '../utils/logger';

/** Wildcard paths per request; CloudFront's in-progress ceiling is 15 per distribution. */
export const MAX_WILDCARDS_PER_REQUEST = 5;
/** Exact paths per request (CloudFront's per-request ceiling is 3000). */
export const MAX_EXACT_PATHS_PER_REQUEST = 1000;
/** Non-throttling failures a path survives before it is dropped. */
export const MAX_ATTEMPTS = 5;
/** Paths held while waiting; past this the oldest are dropped (and named). */
export const MAX_PENDING_PATHS = 20_000;
/** After CloudFront reports too many invalidations in progress, send no wildcards for this long. */
export const WILDCARD_COOLDOWN_MS = 10 * 60_000;
/** How long graceful shutdown waits for the final flush. */
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 5_000;
const DEFAULT_FLUSH_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
/** CloudFront client timeouts: a hung control-plane call must not pin the queue. */
const CLOUDFRONT_CONNECTION_TIMEOUT_MS = 3_000;
const CLOUDFRONT_REQUEST_TIMEOUT_MS = 10_000;
const THROTTLE_ERROR_NAMES = new Set([
  'TooManyInvalidationsInProgress',
  'Throttling',
  'ThrottlingException',
  'TooManyRequestsException',
]);

/** What the queue needs from CloudFront — one call. */
export interface InvalidationSender {
  send(distributionId: string, paths: string[], callerReference: string): Promise<void>;
}

export interface CdnInvalidationOptions {
  distributionId: string | undefined;
  sender?: InvalidationSender;
  flushDelayMs?: number;
  now?: () => number;
}

/**
 * The CDN path CloudFront serves an S3 key at, or null when the key is not
 * CDN-reachable. The distribution's origin path is `/public`, so
 * `public/variants/x.webp` is served at `/variants/x.webp`.
 */
export function cdnPathForKey(key: string): string | null {
  if (typeof key !== 'string' || !key.startsWith(PUBLIC_KEY_PREFIX)) return null;
  const rest = key.slice(PUBLIC_KEY_PREFIX.length);
  if (rest.length === 0) return null;
  return `/${rest}`;
}

export interface InvalidationPlan {
  /** Wildcards sent, each standing for every path under its directory. */
  wildcards: string[];
  /** Exact paths sent. */
  exact: string[];
  /** The queued paths this plan covers (what leaves the queue if it succeeds). */
  covered: string[];
}

/**
 * Choose one request's paths. Two or more paths in the same `/variants/…/`
 * directory become that directory's wildcard, up to `wildcardBudget`; groups
 * past the budget are sent as their exact paths instead of waiting. At most
 * {@link MAX_EXACT_PATHS_PER_REQUEST} exact paths go per request; the rest stay
 * queued for the next one.
 */
export function planInvalidationPaths(
  paths: Iterable<string>,
  wildcardBudget = MAX_WILDCARDS_PER_REQUEST,
): InvalidationPlan {
  const byVariantDir = new Map<string, string[]>();
  const singles: string[] = [];
  for (const path of new Set(paths)) {
    const slash = path.lastIndexOf('/');
    if (path.startsWith('/variants/') && slash > '/variants'.length) {
      const dir = path.slice(0, slash);
      const group = byVariantDir.get(dir) ?? [];
      group.push(path);
      byVariantDir.set(dir, group);
    } else {
      singles.push(path);
    }
  }

  const wildcards: string[] = [];
  const covered: string[] = [];
  const exactCandidates: string[] = [...singles];
  for (const [dir, group] of [...byVariantDir].sort(([a], [b]) => a.localeCompare(b))) {
    if (group.length >= 2 && wildcards.length < wildcardBudget) {
      wildcards.push(`${dir}/*`);
      covered.push(...group);
    } else {
      exactCandidates.push(...group);
    }
  }

  const exact = exactCandidates.sort().slice(0, MAX_EXACT_PATHS_PER_REQUEST);
  covered.push(...exact);
  return { wildcards, exact, covered };
}

function errorName(error: unknown): string {
  if (error && typeof error === 'object' && 'name' in error && typeof error.name === 'string') {
    return error.name;
  }
  return 'Error';
}

class CloudFrontSender implements InvalidationSender {
  private client: CloudFrontClient | null = null;

  async send(distributionId: string, paths: string[], callerReference: string): Promise<void> {
    // Credentials resolve exactly as the S3 client's do: explicit env keys when
    // the task carries them (oxy-api's running revision does — the shared
    // `oxy-s3-apps` user), else the default provider chain (the task role).
    if (!this.client) {
      const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
      const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
      this.client = new CloudFrontClient({
        region: process.env.AWS_REGION || 'us-east-1',
        ...(accessKeyId && secretAccessKey
          ? { credentials: { accessKeyId, secretAccessKey } }
          : {}),
        requestHandler: {
          connectionTimeout: CLOUDFRONT_CONNECTION_TIMEOUT_MS,
          requestTimeout: CLOUDFRONT_REQUEST_TIMEOUT_MS,
        },
        maxAttempts: 2,
      });
    }
    await this.client.send(
      new CreateInvalidationCommand({
        DistributionId: distributionId,
        InvalidationBatch: {
          CallerReference: callerReference,
          Paths: { Quantity: paths.length, Items: paths },
        },
      }),
    );
  }
}

export class CdnInvalidationQueue {
  private readonly distributionId: string | undefined;
  private readonly sender: InvalidationSender;
  private readonly flushDelayMs: number;
  private readonly now: () => number;
  /** Insertion-ordered: the first entry is the oldest. */
  private readonly pending = new Set<string>();
  /** Non-throttling failures per path. */
  private readonly failures = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private wildcardsBlockedUntil = 0;
  private warnedUnconfigured = false;

  constructor(options: CdnInvalidationOptions) {
    const id = options.distributionId?.trim();
    this.distributionId = id && id.length > 0 ? id : undefined;
    this.sender = options.sender ?? new CloudFrontSender();
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    this.now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.distributionId !== undefined;
  }

  /** Paths waiting for a flush (test seam and shutdown diagnostics). */
  pendingPaths(): string[] {
    return [...this.pending].sort();
  }

  /** Record that `key` was deleted from the bucket. Synchronous; never throws. */
  enqueueDeletedKey(key: string): void {
    try {
      const path = cdnPathForKey(key);
      if (!path) return;
      if (!this.distributionId) {
        if (!this.warnedUnconfigured) {
          this.warnedUnconfigured = true;
          logger.warn(
            'CDN invalidation disabled: CDN_CLOUDFRONT_DISTRIBUTION_ID is unset, so deleted public objects stay cached at the CDN edge until they expire',
            { firstKey: key },
          );
        }
        return;
      }
      this.pending.add(path);
      this.enforceCap();
      this.schedule(this.flushDelayMs);
    } catch (error) {
      logger.error('CDN invalidation enqueue failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Send everything pending now (graceful shutdown, tests). Stops at the first failure. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.flushing) {
      await this.flushing;
    }
    while (this.pending.size > 0) {
      const before = this.pending.size;
      const sent = await this.flushOnce();
      // Stop on a failure, and on a pass that moved nothing (never spin).
      if (!sent || this.pending.size >= before) break;
    }
  }

  private enforceCap(): void {
    if (this.pending.size <= MAX_PENDING_PATHS) return;
    const dropped: string[] = [];
    for (const path of this.pending) {
      if (this.pending.size <= MAX_PENDING_PATHS) break;
      this.pending.delete(path);
      this.failures.delete(path);
      dropped.push(path);
    }
    logger.error(
      'CDN invalidation queue full: DROPPED the oldest paths; these deleted objects remain cached at the CDN edge',
      {
        distributionId: this.distributionId,
        cap: MAX_PENDING_PATHS,
        paths: dropped,
      },
    );
  }

  private schedule(delayMs: number): void {
    if (this.timer || this.flushing) return;
    const handle = setTimeout(() => {
      this.timer = null;
      void this.runScheduledFlush();
    }, delayMs);
    handle.unref?.();
    this.timer = handle;
  }

  private async runScheduledFlush(): Promise<void> {
    const sent = await this.flushOnce();
    if (this.pending.size > 0) {
      this.schedule(sent ? this.flushDelayMs : this.retryDelayMs());
    }
  }

  private retryDelayMs(): number {
    return Math.min(
      this.flushDelayMs * 2 ** Math.max(this.consecutiveFailures, 1),
      MAX_RETRY_DELAY_MS,
    );
  }

  /** One CreateInvalidation. Returns false when it failed. */
  private async flushOnce(): Promise<boolean> {
    if (!this.distributionId || this.pending.size === 0) return true;
    const run = this.sendBatch(this.distributionId);
    this.flushing = run.then(() => undefined);
    try {
      return await run;
    } finally {
      this.flushing = null;
    }
  }

  private async sendBatch(distributionId: string): Promise<boolean> {
    const wildcardBudget = this.now() < this.wildcardsBlockedUntil ? 0 : MAX_WILDCARDS_PER_REQUEST;
    const plan = planInvalidationPaths(this.pending, wildcardBudget);
    const batch = [...plan.wildcards, ...plan.exact];
    if (batch.length === 0) {
      logger.error('CDN invalidation planned an empty request; leaving the queue as it is', {
        distributionId,
        pending: this.pending.size,
      });
      return false;
    }
    for (const path of plan.covered) this.pending.delete(path);

    try {
      await this.sender.send(distributionId, batch, `oxy-api-${this.now()}-${randomUUID()}`);
      this.consecutiveFailures = 0;
      for (const path of plan.covered) this.failures.delete(path);
      logger.info('CDN invalidation requested', {
        distributionId,
        paths: batch.length,
        wildcards: plan.wildcards.length,
        covers: plan.covered.length,
      });
      return true;
    } catch (error) {
      this.consecutiveFailures += 1;
      const name = errorName(error);
      const message = error instanceof Error ? error.message : String(error);
      const throttled = THROTTLE_ERROR_NAMES.has(name);
      if (name === 'TooManyInvalidationsInProgress') {
        this.wildcardsBlockedUntil = this.now() + WILDCARD_COOLDOWN_MS;
      }

      const dropped: string[] = [];
      for (const path of plan.covered) {
        const failures = throttled
          ? (this.failures.get(path) ?? 0)
          : (this.failures.get(path) ?? 0) + 1;
        if (failures >= MAX_ATTEMPTS) {
          this.failures.delete(path);
          dropped.push(path);
        } else {
          this.failures.set(path, failures);
          this.pending.add(path);
        }
      }
      this.enforceCap();

      logger.error(
        'CDN invalidation FAILED; deleted objects are still served from the CDN edge — will retry',
        {
          distributionId,
          errorName: name,
          error: message,
          throttled,
          consecutiveFailures: this.consecutiveFailures,
          paths: batch.length,
          samplePaths: batch.slice(0, 5),
        },
      );
      if (dropped.length > 0) {
        logger.error(
          'CDN invalidation DROPPED after repeated failures; these deleted objects remain cached at the CDN edge',
          {
            distributionId,
            errorName: name,
            attempts: MAX_ATTEMPTS,
            paths: dropped,
          },
        );
      }
      return false;
    }
  }
}

let singleton: CdnInvalidationQueue | null = null;

/** The process-wide queue, configured from `CDN_CLOUDFRONT_DISTRIBUTION_ID`. */
export function getCdnInvalidationQueue(): CdnInvalidationQueue {
  if (!singleton) {
    singleton = new CdnInvalidationQueue({
      distributionId: process.env.CDN_CLOUDFRONT_DISTRIBUTION_ID,
    });
  }
  return singleton;
}

/** Graceful-shutdown hook: send whatever is pending, for at most `timeoutMs`. Never throws. */
export async function flushCdnInvalidations(
  queue: CdnInvalidationQueue | null = singleton,
  timeoutMs = SHUTDOWN_FLUSH_TIMEOUT_MS,
): Promise<void> {
  if (!queue) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([queue.flush().then(() => 'done' as const), timedOut]);
    if (result === 'timeout') {
      logger.error(
        'CDN invalidation flush on shutdown timed out; these deleted objects remain cached at the CDN edge',
        {
          timeoutMs,
          paths: queue.pendingPaths(),
        },
      );
    }
  } catch (error) {
    logger.error('CDN invalidation flush on shutdown failed', {
      error: error instanceof Error ? error.message : String(error),
      paths: queue.pendingPaths(),
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}
