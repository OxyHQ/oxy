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
 *   bills as one path. A lone key stays an exact path. CloudFront allows only 15
 *   wildcard paths in progress per distribution, so a request carries at most
 *   {@link MAX_WILDCARDS_PER_REQUEST} and the rest wait for the next flush.
 * - **Loud on failure.** A throttle (`TooManyInvalidationsInProgress`, …) puts
 *   the paths back and retries with backoff; any other error is logged at
 *   `error` on every attempt and the batch is dropped — with its paths named —
 *   after {@link MAX_ATTEMPTS}.
 * - **No-op without configuration.** With `CDN_CLOUDFRONT_DISTRIBUTION_ID`
 *   unset the queue logs ONE warning and does nothing, so this code can deploy
 *   before the IAM grant and the environment variable exist.
 *
 * The queue is per process and in memory: a task killed between a delete and
 * its flush loses that invalidation (the flush window is seconds, and
 * `flushCdnInvalidations` runs on graceful shutdown).
 */

import { randomUUID } from 'node:crypto';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { PUBLIC_KEY_PREFIX } from '../config/cdn';
import { logger } from '../utils/logger';

/** Wildcard paths per request; CloudFront's in-progress ceiling is 15 per distribution. */
export const MAX_WILDCARDS_PER_REQUEST = 5;
/** Exact paths per request (CloudFront's per-request ceiling is 3000). */
export const MAX_EXACT_PATHS_PER_REQUEST = 1000;
/** Attempts for a batch that fails with a non-throttling error before it is dropped. */
export const MAX_ATTEMPTS = 5;
const DEFAULT_FLUSH_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
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
}

/**
 * The CDN path CloudFront serves an S3 key at, or null when the key is not
 * CDN-reachable. The distribution's origin path is `/public`, so
 * `public/variants/x.webp` is served at `/variants/x.webp`.
 */
export function cdnPathForKey(key: string): string | null {
  if (!key.startsWith(PUBLIC_KEY_PREFIX)) return null;
  const rest = key.slice(PUBLIC_KEY_PREFIX.length);
  if (rest.length === 0) return null;
  return `/${rest}`;
}

/**
 * Collapse exact paths into the invalidation path list: two or more paths in the
 * same `/variants/…/` directory become that directory's wildcard.
 */
export function planInvalidationPaths(paths: Iterable<string>): { exact: string[]; wildcards: string[] } {
  const byVariantDir = new Map<string, string[]>();
  const exact: string[] = [];
  for (const path of new Set(paths)) {
    const slash = path.lastIndexOf('/');
    if (path.startsWith('/variants/') && slash > '/variants'.length) {
      const dir = path.slice(0, slash);
      const group = byVariantDir.get(dir) ?? [];
      group.push(path);
      byVariantDir.set(dir, group);
    } else {
      exact.push(path);
    }
  }
  const wildcards: string[] = [];
  for (const [dir, group] of byVariantDir) {
    if (group.length >= 2) {
      wildcards.push(`${dir}/*`);
    } else {
      exact.push(...group);
    }
  }
  return { exact: exact.sort(), wildcards: wildcards.sort() };
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
        ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
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
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private warnedUnconfigured = false;

  constructor(options: CdnInvalidationOptions) {
    const id = options.distributionId?.trim();
    this.distributionId = id && id.length > 0 ? id : undefined;
    this.sender = options.sender ?? new CloudFrontSender();
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
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
      this.schedule(this.flushDelayMs);
    } catch (error) {
      logger.error('CDN invalidation enqueue failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Send everything pending now (graceful shutdown, tests). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.flushing) {
      await this.flushing;
    }
    while (this.pending.size > 0) {
      const sent = await this.flushOnce();
      if (!sent) break;
    }
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
    return Math.min(this.flushDelayMs * 2 ** Math.max(this.consecutiveFailures, 1), MAX_RETRY_DELAY_MS);
  }

  /** One CreateInvalidation. Returns false when it failed (paths are back in the queue or dropped). */
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
    const plan = planInvalidationPaths(this.pending);
    const wildcards = plan.wildcards.slice(0, MAX_WILDCARDS_PER_REQUEST);
    const exact = plan.exact.slice(0, MAX_EXACT_PATHS_PER_REQUEST);
    const batch = [...wildcards, ...exact];
    // The source paths this batch covers, so exactly those leave the queue.
    const exactSet = new Set(exact);
    const wildcardDirs = wildcards.map((w) => w.slice(0, -1));
    const covered = [...this.pending].filter(
      (path) => exactSet.has(path) || wildcardDirs.some((dir) => path.startsWith(dir)),
    );
    for (const path of covered) this.pending.delete(path);

    try {
      await this.sender.send(distributionId, batch, `oxy-api-${Date.now()}-${randomUUID()}`);
      this.consecutiveFailures = 0;
      logger.info('CDN invalidation requested', {
        distributionId,
        paths: batch.length,
        wildcards: wildcards.length,
        covers: covered.length,
      });
      return true;
    } catch (error) {
      this.consecutiveFailures += 1;
      const name = errorName(error);
      const message = error instanceof Error ? error.message : String(error);
      const throttled = THROTTLE_ERROR_NAMES.has(name);
      if (throttled || this.consecutiveFailures < MAX_ATTEMPTS) {
        for (const path of covered) this.pending.add(path);
        logger.error('CDN invalidation FAILED; deleted objects are still served from the CDN edge — will retry', {
          distributionId,
          errorName: name,
          error: message,
          attempt: this.consecutiveFailures,
          paths: batch.length,
          samplePaths: batch.slice(0, 5),
        });
      } else {
        this.consecutiveFailures = 0;
        logger.error('CDN invalidation DROPPED after repeated failures; these deleted objects remain cached at the CDN edge', {
          distributionId,
          errorName: name,
          error: message,
          attempts: MAX_ATTEMPTS,
          paths: batch,
        });
      }
      return false;
    }
  }
}

let singleton: CdnInvalidationQueue | null = null;

/** The process-wide queue, configured from `CDN_CLOUDFRONT_DISTRIBUTION_ID`. */
export function getCdnInvalidationQueue(): CdnInvalidationQueue {
  if (!singleton) {
    singleton = new CdnInvalidationQueue({ distributionId: process.env.CDN_CLOUDFRONT_DISTRIBUTION_ID });
  }
  return singleton;
}

/** Graceful-shutdown hook: send whatever is pending. Never throws. */
export async function flushCdnInvalidations(): Promise<void> {
  if (!singleton) return;
  try {
    await singleton.flush();
  } catch (error) {
    logger.error('CDN invalidation flush on shutdown failed', {
      error: error instanceof Error ? error.message : String(error),
      pending: singleton.pendingPaths().length,
    });
  }
}
