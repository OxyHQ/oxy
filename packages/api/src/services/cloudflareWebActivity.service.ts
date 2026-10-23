/**
 * Keyless web-app activity: oxy-api reads each Cloudflare-hosted Oxy web app's
 * request counts from Cloudflare's own analytics and publishes them into the
 * ecosystem activity collector behind oxy.so/dashboard.
 *
 * ## Why this exists instead of code in every web app
 *
 * The retired alternative gave every Worker/Pages project its own Oxy key pair
 * (`OXY_EDGE_ACTIVITY_API_KEY/SECRET`) to publish from the edge. That is a
 * secret per app for a read-only, aggregate signal Cloudflare already has. Here
 * ONE read-only Cloudflare analytics token, held by oxy-api as an ECS secret,
 * replaces all of them; the web apps carry no secret and no activity code, and
 * oxy-api itself authenticates nowhere new (no Oxy key pair, ADR 0026).
 *
 * ## What is published, and how honestly the dashboard can show it
 *
 * Per closed one-minute window, Cloudflare's `httpRequestsAdaptiveGroups` count
 * of visitor (`requestSource: "eyeball"`) requests, grouped by the EXACT HTTP
 * host and the serving Cloudflare PoP. Each (host's service, PoP) becomes one
 * `external`/`inbound` flow whose region is `edge-<pop>` — the same shape the
 * retired edge observer would have produced: the PoP is infrastructure
 * metadata, never the visitor's location, and no arc to a visitor is invented.
 *
 *  - The count is Cloudflare's sample-adjusted ESTIMATE for adaptive datasets.
 *  - `windowStartedAt` is the true start of the counted window and
 *    `windowEndedAt` (additive, ignored by older readers) its true end;
 *    `emittedAt` is when Oxy published it. The window closes
 *    {@link SETTLE_DELAY_MS} before it is read, because Cloudflare's analytics
 *    land with a delay: this signal is minutes old, never "live", and a request
 *    Cloudflare logs later than that is not counted (an undercount, never a
 *    double count).
 *  - Only inbound flows: a Cloudflare request count says nothing about an
 *    upstream response, so no outbound "return" is reported.
 *
 * ## Exactly once per window across N oxy-api tasks (at most once on a crash)
 *
 * Every task runs the timer. A fleet-wide cursor in Redis holds the end of the
 * last claimed window. A task CLAIMS `[cursor, end)` by compare-and-set of the
 * cursor from the value it read to `end`; only the winner queries Cloudflare and
 * publishes, so a window is never published twice, across tasks or restarts.
 * When the query fails the winner sets the cursor BACK (again by CAS), so the
 * next tick retries the same window and nothing is lost. A task that dies
 * between its claim and its publish loses that one window — at most once, by
 * design: the stream is a live pulse with no store to reconcile against, and a
 * duplicate would overstate traffic while a gap only under-reports it.
 *
 * After downtime the next claim covers the whole gap in one aggregate (honest
 * window bounds), capped at {@link MAX_CATCH_UP_MS}; anything older is skipped
 * and logged with its exact range. The first run ever initialises the cursor to
 * "now" and backfills nothing. Without Redis there is no fleet-wide cursor, so
 * the poller refuses to run rather than risk N-fold counting.
 *
 * Disabled — one log line, nothing else — when `CLOUDFLARE_ANALYTICS_API_TOKEN`
 * is unset. Token permissions and the infra wiring are in
 * `docs/operations/cloudflare-web-activity.md`.
 */

import { z } from '@oxy.so/zod3';
import type { TrafficAggregate } from '@oxy.so/telemetry/collector';
import { normalizeEdgePop } from '@oxy.so/telemetry/server';
import { getRedisClient } from '../config/redis';
import { CLOUDFLARE_WEB_HOSTS, type CloudflareWebHost } from '../config/cloudflareWebActivityHosts';
import { publishPlatformActivity } from './platformActivity.service';
import { logger } from '../utils/logger';
import { tracedFetch } from '../utils/tracedFetch';

