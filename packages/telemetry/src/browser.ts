import { OXY_ACTIVITY_ID_HEADER, OXY_EDGE_REGION_HEADER } from './index.js';

export const DEFAULT_ACTIVITY_ID_ROTATION_MS = 5 * 60 * 1_000;
export const DEFAULT_EDGE_TRACE_TIMEOUT_MS = 1_000;
export const DEFAULT_EDGE_CACHE_MS = 15_000;
/**
 * How long `peekEdgeRegionHeader` trusts a known PoP before refreshing it in the
 * background. A client's serving PoP rarely changes within minutes, and the
 * peek never blocks, so this only bounds the trace traffic.
 */
export const DEFAULT_EDGE_PEEK_REFRESH_MS = 10 * 60_000;

interface TraceResponse {
  ok: boolean;
  text(): Promise<string>;
}

export interface BrowserTelemetryOptions {
  activityIdRotationMs?: number;
  edgeTraceTimeoutMs?: number;
  edgeCacheMs?: number;
  edgePeekRefreshMs?: number;
  now?: () => number;
  crypto?: Pick<Crypto, 'getRandomValues' | 'randomUUID'>;
  location?: Pick<Location, 'hostname' | 'protocol'>;
  fetchTrace?: (signal: AbortSignal) => Promise<TraceResponse>;
}

export interface BrowserTelemetry {
  getActivityIdHeader(): Record<string, string>;
  getEdgeRegionHeader(): Promise<Record<string, string>>;
  /**
   * The last known edge-region header, synchronously, never waiting on the
   * trace: `{}` until the first discovery lands. A stale or missing value
   * starts a refresh in the background.
   */
  peekEdgeRegionHeader(): Record<string, string>;
  getHeaders(): Promise<Record<string, string>>;
}

function createUuid(cryptoApi: Pick<Crypto, 'getRandomValues' | 'randomUUID'> | undefined): string | null {
  if (!cryptoApi) return null;
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();

  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function eligibleLocation(location: Pick<Location, 'hostname' | 'protocol'> | undefined): boolean {
  if (!location || (location.protocol !== 'https:' && location.protocol !== 'http:')) return false;
  return location.hostname !== 'localhost'
    && location.hostname !== '127.0.0.1'
    && location.hostname !== '[::1]';
}

export function createBrowserTelemetry(options: BrowserTelemetryOptions = {}): BrowserTelemetry {
  let activityId: string | null = null;
  let activityIdCreatedAt = 0;
  let edgePopPromise: Promise<string | null> | null = null;
  let edgePopReadAt = -Infinity;

  const getActivityIdHeader = (): Record<string, string> => {
    const hasInjectedBrowser = Boolean(options.location);
    const hasBrowserRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';
    if (!hasInjectedBrowser && !hasBrowserRuntime) return {};
    const now = (options.now ?? Date.now)();
    if (!activityId || now < activityIdCreatedAt || now - activityIdCreatedAt >= (options.activityIdRotationMs ?? DEFAULT_ACTIVITY_ID_ROTATION_MS)) {
      activityId = createUuid(options.crypto ?? globalThis.crypto);
      if (!activityId) return {};
      activityIdCreatedAt = now;
    }
    return { [OXY_ACTIVITY_ID_HEADER]: activityId };
  };

  const discoverEdgePop = async (): Promise<string | null> => {
    const browserLocation = options.location ?? (typeof window === 'undefined' ? undefined : window.location);
    if (!eligibleLocation(browserLocation)) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.edgeTraceTimeoutMs ?? DEFAULT_EDGE_TRACE_TIMEOUT_MS);
    try {
      const response = await (options.fetchTrace
        ? options.fetchTrace(controller.signal)
        : fetch('/cdn-cgi/trace', { cache: 'no-store', credentials: 'omit', signal: controller.signal }));
      if (!response.ok) return null;
      const match = (await response.text()).match(/^colo=([a-z]{3})$/im);
      return match ? match[1].toLowerCase() : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };

  const getEdgeRegionHeader = async (): Promise<Record<string, string>> => {
    const now = (options.now ?? Date.now)();
    if (!edgePopPromise || now < edgePopReadAt || now - edgePopReadAt >= (options.edgeCacheMs ?? DEFAULT_EDGE_CACHE_MS)) {
      edgePopReadAt = now;
      edgePopPromise = discoverEdgePop();
    }
    const edgePop = await edgePopPromise;
    return edgePop ? { [OXY_EDGE_REGION_HEADER]: edgePop } : {};
  };

  let peekedPop: string | null = null;
  let peekRefreshAt = -Infinity;
  let peekInFlight = false;

  const peekEdgeRegionHeader = (): Record<string, string> => {
    const now = (options.now ?? Date.now)();
    if (!peekInFlight && (now < peekRefreshAt || now - peekRefreshAt >= (options.edgePeekRefreshMs ?? DEFAULT_EDGE_PEEK_REFRESH_MS))) {
      peekRefreshAt = now;
      peekInFlight = true;
      void discoverEdgePop()
        .then((pop) => {
          if (pop) peekedPop = pop;
        })
        .finally(() => {
          peekInFlight = false;
        });
    }
    return peekedPop ? { [OXY_EDGE_REGION_HEADER]: peekedPop } : {};
  };

  return {
    getActivityIdHeader,
    getEdgeRegionHeader,
    peekEdgeRegionHeader,
    async getHeaders(): Promise<Record<string, string>> {
      return { ...await getEdgeRegionHeader(), ...getActivityIdHeader() };
    },
  };
}

const defaultBrowserTelemetry = createBrowserTelemetry();

export const getBrowserActivityIdHeader = (): Record<string, string> =>
  defaultBrowserTelemetry.getActivityIdHeader();

export const getBrowserEdgeRegionHeader = (): Promise<Record<string, string>> =>
  defaultBrowserTelemetry.getEdgeRegionHeader();

export const peekBrowserEdgeRegionHeader = (): Record<string, string> =>
  defaultBrowserTelemetry.peekEdgeRegionHeader();

export const getBrowserTelemetryHeaders = (): Promise<Record<string, string>> =>
  defaultBrowserTelemetry.getHeaders();
