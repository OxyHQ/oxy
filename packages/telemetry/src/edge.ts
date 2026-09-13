import { trafficType, type TrafficAggregate } from './collector.js';
import { normalizeEdgePop } from './server.js';

/** Server-only bindings; never expose them through frontend build variables. */
export interface EdgeActivityEnv {
  OXY_EDGE_ACTIVITY_ENABLED?: string;
  OXY_EDGE_ACTIVITY_API_KEY?: string;
  OXY_EDGE_ACTIVITY_API_SECRET?: string;
  OXY_EDGE_ACTIVITY_API_URL?: string;
}
export interface EdgeActivityContext { waitUntil(promise: Promise<unknown>): void }
export interface EdgeActivityOptions {
  service: string;
  request: Request & { cf?: { colo?: unknown } };
  env: EdgeActivityEnv;
  ctx: EdgeActivityContext;
  next: () => Response | Promise<Response>;
  credential?: () => Promise<string>;
  fetcher?: typeof fetch;
  /** Only supply after existing authentication verified this service identity. */
  peer?: { service: string; region?: string };
  /** Fixed message only: never credentials, URLs or upstream error bodies. */
  onError?: (message: string) => void;
}
interface CachedToken { key: string; secret: string; origin: string; token: string; expiresAt: number }
// Share values only: Workers prohibit I/O promises/bodies crossing request contexts.
const tokens = new WeakMap<EdgeActivityEnv, CachedToken>();
const CONTROL = /^\/(?:api\/)?(?:health|ready|live|platform-stats|platform-activity|platform-infrastructure|infra-status|internal\/activity|auth\/service-token|cdn-cgi)(?:\/|$)/;

async function smallJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Missing token response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw new Error('Oversized token response'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function publish(options: EdgeActivityOptions, events: TrafficAggregate[]): Promise<void> {
  const { env } = options;
  const base = new URL(env.OXY_EDGE_ACTIVITY_API_URL ?? 'https://api.oxy.so');
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Invalid activity origin');
  const fetcher = options.fetcher ?? fetch;
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 4_000);
  try {
    let token: string;
    if (options.credential) token = await Promise.race([
      options.credential(),
      new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('Activity credential timeout')), { once: true })),
    ]);
    else {
      const key = env.OXY_EDGE_ACTIVITY_API_KEY;
      const secret = env.OXY_EDGE_ACTIVITY_API_SECRET;
      if (!key || !secret) throw new Error('Missing edge activity credentials');
      const cached = tokens.get(env);
      if (cached && cached.key === key && cached.secret === secret && cached.origin === base.origin && cached.expiresAt > Date.now() + 60_000) token = cached.token;
      else {
        // Same exchange and expiry margin as OxyServices.getServiceToken().
        const response = await fetcher(new URL('/auth/service-token', base), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: key, apiSecret: secret }), signal: abort.signal,
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error('Activity authentication failed'); }
        const data = await smallJson(response) as { token?: unknown; expiresIn?: unknown };
        if (typeof data.token !== 'string' || !data.token || typeof data.expiresIn !== 'number' || !Number.isFinite(data.expiresIn) || data.expiresIn <= 0) throw new Error('Invalid activity token');
        token = data.token;
        tokens.set(env, { key, secret, origin: base.origin, token, expiresAt: Date.now() + data.expiresIn * 1_000 });
      }
    }
    const response = await fetcher(new URL('/internal/activity', base), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(events), signal: abort.signal,
    });
    if (response.status === 401) tokens.delete(env);
    await response.body?.cancel();
    if (!response.ok) throw new Error('Activity ingestion failed');
  } finally { clearTimeout(timeout); }
}

/** Returns the original response/stream and preserves original handler errors. */
export async function observeEdgeRequest(options: EdgeActivityOptions): Promise<Response> {
  const report = () => { try { (options.onError ?? console.error)('Edge activity publication failed'); } catch { /* Never break serving. */ } };
  const enabled = options.env.OXY_EDGE_ACTIVITY_ENABLED;
  if (enabled === undefined || enabled === 'false') return options.next();
  if (enabled !== 'true' || !/^[a-z][a-z0-9-]{0,39}$/.test(options.service)) { report(); return options.next(); }
  const path = new URL(options.request.url).pathname;
  if (CONTROL.test(path)) return options.next();
  const pop = normalizeEdgePop(typeof options.request.cf?.colo === 'string' ? options.request.cf.colo : undefined);
  const region = pop ? `edge-${pop}` : 'unknown';
  const startedAt = new Date().toISOString();
  const complete = (response?: Response) => {
    const contentType = response?.headers.get('Content-Type') ?? '';
    const activityType = /^(?:image|audio|video)\//i.test(contentType) ? 'media' : trafficType(path);
    const common = { service: options.service, region, scope: options.peer ? 'internal' as const : 'external' as const, activityType, requests: 1, windowStartedAt: startedAt, emittedAt: new Date().toISOString() };
    // The serving PoP is infrastructure metadata. Do not invent visitor location.
    const events: TrafficAggregate[] = [{ ...common, direction: 'inbound', sourceRegion: options.peer?.region, sourceService: options.peer?.service, targetRegion: region, targetService: options.service }];
    if (response) events.push({ ...common, direction: 'outbound', sourceRegion: region, sourceService: options.service, targetRegion: options.peer?.region, targetService: options.peer?.service });
    try { options.ctx.waitUntil(publish(options, events).catch(report)); } catch { report(); }
  };
  let response: Response;
  try { response = await options.next(); }
  catch (error) { complete(); throw error; }
  complete(response);
  return response;
}
