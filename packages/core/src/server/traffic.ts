import { observeNodeHttp, withoutNodeHttpObservation } from './trafficNodeHttp';
import { observeTrafficSocket, observeTrafficWebSocket, type TrafficWebSocket, type TrafficSocket } from '@oxy.so/telemetry/socket';
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
  installFetch(): void;
  observeHttp: ReturnType<typeof trafficMiddleware>;
  observeSocket(socket: TrafficSocket, options?: Parameters<typeof observeTrafficSocket>[4]): () => void;
  observeWebSocket(socket: TrafficWebSocket, options?: Parameters<typeof observeTrafficWebSocket>[4]): () => void;
  stop(): Promise<void>;
} {
  const region = options.region ?? process.env.AWS_REGION ?? 'unknown';
  const baseURL = options.baseURL ?? process.env.OXY_API_URL ?? 'https://api.oxy.so';
  const activityKey = process.env.OXY_ACTIVITY_API_KEY;
  const activitySecret = process.env.OXY_ACTIVITY_API_SECRET;
  if (!options.credential && Boolean(activityKey) !== Boolean(activitySecret)) {
    throw new Error('Ecosystem activity requires a complete OXY_ACTIVITY_API_KEY and OXY_ACTIVITY_API_SECRET pair');
  }
  const apiKey = activityKey || process.env.OXY_SERVICE_API_KEY;
  const apiSecret = activitySecret || process.env.OXY_SERVICE_API_SECRET;
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
  let heartbeatPending = false;
  const reportError = options.onError ?? (() => console.warn('Ecosystem activity publisher unavailable'));
  const heartbeat = (removed = false) => {
    if (!removed && (stopped || heartbeatPending)) return heartbeatWork;
    heartbeatPending = true;
    heartbeatWork = heartbeatWork.then(() => post('/internal/activity/infrastructure', { instanceId, service: options.service, region, ...location, status: options.ready?.() ? 'online' : 'unknown', removed })).catch(reportError).finally(() => { heartbeatPending = false; });
    return heartbeatWork;
  };
  const flush = () => collector.flush().catch(reportError);
  const cleanups = new Set<() => void>();
  const sockets = new WeakMap<object, () => void>();
  let fetchInstalled = false;
  const wrapFetch = (fetcher: typeof fetch): typeof fetch => {
    const wrapped = instrumentTrafficFetch(fetcher, collector, options.service, region, options.resolveEndpoint ?? resolveOxyServiceEndpoint);
    return Object.assign((...args: Parameters<typeof fetch>) => withoutNodeHttpObservation(() => wrapped(...args)), fetcher) as typeof fetch;
  };
  const observeHttp = trafficMiddleware(collector, options.service, region);
  const timer = setInterval(() => { void flush(); }, 2_000);
  timer.unref?.();
  void heartbeat();
  const heartbeatTimer = setInterval(() => { void heartbeat(); }, 10_000);
  heartbeatTimer.unref?.();
  return {
    record: flow => collector.record({ ...flow, service: options.service, region }),
    middleware: observeHttp as RequestHandler,
    observeHttp,
    wrapFetch,
    installFetch() {
      if (fetchInstalled || stopped) return;
      fetchInstalled = true;
      const original = globalThis.fetch;
      const wrapped = wrapFetch(original);
      globalThis.fetch = wrapped;
      cleanups.add(() => { if (globalThis.fetch === wrapped) globalThis.fetch = original; });
      cleanups.add(observeNodeHttp(collector, options.service, region, options.resolveEndpoint ?? resolveOxyServiceEndpoint));
    },
    observeWebSocket(socket, socketOptions) {
      const existing = sockets.get(socket);
      if (existing) return existing;
      const unobserve = observeTrafficWebSocket(socket, collector, options.service, region, socketOptions);
      const cleanup = () => { unobserve(); socket.off('close', cleanup); cleanups.delete(cleanup); sockets.delete(socket); };
      sockets.set(socket, cleanup);
      socket.once('close', cleanup);
      cleanups.add(cleanup);
      return cleanup;
    },
    observeSocket(socket, socketOptions) {
      const existing = sockets.get(socket);
      if (existing) return existing;
      const unobserve = observeTrafficSocket(socket, collector, options.service, region, socketOptions);
      const cleanup = () => { unobserve(); socket.off('disconnect', cleanup); cleanups.delete(cleanup); sockets.delete(socket); };
      sockets.set(socket, cleanup);
      socket.once('disconnect', cleanup);
      cleanups.add(cleanup);
      return cleanup;
    },
    async stop() { if (stopped) return; stopped = true; cleanups.forEach(cleanup => cleanup()); cleanups.clear(); clearInterval(timer); clearInterval(heartbeatTimer); await flush(); await heartbeat(true); },
  };
}
