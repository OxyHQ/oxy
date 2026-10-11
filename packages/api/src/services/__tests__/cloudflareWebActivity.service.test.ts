jest.mock('../platformActivity.service', () => ({ publishPlatformActivity: jest.fn() }));

import { resolveOxyServiceEndpoint, type TrafficAggregate } from '@oxy.so/telemetry/collector';
import {
  CLOUDFLARE_WEB_HOSTS,
  type CloudflareWebHost,
} from '../../config/cloudflareWebActivityHosts';
import { logger } from '../../utils/logger';
import {
  CLOUDFLARE_WEB_ACTIVITY_CURSOR_KEY,
  MAX_CATCH_UP_MS,
  MAX_FLOWS_PER_WINDOW,
  WINDOW_MS,
  analyticsQuery,
  createZoneCache,
  runCloudflareWebActivityTick,
  settledWindowEnd,
  startCloudflareWebActivityPoller,
  toActivityFlows,
  validateHosts,
  type CloudflareWebActivityAggregate,
} from '../cloudflareWebActivity.service';

const ZONE_OXY = 'a'.repeat(32);
const ZONE_SYRA = 'b'.repeat(32);
const HOSTS: CloudflareWebHost[] = [
  { host: 'accounts.oxy.so', zone: 'oxy.so', service: 'accounts', activityType: 'identity' },
  { host: 'noted.oxy.so', zone: 'oxy.so', service: 'noted' },
  { host: 'syra.fm', zone: 'syra.fm', service: 'syra' },
  { host: 'studio.syra.fm', zone: 'syra.fm', service: 'syra' },
  { host: 'homiio.com', zone: 'homiio.com', service: 'homiio' },
];
const NOW = Date.parse('2026-10-11T12:00:30.000Z');
const END = settledWindowEnd(NOW);

/** The three Redis commands the poller uses, with real CAS semantics. */
function fakeRedis(initial?: string) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set(CLOUDFLARE_WEB_ACTIVITY_CURSOR_KEY, initial);
  return {
    store,
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, mode?: string) => {
      if (mode === 'NX' && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    eval: jest.fn(
      async (_script: string, _keys: number, key: string, expected: string, next: string) => {
        if (store.get(key) !== expected) return 0;
        store.set(key, next);
        return 1;
      },
    ),
  };
}

type Row = { host: string; colo?: string | null; count: number };

function fakeCloudflare(
  options: {
    rows?: Partial<Record<string, Row[]>>;
    graphqlErrors?: unknown[];
    invisibleZones?: string[];
    delayMs?: number;
  } = {},
) {
  const queries: string[] = [];
  const fetcher = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-token');
    if (url.pathname.endsWith('/zones')) {
      const name = url.searchParams.get('name') ?? '';
      const id = ({ 'oxy.so': ZONE_OXY, 'syra.fm': ZONE_SYRA } as Record<string, string>)[name];
      const visible = id && !options.invisibleZones?.includes(name);
      return Response.json({ success: true, result: visible ? [{ id, name }] : [] });
    }
    if (url.pathname.endsWith('/graphql')) {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      queries.push(query);
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.graphqlErrors)
        return Response.json({ data: null, errors: options.graphqlErrors });
      const zones = [ZONE_OXY, ZONE_SYRA]
        .filter((tag) => query.includes(tag))
        .map((zoneTag) => ({
          zoneTag,
          httpRequestsAdaptiveGroups: (options.rows?.[zoneTag] ?? []).map((row) => ({
            count: row.count,
            dimensions: { clientRequestHTTPHost: row.host, coloCode: row.colo },
          })),
        }));
      return Response.json({ data: { viewer: { zones } }, errors: null });
    }
    throw new Error(`unexpected ${url}`);
  });
  return { fetcher: fetcher as unknown as typeof fetch, queries, calls: fetcher };
}

function deps(
  redis: ReturnType<typeof fakeRedis>,
  cloudflare: ReturnType<typeof fakeCloudflare>,
  now = NOW,
) {
  const published: TrafficAggregate[][] = [];
  return {
    published,
    deps: {
      token: 'test-token',
      redis,
      fetcher: cloudflare.fetcher,
      now: () => now,
      hosts: HOSTS,
      zoneCache: createZoneCache(),
      publish: (events: TrafficAggregate[]) => published.push(events),
    },
  };
}

