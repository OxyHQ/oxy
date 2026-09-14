import http from 'node:http';
import https from 'node:https';
import { AsyncLocalStorage } from 'node:async_hooks';
import { syncBuiltinESMExports } from 'node:module';
import { normalizeInfrastructureRegion, trafficType, type TrafficFlow, type ServiceEndpoint } from '@oxy.so/telemetry/collector';

const suppressed = new AsyncLocalStorage<boolean>();
export function withoutNodeHttpObservation<T>(callback: () => T): T { return suppressed.run(true, callback); }

/** Node and Bun share the HTTP facade; Bun does not emit Node's HTTP diagnostic channels. */
export function observeNodeHttp(
  collector: { record(flow: TrafficFlow): void }, service: string, region: string,
  resolveEndpoint: (url: URL) => ServiceEndpoint | undefined,
): () => void {
  const seen = new WeakSet<http.ClientRequest>();
  const restoreRequests = new Set<() => void>();
  const observe = (request: http.ClientRequest) => {
    if (seen.has(request) || suppressed.getStore()) return request;
    seen.add(request);
    const host = request.getHeader('host') ?? request.host;
    if (typeof host !== 'string') return request;
    const url = new URL(request.path || '/', `${request.protocol || 'http:'}//${host}`);
    if (/^\/(?:internal\/activity|auth\/service-token|platform-infrastructure)(?:\/|$)/.test(url.pathname)) return request;
    const peer = resolveEndpoint(url);
    if (peer && !request.headersSent) request.setHeader('X-Oxy-Source-Region', region);
    const flow: TrafficFlow = { service, region, activityType: trafficType(url.pathname), scope: peer ? 'internal' : 'external', direction: 'outbound', sourceRegion: region, sourceService: service, targetService: peer?.service };
    const emit = request.emit;
    let recorded = false;
    const restore = () => { if (request.emit === observedEmit) request.emit = emit; restoreRequests.delete(restore); };
    // Intercept notifications without adding an 'error' listener: observation
    // must not turn an unhandled application error into a swallowed error.
    const observedEmit: typeof request.emit = function (this: http.ClientRequest, event: string | symbol, ...args: unknown[]) {
      try {
        if (!recorded && event === 'response') {
          recorded = true;
          const response = args[0] as http.IncomingMessage;
          const targetRegion = peer ? normalizeInfrastructureRegion(response.headers['x-oxy-region']) : undefined;
          collector.record({ ...flow, targetRegion });
          collector.record({ ...flow, direction: 'inbound', sourceRegion: targetRegion, targetRegion: region, sourceService: peer?.service, targetService: service });
        } else if (!recorded && (event === 'error' || event === 'close')) {
          recorded = true;
          collector.record(flow);
        }
      } catch { /* A metrics failure cannot change a request's behavior. */ }
      if (event === 'close') restore();
      return emit.call(this, event, ...args);
    };
    request.emit = observedEmit;
    restoreRequests.add(restore);
    return request;
  };
  const safelyObserve = (request: http.ClientRequest) => {
    try { return observe(request); } catch { return request; }
  };
  const patches = [http, https].map(module => {
    const request = module.request;
    const get = module.get;
    const wrappedRequest = function (...args: Parameters<typeof request>) { return safelyObserve(request.apply(module, args)); } as typeof request;
    const wrappedGet = function (...args: Parameters<typeof get>) { return safelyObserve(get.apply(module, args)); } as typeof get;
    module.request = wrappedRequest;
    module.get = wrappedGet;
    return () => {
      if (module.request === wrappedRequest) module.request = request;
      if (module.get === wrappedGet) module.get = get;
    };
  });
  syncBuiltinESMExports();
  return () => { patches.forEach(restore => restore()); restoreRequests.forEach(restore => restore()); syncBuiltinESMExports(); };
}
