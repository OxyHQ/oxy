/**
 * Cloudflare cache purge for `cloud.oxy.so` (ADR 0047).
 *
 * `cloud.oxy.so` is a Worker that keeps public objects in the edge cache with
 * the Cache-Control they were stored with — for content-addressed media, a
 * year. Deleting the object from R2 removes nothing a viewer can see until the
 * edge forgets it, so every delete of a public object purges its URL, exactly
 * as the CloudFront invalidation did (`cdnInvalidation.ts`, which this runs
 * beside until the distribution is gone).
 *
 * Two kinds of entry:
 *
 * - **An object** (`enqueueDeletedKey`): its URL, `https://cloud.oxy.so/<path>`.
 *   Purged by URL, up to {@link MAX_URLS_PER_REQUEST} per request (Cloudflare's
 *   per-request ceiling on this plan; 800 URLs a second is the rate).
 * - **A file id** (`enqueuePath('/<id>')`): the by-id resolver's cached 302s,
 *   one per `?variant=`. The Worker tags each with `file:<id>`
 *   (`workers/cloud/src/index.ts` `resolverCacheTag`), and the tag purges every
 *   variant at once, as an invalidation of the path did. Tag purges are rate
 *   limited to 5 requests a minute (bursts of 25), so they go
 *   {@link MAX_TAGS_PER_REQUEST} to a request and wait out a 429.
 *
 * Same shape as the CloudFront queue: synchronous enqueue that never throws, a
 * debounced flush, loud bounded retries, a capped queue, and a no-op with one
 * warning while `CLOUDFLARE_ZONE_ID` / `CLOUDFLARE_CACHE_PURGE_TOKEN` are unset.
 */

import { getAssetCdnUrl, isPublicKey, stripPublicPrefix } from '../config/cdn';
import { logger } from '../utils/logger';
import { tracedFetch } from '../utils/tracedFetch';

export const MAX_URLS_PER_REQUEST = 100;
export const MAX_TAGS_PER_REQUEST = 100;
export const MAX_PURGE_ATTEMPTS = 5;
export const MAX_PENDING_PURGES = 20_000;
const DEFAULT_FLUSH_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const PURGE_TIMEOUT_MS = 10_000;

export type PurgeKind = 'files' | 'tags';

/** What the queue needs from Cloudflare — one call. Throws a {@link PurgeError} on failure. */
export interface PurgeSender {
  purge(kind: PurgeKind, items: string[]): Promise<void>;
}

export class PurgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PurgeError';
  }

  get throttled(): boolean {
    return this.status === 429;
  }
}

/** The Cache-Tag the cloud.oxy.so Worker puts on a path's resolver answers. */
export function resolverCacheTag(path: string): string {
  return `file:${path.replace(/^\/+/, '')}`;
}

class CloudflarePurgeSender implements PurgeSender {
  constructor(
    private readonly zoneId: string,
    private readonly token: string,
  ) {}

  async purge(kind: PurgeKind, items: string[]): Promise<void> {
    const response = await tracedFetch(
      `https://api.cloudflare.com/client/v4/zones/${this.zoneId}/purge_cache`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ [kind]: items }),
        signal: AbortSignal.timeout(PURGE_TIMEOUT_MS),
      },
    );
    if (response.ok) return;
    const body = await response.text().catch(() => '');
    throw new PurgeError(
      `Cloudflare purge answered ${response.status}: ${body.slice(0, 300)}`,
      response.status,
    );
  }
}

export interface CloudflarePurgeOptions {
  zoneId: string | undefined;
  token: string | undefined;
  sender?: PurgeSender;
  flushDelayMs?: number;
}

export class CloudflarePurgeQueue {
  private readonly sender: PurgeSender | null;
  private readonly flushDelayMs: number;
  /** Insertion-ordered per kind: the first entry is the oldest. */
  private readonly pending: Record<PurgeKind, Set<string>> = { files: new Set(), tags: new Set() };
  private readonly failures = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private consecutiveFailures = 0;
  private warnedUnconfigured = false;

  constructor(options: CloudflarePurgeOptions) {
    const zoneId = options.zoneId?.trim();
    const token = options.token?.trim();
    this.sender =
      options.sender ?? (zoneId && token ? new CloudflarePurgeSender(zoneId, token) : null);
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
  }

  get enabled(): boolean {
    return this.sender !== null;
  }

  /** URLs and tags waiting for a flush (test seam and shutdown diagnostics). */
  pendingPaths(): string[] {
    return [...this.pending.files, ...this.pending.tags].sort();
  }