beforeEach(() => {
  jest.spyOn(logger, 'info').mockImplementation(() => logger);
  jest.spyOn(logger, 'warn').mockImplementation(() => logger);
});
afterEach(() => jest.restoreAllMocks());

describe('Cloudflare web activity poller', () => {
  it('is disabled with exactly one log line when the token is absent', () => {
    expect(startCloudflareWebActivityPoller({}, fakeRedis())).toBeUndefined();
    expect(
      startCloudflareWebActivityPoller({ CLOUDFLARE_ANALYTICS_API_TOKEN: '  ' }, fakeRedis()),
    ).toBeUndefined();
    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenLastCalledWith(
      'Cloudflare web activity is disabled: CLOUDFLARE_ANALYTICS_API_TOKEN is not set',
    );
  });

  it('refuses to run without the fleet-wide Redis cursor', () => {
    expect(
      startCloudflareWebActivityPoller({ CLOUDFLARE_ANALYTICS_API_TOKEN: 't' }, null),
    ).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('starts the first ever run at the settled edge and backfills nothing', async () => {
    const redis = fakeRedis();
    const cloudflare = fakeCloudflare();
    const { deps: d, published } = deps(redis, cloudflare);
    await expect(runCloudflareWebActivityTick(d)).resolves.toEqual({
      status: 'initialized',
      cursor: END,
    });
    expect(redis.store.get(CLOUDFLARE_WEB_ACTIVITY_CURSOR_KEY)).toBe(String(END));
    expect(cloudflare.calls).not.toHaveBeenCalled();
    expect(published).toEqual([]);
  });

  it('publishes one settled window as external inbound flows at the serving PoP', async () => {
    const redis = fakeRedis(String(END - WINDOW_MS));
    const cloudflare = fakeCloudflare({
      rows: {
        [ZONE_OXY]: [
          { host: 'accounts.oxy.so', colo: 'MAD', count: 40 },
          { host: 'noted.oxy.so', colo: 'MAD', count: 7 },
          { host: 'noted.oxy.so', colo: null, count: 2 },
          // Not in the reviewed map: never attributed to anything.
          { host: 'evil.oxy.so', colo: 'MAD', count: 999 },
        ],
        [ZONE_SYRA]: [
          { host: 'syra.fm', colo: 'FRA', count: 10 },
          { host: 'studio.syra.fm', colo: 'FRA', count: 5 },
        ],
      },
    });
    const { deps: d, published } = deps(redis, cloudflare);

    const result = await runCloudflareWebActivityTick(d);

    expect(result).toEqual({
      status: 'published',
      windowStart: END - WINDOW_MS,
      windowEnd: END,
      flows: 4,
      requests: 64,
    });
    expect(redis.store.get(CLOUDFLARE_WEB_ACTIVITY_CURSOR_KEY)).toBe(String(END));
    const events = published.flat() as CloudflareWebActivityAggregate[];
    const window = {
      windowStartedAt: new Date(END - WINDOW_MS).toISOString(),
      windowEndedAt: new Date(END).toISOString(),
      emittedAt: new Date(NOW).toISOString(),
    };
    expect(events).toEqual([
      {
        service: 'accounts',
        region: 'edge-mad',
        targetRegion: 'edge-mad',
        targetService: 'accounts',
        scope: 'external',
        direction: 'inbound',
        activityType: 'identity',
        requests: 40,
        ...window,
      },
      {
        service: 'syra',
        region: 'edge-fra',
        targetRegion: 'edge-fra',
        targetService: 'syra',
        scope: 'external',
        direction: 'inbound',
        activityType: 'platform',
        requests: 15,
        ...window,
      },
      {
        service: 'noted',
        region: 'edge-mad',
        targetRegion: 'edge-mad',
        targetService: 'noted',
        scope: 'external',
        direction: 'inbound',
        activityType: 'platform',
        requests: 7,
        ...window,
      },
      {
        service: 'noted',
        region: 'unknown',
        targetRegion: 'unknown',
        targetService: 'noted',
        scope: 'external',
        direction: 'inbound',
        activityType: 'platform',
        requests: 2,
        ...window,
      },
    ]);
    // No invented visitor location, no response the count cannot show.
    expect(
      events.every(
        (event) => event.sourceRegion === undefined && event.sourceService === undefined,
      ),
    ).toBe(true);

    // One query; only visible zones; exact hosts; visitor requests only; the
    // exact half-open window.
    expect(cloudflare.queries).toHaveLength(1);
    const [query] = cloudflare.queries;
    expect(query).toContain(`zoneTag_in: ["${ZONE_OXY}","${ZONE_SYRA}"]`);
    expect(query).toContain('requestSource: "eyeball"');
    expect(query).toContain(`datetime_geq: "${new Date(END - WINDOW_MS).toISOString()}"`);
    expect(query).toContain(`datetime_lt: "${new Date(END).toISOString()}"`);
    expect(query).toContain(
      'clientRequestHTTPHost_in: ["accounts.oxy.so","noted.oxy.so","syra.fm","studio.syra.fm"]',
    );
    // homiio.com's zone is not visible to the token: logged, not guessed.
    expect(query).not.toContain('homiio.com');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('zones not visible'), {
      zones: ['homiio.com'],
    });

    // The same window is never published twice.
    await expect(runCloudflareWebActivityTick(d)).resolves.toEqual({ status: 'idle' });
    expect(published).toHaveLength(1);
  });

  it('lets exactly one of several concurrent tasks publish a window', async () => {
    const redis = fakeRedis(String(END - WINDOW_MS));
    const cloudflare = fakeCloudflare({
      rows: { [ZONE_OXY]: [{ host: 'noted.oxy.so', colo: 'LHR', count: 3 }] },
      delayMs: 5,
    });
    const tasks = [deps(redis, cloudflare), deps(redis, cloudflare), deps(redis, cloudflare)];
    const results = await Promise.all(tasks.map(({ deps: d }) => runCloudflareWebActivityTick(d)));
    expect(results.filter((result) => result.status === 'published')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'not-claimed')).toHaveLength(2);
    expect(tasks.flatMap(({ published }) => published.flat())).toHaveLength(1);
    expect(cloudflare.queries).toHaveLength(1);
  });

  it('hands a failed window back so the next tick retries it, publishing nothing', async () => {
    const redis = fakeRedis(String(END - 2 * WINDOW_MS));
    const failing = fakeCloudflare({
      graphqlErrors: [{ message: 'not authorized for that zone' }],
    });
    const first = deps(redis, failing);
    await expect(runCloudflareWebActivityTick(first.deps)).rejects.toThrow(
      'Cloudflare analytics query failed',
    );
    expect(first.published).toEqual([]);
    expect(redis.store.get(CLOUDFLARE_WEB_ACTIVITY_CURSOR_KEY)).toBe(String(END - 2 * WINDOW_MS));

    const healthy = fakeCloudflare({
      rows: { [ZONE_OXY]: [{ host: 'noted.oxy.so', colo: 'AMS', count: 9 }] },
    });
    const second = deps(redis, healthy);
    await expect(runCloudflareWebActivityTick(second.deps)).resolves.toMatchObject({
      status: 'published',
      windowStart: END - 2 * WINDOW_MS,
      windowEnd: END,
      requests: 9,
    });
  });

  it('refuses a truncated Cloudflare answer rather than under-reporting it silently', async () => {
    const redis = fakeRedis(String(END - WINDOW_MS));
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      host: 'noted.oxy.so',
      colo: 'MAD',
      count: index + 1,
    }));
    const { deps: d, published } = deps(redis, fakeCloudflare({ rows: { [ZONE_OXY]: rows } }));
    await expect(runCloudflareWebActivityTick(d)).rejects.toThrow('row limit');
    expect(published).toEqual([]);
    expect(redis.store.get(CLOUDFLARE_WEB_ACTIVITY_CURSOR_KEY)).toBe(String(END - WINDOW_MS));
  });

  it('covers a short outage in one aggregate and bounds a long one, logging the skipped range', async () => {
    const short = fakeRedis(String(END - 5 * WINDOW_MS));
    const a = deps(short, fakeCloudflare());
    await expect(runCloudflareWebActivityTick(a.deps)).resolves.toMatchObject({
      windowStart: END - 5 * WINDOW_MS,
      windowEnd: END,
    });

    const long = fakeRedis(String(END - 3 * MAX_CATCH_UP_MS));
    const b = deps(long, fakeCloudflare());
    await expect(runCloudflareWebActivityTick(b.deps)).resolves.toMatchObject({
      windowStart: END - MAX_CATCH_UP_MS,
      windowEnd: END,
      skippedFrom: END - 3 * MAX_CATCH_UP_MS,
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('skipped windows'), {
      from: new Date(END - 3 * MAX_CATCH_UP_MS).toISOString(),
      to: new Date(END - MAX_CATCH_UP_MS).toISOString(),
    });
  });

  it('re-anchors an unreadable cursor instead of guessing a window', async () => {
    const redis = fakeRedis('not-a-time');
    const { deps: d, published } = deps(redis, fakeCloudflare());
    await expect(runCloudflareWebActivityTick(d)).resolves.toEqual({
      status: 'initialized',
      cursor: END,
    });
    expect(redis.store.get(CLOUDFLARE_WEB_ACTIVITY_CURSOR_KEY)).toBe(String(END));
    expect(published).toEqual([]);
  });

  it('only reads windows old enough for Cloudflare to have settled', () => {
    expect(settledWindowEnd(Date.parse('2026-10-11T12:03:59.999Z'))).toBe(
      Date.parse('2026-10-11T12:00:00.000Z'),
    );
    expect(settledWindowEnd(Date.parse('2026-10-11T12:04:00.000Z'))).toBe(
      Date.parse('2026-10-11T12:01:00.000Z'),
    );
  });
});

