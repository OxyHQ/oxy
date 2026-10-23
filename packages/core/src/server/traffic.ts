import { observeNodeHttp, withoutNodeHttpObservation } from './trafficNodeHttp';
import {
  observeTrafficSocket,
  observeTrafficWebSocket,
  type TrafficWebSocket,
  type TrafficSocket,
} from '@oxy.so/telemetry/socket';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { OxyServer } from './OxyServer';
// Static, like `OxyServer`'s own import: this module is
// reachable from the root barrel, which ships to React Native, so pulling
// `node:crypto` in eagerly there would cost every mobile bundle. This file is
// server-only and the server barrel already exports `./workloadIdentity`, so
// there is nothing here for a phone to load.
import type { WorkloadCredentialProvider } from './workloadIdentity';
import {
  createTrafficCollector,
  instrumentTrafficFetch,
  trafficMiddleware,
  type TrafficFlow,
  type ServiceEndpoint,
  resolveOxyServiceEndpoint,
  infrastructureLocation,
} from '@oxy.so/telemetry/collector';

export interface EcosystemTrafficOptions {
  service: string;
  region?: string;
  baseURL?: string;
  /** Explicit legacy credential transport; the API still checks the caller's authority. */
  credential?: () => Promise<string>;
  /** Optional temporary IAM credentials for local development or another Node host. */
  workloadCredentials?: WorkloadCredentialProvider;
  resolveEndpoint?: (url: URL) => ServiceEndpoint | undefined;
  /**
   * Called ONCE when publishing starts failing (not on every failed attempt;
   * see {@link PUBLISH_BACKOFF_MAX_MS}). Defaults to one `console.warn`.
   */
  onError?: (error: unknown) => void;
  /** Called once when publishing succeeds again after failing. */
  onRecover?: () => void;
  ready?: () => boolean;
  location?: { label: string; coordinates: [number, number] };
}

/** First wait after a failed publish; doubles per consecutive failure. */
export const PUBLISH_BACKOFF_BASE_MS = 2_000;
/** Longest wait between attempts while publishing keeps failing. */
export const PUBLISH_BACKOFF_MAX_MS = 10 * 60_000;

/**
 * When the next publish may be attempted after `failures` consecutive
 * failures: half the exponential ceiling plus up to half again at random, so a
 * fleet refused at once does not retry in lockstep.
 *
 * Why it exists: a workload with no binding (or a revoked credential) used to
 * retry every 2 s forever — each attempt a challenge, an attestation and a
 * refusal logged on BOTH sides (tnp-relay, 36 refusals a minute in oxy-api for
 * days). A refusal will not change in two seconds; the fix arriving (a binding
 * provisioned) is picked up within {@link PUBLISH_BACKOFF_MAX_MS}.
 */
