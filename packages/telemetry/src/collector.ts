import { metadataFromHeaders, type TelemetryHeaders } from './server.js';

export type TrafficScope = 'internal' | 'external';
export type TrafficDirection = 'inbound' | 'outbound';
export type TrafficType = 'identity' | 'ai' | 'communication' | 'media' | 'platform';
export interface TrafficFlow {
  region: string;
  sourceRegion?: string;
  targetRegion?: string;
  sourceService?: string;
  targetService?: string;
  service: string;
  scope: TrafficScope;
  direction: TrafficDirection;
  activityType: TrafficType;
}
export interface TrafficAggregate extends TrafficFlow {
  requests: number;
  windowStartedAt: string;
  emittedAt: string;
}

const TYPES: Record<string, TrafficType> = {
  auth: 'identity', session: 'identity', users: 'identity', profiles: 'identity', accounts: 'identity',
  ai: 'ai', inference: 'ai', models: 'ai', chat: 'ai', completions: 'ai',
  stream: 'media', tracks: 'media', episodes: 'media', recordings: 'media', rooms: 'media',
  messages: 'communication', notifications: 'communication', mail: 'communication',
  media: 'media', files: 'media', assets: 'media', upload: 'media', uploads: 'media', cdn: 'media', storage: 'media', images: 'media', audio: 'media', videos: 'media',
};
export function trafficType(path: string): TrafficType {
  const parts = path.split('?')[0].split('/').filter(Boolean);
  if (parts[0] === 'alia') parts.shift();
  if (parts[0] === 'api') parts.shift();
  if (/^v\d+$/.test(parts[0] ?? '')) parts.shift();
  return TYPES[parts[0] ?? ''] ?? 'platform';
}

export function createTrafficCollector(publish: (events: TrafficAggregate[]) => Promise<unknown>, now = Date.now) {
  const pending = new Map<string, { flow: TrafficFlow; requests: number; startedAt: number }>();
  let flushing: Promise<void> | null = null;
  return {
    record(flow: TrafficFlow) {
      const key = JSON.stringify(flow);
      const existing = pending.get(key);
      if (existing) existing.requests++;
      else if (pending.size < 512) pending.set(key, { flow, requests: 1, startedAt: now() });
    },
    async flush() {
      while (flushing) await flushing;
      if (pending.size === 0) return;
      const emittedAt = new Date(now()).toISOString();
      const events = [...pending.values()].map(({ flow, requests, startedAt }) => ({ ...flow, requests, windowStartedAt: new Date(startedAt).toISOString(), emittedAt }));
      pending.clear();
      flushing = (async () => {
        for (let offset = 0; offset < events.length; offset += 256) await publish(events.slice(offset, offset + 256));
      })();
      try { await flushing; } finally { flushing = null; }
    },
  };
}

interface HttpRequest {
  headers: TelemetryHeaders;
  path?: string;
  url?: string;
  serviceApp?: { appName?: string };
}
interface HttpResponse { once(event: string, listener: () => void): unknown; setHeader?(name: string, value: string): unknown }

export function trafficMiddleware(
  collector: Pick<ReturnType<typeof createTrafficCollector>, 'record'>,
  service: string,
  region: string,
) {
  return (request: HttpRequest, response: HttpResponse, next: () => void): void => {
    response.setHeader?.('X-Oxy-Region', region);
    const path = request.path ?? request.url ?? '/';
    // Never report collection itself, probes or the dashboard transport.
    if (/^\/(?:api\/)?(?:health|ready|live|platform-stats|platform-activity|platform-infrastructure|infra-status)(?:\/|$)/.test(path) || path.startsWith('/internal/activity') || path.startsWith('/auth/service-token') || path.startsWith('/cdn-cgi/')) { next(); return; }
    const { edgePop } = metadataFromHeaders(request.headers);
    const activityType = trafficType(path);
    let finished = false;
    const inboundFlow = (): TrafficFlow => {
      // Read service identity AFTER the route's shared auth middleware resolved it.
      const name = request.serviceApp?.appName?.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40);
      const internal = Boolean(name);
      const forwardedRegion = request.headers['x-oxy-source-region'];
      const peerRegion = internal ? normalizeInfrastructureRegion(forwardedRegion) : edgePop ? `edge-${edgePop}` : undefined;
      return { region, service, activityType, scope: internal ? 'internal' : 'external', direction: 'inbound', sourceRegion: peerRegion, targetRegion: region, sourceService: name, targetService: service };
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      const flow = inboundFlow();
      collector.record(flow);
      collector.record({ ...flow, direction: 'outbound', sourceRegion: region, targetRegion: flow.sourceRegion, sourceService: service, targetService: flow.sourceService });
    };
    response.once('finish', finish);
    // Failed/aborted requests are still real inbound activity. Do not invent a
    // completed outbound response when the connection closes prematurely.
    response.once('close', () => {
      if (finished) return;
      finished = true;
      collector.record(inboundFlow());
    });
    next();
  };
}