  /** Record that `key` was deleted from the bucket. Synchronous; never throws. */
  enqueueDeletedKey(key: string): void {
    try {
      // Only `public/` is served by cloud.oxy.so; anything else was never cached.
      if (typeof key !== 'string' || !isPublicKey(key)) return;
      const path = stripPublicPrefix(key);
      if (path.length > 0) this.add('files', `${getAssetCdnUrl()}/${path}`);
    } catch (error) {
      logger.error('CDN purge enqueue failed', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Purge the by-id resolver's answers for `/<id>`, every variant. Synchronous; never throws. */
  enqueuePath(path: string): void {
    try {
      if (typeof path !== 'string' || !path.startsWith('/') || path.length < 2) return;
      this.add('tags', resolverCacheTag(path));
    } catch (error) {
      logger.error('CDN purge enqueue failed', {
        path,
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
    while (this.flushing) await this.flushing;
    while (this.size() > 0) {
      const before = this.size();
      const sent = await this.flushOnce();
      if (!sent || this.size() >= before) break;
    }
  }

  private size(): number {
    return this.pending.files.size + this.pending.tags.size;
  }

  private add(kind: PurgeKind, item: string): void {
    if (!this.sender) {
      if (!this.warnedUnconfigured) {
        this.warnedUnconfigured = true;
        logger.warn(
          'CDN purge disabled: CLOUDFLARE_ZONE_ID or CLOUDFLARE_CACHE_PURGE_TOKEN is unset, so deleted public objects stay cached at the cloud.oxy.so edge until they expire',
          { first: item },
        );
      }
      return;
    }
    this.pending[kind].add(item);
    this.enforceCap();
    this.schedule(this.flushDelayMs);
  }

  private enforceCap(): void {
    if (this.size() <= MAX_PENDING_PURGES) return;
    const dropped: string[] = [];
    for (const kind of ['files', 'tags'] as const) {
      for (const item of this.pending[kind]) {
        if (this.size() <= MAX_PENDING_PURGES) break;
        this.pending[kind].delete(item);
        this.failures.delete(item);
        dropped.push(item);
      }
    }
    logger.error(
      'CDN purge queue full: DROPPED the oldest entries; these deleted objects remain cached at the cloud.oxy.so edge',
      { cap: MAX_PENDING_PURGES, dropped },
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
    if (this.size() > 0) this.schedule(sent ? this.flushDelayMs : this.retryDelayMs());
  }

  private retryDelayMs(): number {
    return Math.min(
      this.flushDelayMs * 2 ** Math.max(this.consecutiveFailures, 1),
      MAX_RETRY_DELAY_MS,
    );
  }

  /** One purge request: URLs first (cheap, high rate), then tags. False when it failed. */
  private async flushOnce(): Promise<boolean> {
    if (!this.sender || this.size() === 0) return true;
    const kind: PurgeKind = this.pending.files.size > 0 ? 'files' : 'tags';
    const run = this.sendBatch(this.sender, kind);
    this.flushing = run.then(() => undefined);
    try {
      return await run;
    } finally {
      this.flushing = null;
    }
  }

  private async sendBatch(sender: PurgeSender, kind: PurgeKind): Promise<boolean> {
    const limit = kind === 'files' ? MAX_URLS_PER_REQUEST : MAX_TAGS_PER_REQUEST;
    const batch = [...this.pending[kind]].slice(0, limit);
    for (const item of batch) this.pending[kind].delete(item);
    try {
      await sender.purge(kind, batch);
      this.consecutiveFailures = 0;
      for (const item of batch) this.failures.delete(item);
      logger.info('CDN purge requested', { kind, count: batch.length });
      return true;
    } catch (error) {
      this.consecutiveFailures += 1;
      const throttled = error instanceof PurgeError && error.throttled;
      const dropped: string[] = [];
      for (const item of batch) {
        const failures = throttled
          ? (this.failures.get(item) ?? 0)
          : (this.failures.get(item) ?? 0) + 1;
        if (failures >= MAX_PURGE_ATTEMPTS) {
          this.failures.delete(item);
          dropped.push(item);
        } else {
          this.failures.set(item, failures);
          this.pending[kind].add(item);
        }
      }
      this.enforceCap();
      logger.error(
        'CDN purge FAILED; deleted objects are still served from the cloud.oxy.so edge — will retry',
        {
          kind,
          error: error instanceof Error ? error.message : String(error),
          throttled,
          consecutiveFailures: this.consecutiveFailures,
          count: batch.length,
          sample: batch.slice(0, 5),
        },
      );
      if (dropped.length > 0) {
        logger.error(
          'CDN purge DROPPED after repeated failures; these deleted objects remain cached at the cloud.oxy.so edge',
          { kind, attempts: MAX_PURGE_ATTEMPTS, dropped },
        );
      }
      return false;
    }
  }
}