export function publishBackoffMs(failures: number, random: () => number = Math.random): number {
  const ceiling = Math.min(
    PUBLISH_BACKOFF_MAX_MS,
    PUBLISH_BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1),
  );
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** Install once per service process, before registering HTTP routes. */
export function createEcosystemTraffic(options: EcosystemTrafficOptions): {
  middleware: RequestHandler;
  record(flow: Omit<TrafficFlow, 'service' | 'region'>): void;
  wrapFetch(fetcher: typeof fetch): typeof fetch;
  installFetch(): void;
  observeHttp: ReturnType<typeof trafficMiddleware>;
  observeSocket(
    socket: TrafficSocket,
    options?: Parameters<typeof observeTrafficSocket>[4],
  ): () => void;
  observeWebSocket(
    socket: TrafficWebSocket,
    options?: Parameters<typeof observeTrafficWebSocket>[4],
  ): () => void;
  stop(): Promise<void>;
} {
  const region = options.region ?? process.env.AWS_REGION ?? 'unknown';
  const baseURL = options.baseURL ?? process.env.OXY_API_URL ?? 'https://api.oxy.so';
  const oxy = new OxyServer({ baseURL, workloadCredentials: options.workloadCredentials });
  // Own publishers always use the shared workload lane. Ambient legacy API-key
  // variables never change this process's intended authentication authority.
  const credential = options.credential;
  const fetcher = globalThis.fetch.bind(globalThis);
  const instanceId = randomUUID();
  const location = options.location ?? infrastructureLocation(region);
  if (!location)
    throw new Error(
      'Ecosystem activity requires a known infrastructure region or explicit location',
    );
  const post = async (path: string, data: unknown) => {
    if (!credential) {
      await oxy.serviceRequest('POST', path, data, { timeout: 4_000, retry: false });
      return;
    }
    const token = await credential();
    const response = await fetcher(new URL(path, baseURL), {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error('Activity collection failed');
  };
  const reportError =
    options.onError ??
    (() =>
      console.warn(
        `Ecosystem activity publisher unavailable; backing off (up to ${PUBLISH_BACKOFF_MAX_MS / 60_000} min between attempts)`,
      ));
  const reportRecovery =
    options.onRecover ?? (() => console.info('Ecosystem activity publisher recovered'));
  // Consecutive failures, and when the next attempt may be made. While
  // failing, flushes and heartbeats are skipped (the collector keeps
  // aggregating, bounded) instead of each minting a token Oxy will refuse.
  let failures = 0;
  let retryAt = 0;
  const backingOff = () => failures > 0 && Date.now() < retryAt;
  const settle = async (work: () => Promise<void>) => {
    try {
      await work();
      if (failures > 0) {
        failures = 0;
        reportRecovery();
      }
    } catch (error) {
      failures += 1;
      retryAt = Date.now() + publishBackoffMs(failures);
      if (failures === 1) reportError(error);
    }
  };
  const collector = createTrafficCollector((events) => post('/internal/activity', events));
  let stopped = false;
  let heartbeatWork = Promise.resolve();
  let heartbeatPending = false;
  const heartbeat = (removed = false) => {
    if (!removed && (stopped || heartbeatPending || backingOff())) return heartbeatWork;
    heartbeatPending = true;
    heartbeatWork = heartbeatWork
      .then(() =>
        settle(() =>
          post('/internal/activity/infrastructure', {
            instanceId,
            service: options.service,
            region,
            ...location,
            status: options.ready?.() ? 'online' : 'unknown',
            removed,
          }),
        ),
      )
      .finally(() => {
        heartbeatPending = false;
      });
    return heartbeatWork;
  };
  const flush = (force = false) =>
    !force && backingOff() ? Promise.resolve() : settle(() => collector.flush());
  const cleanups = new Set<() => void>();
  const sockets = new WeakMap<object, () => void>();
  let fetchInstalled = false;
  const wrapFetch = (fetcher: typeof fetch): typeof fetch => {
    const wrapped = instrumentTrafficFetch(
      fetcher,
      collector,
      options.service,
      region,
      options.resolveEndpoint ?? resolveOxyServiceEndpoint,
    );
    return Object.assign(
      (...args: Parameters<typeof fetch>) => withoutNodeHttpObservation(() => wrapped(...args)),
      fetcher,
    ) as typeof fetch;
  };
  const observeHttp = trafficMiddleware(collector, options.service, region);
  const timer = setInterval(() => {
    void flush();
  }, 2_000);
  timer.unref?.();
  void heartbeat();
  const heartbeatTimer = setInterval(() => {
    void heartbeat();
  }, 10_000);
  heartbeatTimer.unref?.();
  return {
    record: (flow) => collector.record({ ...flow, service: options.service, region }),
    middleware: observeHttp as RequestHandler,
    observeHttp,
    wrapFetch,
    installFetch() {
      if (fetchInstalled || stopped) return;
      fetchInstalled = true;
      const original = globalThis.fetch;
      const wrapped = wrapFetch(original);
      globalThis.fetch = wrapped;
      cleanups.add(() => {
        if (globalThis.fetch === wrapped) globalThis.fetch = original;
      });
      cleanups.add(
        observeNodeHttp(
          collector,
          options.service,
          region,
          options.resolveEndpoint ?? resolveOxyServiceEndpoint,
        ),
      );
    },
    observeWebSocket(socket, socketOptions) {
      const existing = sockets.get(socket);
      if (existing) return existing;
      const unobserve = observeTrafficWebSocket(
        socket,
        collector,
        options.service,
        region,
        socketOptions,
      );
      const cleanup = () => {
        unobserve();
        socket.off('close', cleanup);
        cleanups.delete(cleanup);
        sockets.delete(socket);
      };
      sockets.set(socket, cleanup);
      socket.once('close', cleanup);
      cleanups.add(cleanup);
      return cleanup;
    },
    observeSocket(socket, socketOptions) {
      const existing = sockets.get(socket);
      if (existing) return existing;
      const unobserve = observeTrafficSocket(
        socket,
        collector,
        options.service,
        region,
        socketOptions,
      );
      const cleanup = () => {
        unobserve();
        socket.off('disconnect', cleanup);
        cleanups.delete(cleanup);
        sockets.delete(socket);
      };
      sockets.set(socket, cleanup);
      socket.once('disconnect', cleanup);
      cleanups.add(cleanup);
      return cleanup;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const cleanup of cleanups) cleanup();
      cleanups.clear();
      clearInterval(timer);
      clearInterval(heartbeatTimer);
      await flush(true);
      await heartbeat(true);
      oxy.dispose();
    },
  };
}