export interface ServiceEndpoint { service: string; region: string }
export function instrumentTrafficFetch(
  fetcher: typeof fetch,
  collector: Pick<ReturnType<typeof createTrafficCollector>, 'record'>,
  service: string,
  region: string,
  resolveEndpoint: (url: URL) => ServiceEndpoint | undefined,
): typeof fetch {
  return Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    // Collection/auth control traffic cannot generate a feedback loop.
    if (url.pathname.startsWith('/internal/activity') || url.pathname.startsWith('/auth/service-token') || url.pathname === '/platform-infrastructure') return fetcher(input, init);
    const peer = resolveEndpoint(url);
    const flow: TrafficFlow = {
      service, region, scope: peer ? 'internal' : 'external', direction: 'outbound',
      activityType: trafficType(url.pathname), sourceRegion: region, targetRegion: peer?.region,
      sourceService: service, targetService: peer?.service,
    };
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (peer) headers.set('X-Oxy-Source-Region', region);
    let response: Response;
    try { response = await fetcher(input, { ...init, headers }); }
    catch (error) { collector.record({ ...flow, targetRegion: undefined }); throw error; }
    const targetRegion = peer ? normalizeInfrastructureRegion(response.headers.get('X-Oxy-Region') ?? undefined) : undefined;
    collector.record({ ...flow, targetRegion });
    collector.record({ ...flow, direction: 'inbound', sourceRegion: targetRegion, targetRegion: region, sourceService: peer?.service, targetService: service });
    return response;
  }, fetcher) as typeof fetch;
}

// Exact deployed API hosts; an arbitrary caller-supplied hostname cannot claim
// to be an internal service. Region is infrastructure metadata, never IP geo.
const OXY_API_SERVICES: Record<string, string> = {
  'api.oxy.so': 'oxy-api', 'api.website.oxy.so': 'website',
  'website-api.oxy.so': 'website', 'api.mention.earth': 'mention',
  'api.mercaria.co': 'mercaria', 'api.alia.onl': 'alia', 'kaana.ai': 'kaana',
  'api.homiio.com': 'homiio', 'api.syra.fm': 'syra',
  'mention.earth': 'mention', 'mcp.mention.earth': 'mention-mcp',
  'api.clarity.surf': 'clarity', 'api.peable.to': 'peable',
  'api.crowdsource.oxy.so': 'crowdsource', 'api.moovo.now': 'moovo',
  'api.allo.you': 'allo', 'api.noted.oxy.so': 'noted', 'api.schedio.app': 'schedio', 'api.tnp.network': 'tnp-api',
};
export function resolveOxyServiceEndpoint(url: URL): ServiceEndpoint | undefined {
  const service = OXY_API_SERVICES[url.hostname];
  return url.protocol === 'https:' && service ? { service, region: 'us-west-2' } : undefined;
}

const REGION_LOCATIONS: Record<string, { label: string; coordinates: [number, number] }> = {
  'us-west-2': { label: 'Oregon', coordinates: [-122.6765, 45.5231] },
  'us-west-1': { label: 'Northern California', coordinates: [-121.89, 37.34] },
  'us-east-1': { label: 'Northern Virginia', coordinates: [-77.49, 39.04] },
  'us-east-2': { label: 'Ohio', coordinates: [-82.99, 39.96] },
  'eu-west-1': { label: 'Ireland', coordinates: [-6.26, 53.35] },
  'eu-west-2': { label: 'London', coordinates: [-0.1276, 51.5072] },
  'eu-west-3': { label: 'Paris', coordinates: [2.3522, 48.8566] },
  'eu-central-1': { label: 'Frankfurt', coordinates: [8.6821, 50.1109] },
  'eu-central-2': { label: 'Zurich', coordinates: [8.54, 47.38] },
  'eu-north-1': { label: 'Stockholm', coordinates: [18.07, 59.33] },
  'eu-south-1': { label: 'Milan', coordinates: [9.19, 45.46] },
  'eu-south-2': { label: 'Spain', coordinates: [-0.89, 41.65] },
  'ap-northeast-1': { label: 'Tokyo', coordinates: [139.69, 35.69] },
  'ap-northeast-2': { label: 'Seoul', coordinates: [126.98, 37.57] },
  'ap-northeast-3': { label: 'Osaka', coordinates: [135.5, 34.69] },
  'ap-southeast-1': { label: 'Singapore', coordinates: [103.82, 1.35] },
  'ap-southeast-2': { label: 'Sydney', coordinates: [151.21, -33.87] },
  'ap-southeast-3': { label: 'Jakarta', coordinates: [106.85, -6.21] },
  'ap-southeast-4': { label: 'Melbourne', coordinates: [144.96, -37.81] },
  'ap-south-1': { label: 'Mumbai', coordinates: [72.88, 19.08] },
  'ap-south-2': { label: 'Hyderabad', coordinates: [78.49, 17.38] },
  'ap-east-1': { label: 'Hong Kong', coordinates: [114.17, 22.32] },
  'ca-central-1': { label: 'Canada', coordinates: [-73.57, 45.5] },
  'ca-west-1': { label: 'Calgary', coordinates: [-114.07, 51.05] },
  'sa-east-1': { label: 'São Paulo', coordinates: [-46.63, -23.55] },
  'af-south-1': { label: 'Cape Town', coordinates: [18.42, -33.92] },
  'me-south-1': { label: 'Bahrain', coordinates: [50.59, 26.22] },
  'me-central-1': { label: 'UAE', coordinates: [54.37, 24.45] },
  'il-central-1': { label: 'Tel Aviv', coordinates: [34.78, 32.09] },
};
export function infrastructureLocation(region: string) { return REGION_LOCATIONS[region]; }

export function normalizeInfrastructureRegion(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(value) ? value : undefined;
}