export const CLOUDFLARE_WEB_ACTIVITY_TOKEN_ENV = 'CLOUDFLARE_ANALYTICS_API_TOKEN';
/** Optional, not secret: narrows the zone lookup to Oxy's account. */
export const CLOUDFLARE_ACCOUNT_ID_ENV = 'CLOUDFLARE_ACCOUNT_ID';
export const CLOUDFLARE_WEB_ACTIVITY_CURSOR_KEY = 'platform-activity:cloudflare-web:cursor';

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
export const WINDOW_MS = 60_000;
export const SETTLE_DELAY_MS = 3 * 60_000;
export const MAX_CATCH_UP_MS = 30 * 60_000;
export const POLL_INTERVAL_MS = 30_000;
const ZONE_CACHE_MS = 60 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** Cloudflare caps a `zoneTag_in` list; stay well under it. */
const ZONES_PER_QUERY = 10;
/** Rows per zone per query: hosts x PoPs in one window. */
const ROW_LIMIT = 10_000;
/** Bound on published flows per window; the long tail is folded, not dropped. */
export const MAX_FLOWS_PER_WINDOW = 200;

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ZONE_TAG = /^[0-9a-f]{32}$/;
const SERVICE = /^[a-z][a-z0-9-]{0,39}$/;

/** Compare-and-set: only the task that read `expected` may move the cursor. */
const CAS_SCRIPT =
  'if redis.call("GET", KEYS[1]) == ARGV[1] then redis.call("SET", KEYS[1], ARGV[2]) return 1 end return 0';

/** The three Redis commands the cursor needs; the shared ioredis client fits. */
export interface CursorStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'NX'): Promise<'OK' | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

export interface CloudflareWebActivityDeps {
  readonly token: string;
  readonly accountId?: string;
  readonly redis: CursorStore;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly publish?: (events: TrafficAggregate[]) => void;
  readonly hosts?: readonly CloudflareWebHost[];
  readonly zoneCache?: ZoneCache;
}

export type CloudflareWebActivityTick =
  | { readonly status: 'initialized'; readonly cursor: number }
  | { readonly status: 'idle' }
  | { readonly status: 'not-claimed' }
  | {
      readonly status: 'published';
      readonly windowStart: number;
      readonly windowEnd: number;
      readonly flows: number;
      readonly requests: number;
      readonly skippedFrom?: number;
    };

export interface ZoneCache {
  tags: Map<string, string>;
  resolvedAt: number;
}

export function createZoneCache(): ZoneCache {
  return { tags: new Map(), resolvedAt: 0 };
}

/** The newest window end that is old enough for Cloudflare to have settled. */
export function settledWindowEnd(now: number): number {
  return Math.floor((now - SETTLE_DELAY_MS) / WINDOW_MS) * WINDOW_MS;
}

/** Validates the reviewed map once; a malformed entry is a code bug, not data. */
export function validateHosts(hosts: readonly CloudflareWebHost[]): void {
  const seen = new Set<string>();
  for (const entry of hosts) {
    if (!HOST.test(entry.host) || !HOST.test(entry.zone) || !SERVICE.test(entry.service))
      throw new Error(`Invalid Cloudflare web host entry: ${entry.host}`);
    if (entry.host !== entry.zone && !entry.host.endsWith(`.${entry.zone}`))
      throw new Error(`Cloudflare web host ${entry.host} is not inside zone ${entry.zone}`);
    if (seen.has(entry.host)) throw new Error(`Duplicate Cloudflare web host ${entry.host}`);
    seen.add(entry.host);
  }
}