describe('flow bounding', () => {
  it('itemises the busiest flows and folds the tail per service without losing a request', () => {
    const counts = Array.from({ length: 400 }, (_, index) => ({
      host: index % 2 ? 'noted.oxy.so' : 'syra.fm',
      colo: `${String.fromCharCode(97 + (Math.floor(index / 26) % 26))}${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 52))}`,
      requests: index + 1,
    }));
    const flows = toActivityFlows(counts, HOSTS, {
      start: 0,
      end: WINDOW_MS,
      emittedAt: WINDOW_MS,
    });
    expect(flows.length).toBeLessThanOrEqual(MAX_FLOWS_PER_WINDOW);
    expect(flows.reduce((sum, flow) => sum + flow.requests, 0)).toBe(
      counts.reduce((sum, count) => sum + count.requests, 0),
    );
    expect(
      flows
        .filter((flow) => flow.region === 'unknown')
        .map((flow) => flow.service)
        .sort(),
    ).toEqual(['noted', 'syra']);
  });
});

describe('reviewed host map', () => {
  it('is well formed, unique and zone-consistent', () => {
    expect(() => validateHosts(CLOUDFLARE_WEB_HOSTS)).not.toThrow();
    expect(() => validateHosts([...HOSTS, HOSTS[0]])).toThrow('Duplicate');
    expect(() =>
      validateHosts([{ host: 'noted.oxy.so', zone: 'syra.fm', service: 'noted' }]),
    ).toThrow('not inside zone');
    expect(() =>
      validateHosts([{ host: 'Noted.oxy.so', zone: 'oxy.so', service: 'noted' }]),
    ).toThrow('Invalid');
  });

  it('needs exactly the zones docs/operations/cloudflare-web-activity.md tells operators to grant', () => {
    expect([...new Set(CLOUDFLARE_WEB_HOSTS.map(({ zone }) => zone))].sort()).toEqual(
      [
        'alia.onl',
        'allo.you',
        'clarity.surf',
        'fairco.in',
        'homiio.com',
        'mercaria.co',
        'moovo.now',
        'nilo.so',
        'oxy.so',
        'peable.to',
        'syra.fm',
        'tnp.network',
      ].sort(),
    );
  });

  it('never lists an Oxy API host, whose backend already reports its own traffic', () => {
    for (const { host } of CLOUDFLARE_WEB_HOSTS) {
      expect(resolveOxyServiceEndpoint(new URL(`https://${host}/`))).toBeUndefined();
      expect(host.startsWith('api.')).toBe(false);
    }
    // Mention's web app is served through its own backend, which reports it.
    expect(CLOUDFLARE_WEB_HOSTS.some(({ host }) => host.endsWith('mention.earth'))).toBe(false);
  });

  it('only interpolates validated literals into the GraphQL query', () => {
    expect(() => analyticsQuery(['"} evil {'], ['noted.oxy.so'], 0, WINDOW_MS)).toThrow(
      'Invalid zone tag',
    );
    expect(() => analyticsQuery([ZONE_OXY], ['noted.oxy.so"]) { x'], 0, WINDOW_MS)).toThrow(
      'Invalid host',
    );
  });
});
