import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { OxyServices } from '../OxyServices';
import { createTrafficCollector, instrumentTrafficFetch, trafficMiddleware, type TrafficFlow, type ServiceEndpoint, resolveOxyServiceEndpoint, infrastructureLocation } from '@oxy.so/telemetry/collector';

export interface EcosystemTrafficOptions {
  service: string;
  region?: string;
  baseURL?: string;
  credential?: () => Promise<string>;
  resolveEndpoint?: (url: URL) => ServiceEndpoint | undefined;
  onError?: () => void;
  ready?: () => boolean;
  location?: { label: string; coordinates: [number, number] };
}

/** Install once per service process, before registering HTTP routes. */
export function createEcosystemTraffic(options: EcosystemTrafficOptions): {
  middleware: RequestHandler;
  record(flow: Omit<TrafficFlow, 'service' | 'region'>): void;
  wrapFetch(fetcher: typeof fetch): typeof fetch;
  stop(): Promise<void>;
} {
  const region = options.region ?? process.env.AWS_REGION ?? 'unknown';
  const baseURL = options.baseURL ?? process.env.OXY_API_URL ?? 'https://api.oxy.so';
  const apiKey = process.env.OXY_SERVICE_API_KEY;
  const apiSecret = process.env.OXY_SERVICE_API_SECRET;
  if (!options.credential && (!apiKey || !apiSecret)) throw new Error('Ecosystem activity requires OXY_SERVICE_API_KEY and OXY_SERVICE_API_SECRET');
  const oxy = new OxyServices({ baseURL });
  if (apiKey && apiSecret) oxy.configureServiceAuth(apiKey, apiSecret);
  const credential = options.credential ?? (() => oxy.getServiceToken());
  const fetcher = globalThis.fetch.bind(globalThis);
  const instanceId = randomUUID();
  const location = options.location ?? infrastructureLocation(region);
  if (!location) throw new Error('Ecosystem activity requires a known infrastructure region or explicit location');
  const post = async (path: string, data: unknown) => {
    const token = await credential();
    const response = await fetcher(new URL(path, baseURL), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(data), signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error('Activity collection failed');
  };
  const collector = createTrafficCollector(events => post('/internal/activity', events));
  let stopped = false;
  let heartbeatWork = Promise.resolve();
  const reportError = options.onError ?? (() => console.warn('Ecosystem activity publisher unavailable'));
  const heartbeat = (removed = false) => {
    if (stopped && !removed) return heartbeatWork;
    heartbeatWork = heartbeatWork.then(() => post('/internal/activity/infrastructure', { instanceId, service: options.service, region, ...location, status: options.ready?.() ? 'online' : 'unknown', removed })).catch(reportError);
    return heartbeatWork;
  };
  const flush = () => collector.flush().catch(reportError);
  const timer = setInterval(() => { void flush(); }, 2_000);
  timer.unref?.();
  void heartbeat();
  const heartbeatTimer = setInterval(() => { void heartbeat(); }, 10_000);
  heartbeatTimer.unref?.();
  return {
    record: flow => collector.record({ ...flow, service: options.service, region }),
    middleware: trafficMiddleware(collector, options.service, region) as RequestHandler,
    wrapFetch: fetch => instrumentTrafficFetch(fetch, collector, options.service, region, options.resolveEndpoint ?? resolveOxyServiceEndpoint),
    async stop() { stopped = true; clearInterval(timer); clearInterval(heartbeatTimer); await flush(); await heartbeat(true); },
  };
}