async function cloudflareJson(
  fetcher: typeof fetch,
  token: string,
  url: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetcher(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // Never log a Cloudflare body: only the status leaves this function.
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Cloudflare API responded ${response.status}`);
  }
  return response.json();
}

const zoneListSchema = z.object({
  success: z.literal(true),
  result: z.array(z.object({ id: z.string().regex(ZONE_TAG), name: z.string() })),
});

/**
 * Zone name -> zone id, read with the same token (`Zone:Read`). Cached for an
 * hour; a zone the token cannot see is reported once per refresh and skipped.
 */
async function resolveZoneTags(
  deps: Required<
    Pick<CloudflareWebActivityDeps, 'token' | 'fetcher' | 'now' | 'hosts' | 'zoneCache'>
  > &
    Pick<CloudflareWebActivityDeps, 'accountId'>,
): Promise<Map<string, string>> {
  const { zoneCache } = deps;
  if (zoneCache.resolvedAt && deps.now() - zoneCache.resolvedAt < ZONE_CACHE_MS)
    return zoneCache.tags;
  const zones = [...new Set(deps.hosts.map((entry) => entry.zone))].sort();
  const tags = new Map<string, string>();
  const missing: string[] = [];
  for (const zone of zones) {
    const query = new URLSearchParams({ name: zone, status: 'active', per_page: '5' });
    if (deps.accountId) query.set('account.id', deps.accountId);
    const parsed = zoneListSchema.safeParse(
      await cloudflareJson(deps.fetcher, deps.token, `${CLOUDFLARE_API}/zones?${query}`),
    );
    if (!parsed.success) throw new Error('Unexpected Cloudflare zone listing');
    const match = parsed.data.result.find((candidate) => candidate.name === zone);
    if (match) tags.set(zone, match.id);
    else missing.push(zone);
  }
  if (missing.length > 0)
    logger.warn(
      'Cloudflare web activity: zones not visible to the analytics token are not measured',
      {
        zones: missing,
      },
    );
  zoneCache.tags = tags;
  zoneCache.resolvedAt = deps.now();
  return tags;
}

const analyticsSchema = z.object({
  data: z
    .object({
      viewer: z.object({
        zones: z.array(
          z.object({
            zoneTag: z.string(),
            httpRequestsAdaptiveGroups: z.array(
              z.object({
                count: z.number().int().nonnegative(),
                dimensions: z.object({
                  clientRequestHTTPHost: z.string(),
                  coloCode: z.string().nullable().optional(),
                }),
              }),
            ),
          }),
        ),
      }),
    })
    .nullable()
    .optional(),
  errors: z.array(z.unknown()).nullable().optional(),
});

export interface HostCount {
  readonly host: string;
  readonly colo: string | undefined;
  readonly requests: number;
}

/**
 * One GraphQL request per batch of zones. Every literal interpolated into the
 * query is a validated zone id, a reviewed hostname or an ISO timestamp — none
 * is caller-controlled — and is JSON-quoted.
 */
export function analyticsQuery(
  zoneTags: readonly string[],
  hosts: readonly string[],
  start: number,
  end: number,
): string {
  for (const tag of zoneTags) if (!ZONE_TAG.test(tag)) throw new Error('Invalid zone tag');
  for (const host of hosts) if (!HOST.test(host)) throw new Error('Invalid host');
  const list = (values: readonly string[]) =>
    `[${values.map((value) => JSON.stringify(value)).join(',')}]`;
  return (
    `{ viewer { zones(filter: { zoneTag_in: ${list(zoneTags)} }) { zoneTag ` +
    `httpRequestsAdaptiveGroups(limit: ${ROW_LIMIT}, filter: { ` +
    `datetime_geq: ${JSON.stringify(new Date(start).toISOString())}, ` +
    `datetime_lt: ${JSON.stringify(new Date(end).toISOString())}, ` +
    `requestSource: "eyeball", clientRequestHTTPHost_in: ${list(hosts)} }) ` +
    `{ count dimensions { clientRequestHTTPHost coloCode } } } } }`
  );
}

export async function fetchHostCounts(
  deps: { token: string; fetcher: typeof fetch },
  zoneTags: readonly string[],
  hosts: readonly string[],
  start: number,
  end: number,
): Promise<HostCount[]> {
  const counts: HostCount[] = [];
  for (let offset = 0; offset < zoneTags.length; offset += ZONES_PER_QUERY) {
    const batch = zoneTags.slice(offset, offset + ZONES_PER_QUERY);
    const parsed = analyticsSchema.safeParse(
      await cloudflareJson(deps.fetcher, deps.token, `${CLOUDFLARE_API}/graphql`, {
        method: 'POST',
        body: JSON.stringify({ query: analyticsQuery(batch, hosts, start, end) }),
      }),
    );
    // A partial answer cannot be told apart from low traffic, so any GraphQL
    // error fails the whole window (which is then retried, not published).
    if (!parsed.success || !parsed.data.data || (parsed.data.errors?.length ?? 0) > 0)
      throw new Error('Cloudflare analytics query failed');
    for (const zone of parsed.data.data.viewer.zones) {
      if (zone.httpRequestsAdaptiveGroups.length >= ROW_LIMIT)
        throw new Error('Cloudflare analytics result reached its row limit');
      for (const row of zone.httpRequestsAdaptiveGroups)
        counts.push({
          host: row.dimensions.clientRequestHTTPHost.toLowerCase(),
          colo: row.dimensions.coloCode ?? undefined,
          requests: row.count,
        });
    }
  }
  return counts;
}

export type CloudflareWebActivityAggregate = TrafficAggregate & { windowEndedAt: string };

/**
 * Exact-host attribution into bounded, external, inbound flows at the serving
 * PoP. Hosts outside the reviewed map are ignored. At most
 * {@link MAX_FLOWS_PER_WINDOW} flows: the busiest are itemised and the tail is
 * folded per service into region `unknown`, so totals stay exact.
 */
export function toActivityFlows(
  counts: readonly HostCount[],
  hosts: readonly CloudflareWebHost[],
  window: { start: number; end: number; emittedAt: number },
): CloudflareWebActivityAggregate[] {
  const byHost = new Map(hosts.map((entry) => [entry.host, entry]));
  const flows = new Map<
    string,
    {
      service: string;
      region: string;
      activityType: CloudflareWebActivityAggregate['activityType'];
      requests: number;
    }
  >();
  for (const count of counts) {
    const entry = byHost.get(count.host);
    if (!entry || count.requests <= 0) continue;
    const pop = normalizeEdgePop(count.colo);
    const region = pop ? `edge-${pop}` : 'unknown';
    const activityType = entry.activityType ?? 'platform';
    const key = `${entry.service}|${region}|${activityType}`;
    const flow = flows.get(key);
    if (flow) flow.requests += count.requests;
    else flows.set(key, { service: entry.service, region, activityType, requests: count.requests });
  }
  const ordered = [...flows.values()].sort(
    (a, b) =>
      b.requests - a.requests ||
      a.service.localeCompare(b.service) ||
      a.region.localeCompare(b.region),
  );
  let kept = ordered;
  if (ordered.length > MAX_FLOWS_PER_WINDOW) {
    // Reserve one folded slot per (service, activityType) so the total, folded
    // flows included, never exceeds the bound. The map has a few dozen hosts,
    // far below the bound, so every group always has its slot.
    const groupKey = (flow: (typeof ordered)[number]) => `${flow.service}|${flow.activityType}`;
    const reserved = new Set(ordered.map(groupKey)).size;
    kept = ordered.slice(0, Math.max(0, MAX_FLOWS_PER_WINDOW - reserved));
    const folded = new Map<string, (typeof ordered)[number]>();
    for (const flow of ordered.slice(kept.length)) {
      const existing = folded.get(groupKey(flow));
      if (existing) existing.requests += flow.requests;
      else folded.set(groupKey(flow), { ...flow, region: 'unknown' });
    }
    for (const flow of folded.values()) {
      const same = kept.find(
        (candidate) => candidate.region === 'unknown' && groupKey(candidate) === groupKey(flow),
      );
      if (same) same.requests += flow.requests;
      else kept.push(flow);
    }
  }
  const windowStartedAt = new Date(window.start).toISOString();
  const windowEndedAt = new Date(window.end).toISOString();
  const emittedAt = new Date(window.emittedAt).toISOString();
  return kept.map((flow) => ({
    service: flow.service,
    region: flow.region,
    scope: 'external',
    direction: 'inbound',
    activityType: flow.activityType,
    // The visitor's location is unknown; only the serving PoP is a fact.
    targetRegion: flow.region,
    targetService: flow.service,
    requests: flow.requests,
    windowStartedAt,
    windowEndedAt,
    emittedAt,
  }));
}

async function compareAndSet(redis: CursorStore, expected: string, next: string): Promise<boolean> {
  return (
    (await redis.eval(CAS_SCRIPT, 1, CLOUDFLARE_WEB_ACTIVITY_CURSOR_KEY, expected, next)) === 1
  );
}

/** One poll: claim the next settled window fleet-wide, read it, publish it. */
export async function runCloudflareWebActivityTick(
  deps: CloudflareWebActivityDeps,
): Promise<CloudflareWebActivityTick> {
  const now = deps.now ?? Date.now;
  const fetcher = deps.fetcher ?? tracedFetch;
  const hosts = deps.hosts ?? CLOUDFLARE_WEB_HOSTS;
  const publish = deps.publish ?? publishPlatformActivity;
  const end = settledWindowEnd(now());

  const stored = await deps.redis.get(CLOUDFLARE_WEB_ACTIVITY_CURSOR_KEY);
  const cursor = stored === null ? Number.NaN : Number(stored);
  if (stored === null || !Number.isSafeInteger(cursor) || cursor % WINDOW_MS !== 0) {
    // First run (or an unreadable cursor): start at "now", never backfill.
    if (stored === null)
      await deps.redis.set(CLOUDFLARE_WEB_ACTIVITY_CURSOR_KEY, String(end), 'NX');
    else await compareAndSet(deps.redis, stored, String(end));
    return { status: 'initialized', cursor: end };
  }
  if (cursor >= end) return { status: 'idle' };

  // Resolve zones BEFORE claiming, so a lookup failure never burns a window.
  const zoneTags = await resolveZoneTags({
    token: deps.token,
    accountId: deps.accountId,
    fetcher,
    now,
    hosts,
    zoneCache: deps.zoneCache ?? createZoneCache(),
  });

  if (!(await compareAndSet(deps.redis, stored, String(end)))) return { status: 'not-claimed' };
  const start = Math.max(cursor, end - MAX_CATCH_UP_MS);
  if (start > cursor)
    logger.warn('Cloudflare web activity: skipped windows older than the catch-up bound', {
      from: new Date(cursor).toISOString(),
      to: new Date(start).toISOString(),
    });

  const measured = hosts.filter((entry) => zoneTags.has(entry.zone));
  let counts: HostCount[] = [];
  try {
    if (measured.length > 0)
      counts = await fetchHostCounts(
        { token: deps.token, fetcher },
        [...new Set(measured.flatMap((entry) => zoneTags.get(entry.zone) ?? []))],
        measured.map((entry) => entry.host),
        start,
        end,
      );
  } catch (error) {
    // Hand the window back so the next tick retries it. If another task moved
    // the cursor meanwhile (it cannot, while we hold `end`), nothing is undone.
    await compareAndSet(deps.redis, String(end), stored).catch(() => false);
    throw error;
  }

  const flows = toActivityFlows(counts, measured, { start, end, emittedAt: now() });
  if (flows.length > 0) publish(flows);
  return {
    status: 'published',
    windowStart: start,
    windowEnd: end,
    flows: flows.length,
    requests: flows.reduce((sum, flow) => sum + flow.requests, 0),
    ...(start > cursor ? { skippedFrom: cursor } : {}),
  };
}

/**
 * Registered on every oxy-api task; the Redis cursor makes all but one tick per
 * window a no-op. Returns `undefined` (after exactly one log line) when it is
 * not configured.
 */
export function startCloudflareWebActivityPoller(
  env: NodeJS.ProcessEnv = process.env,
  redis: CursorStore | null = getRedisClient(),
): { stop(): void } | undefined {
  const token = env[CLOUDFLARE_WEB_ACTIVITY_TOKEN_ENV]?.trim();
  if (!token) {
    logger.info(
      `Cloudflare web activity is disabled: ${CLOUDFLARE_WEB_ACTIVITY_TOKEN_ENV} is not set`,
    );
    return undefined;
  }
  if (!redis) {
    logger.warn(
      'Cloudflare web activity is disabled: REDIS_URL is not set, and without the fleet-wide cursor each task would count every window again',
    );
    return undefined;
  }
  validateHosts(CLOUDFLARE_WEB_HOSTS);
  const deps: CloudflareWebActivityDeps = {
    token,
    accountId: env[CLOUDFLARE_ACCOUNT_ID_ENV]?.trim() || undefined,
    redis,
    zoneCache: createZoneCache(),
  };
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    runCloudflareWebActivityTick(deps)
      .catch((error: unknown) =>
        logger.error(
          'Cloudflare web activity poll failed',
          error instanceof Error ? error : new Error(String(error)),
        ),
      )
      .finally(() => {
        running = false;
      });
  };
  const interval = setInterval(tick, POLL_INTERVAL_MS);
  interval.unref();
  logger.info('Cloudflare web activity enabled', { hosts: CLOUDFLARE_WEB_HOSTS.length });
  return {
    stop(): void {
      clearInterval(interval);
    },
  };
}
