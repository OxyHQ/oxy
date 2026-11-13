/** Request header a browser sends: the ephemeral anonymous activity ID. */
export const OXY_ACTIVITY_ID_HEADER = 'X-Oxy-Activity-Id';
/** Request header a browser sends: the three-letter Cloudflare PoP code. */
export const OXY_EDGE_REGION_HEADER = 'X-Oxy-Edge-Region';
/** Response header a reporting service sets: the region that processed the request. */
export const OXY_REGION_HEADER = 'X-Oxy-Region';
/** Request header one Oxy service sends another: the caller's infrastructure region. */
export const OXY_SOURCE_REGION_HEADER = 'X-Oxy-Source-Region';

/**
 * Request headers a browser may send and a CORS allow-list must therefore
 * permit (`Access-Control-Allow-Headers`). `X-Oxy-Source-Region` is service to
 * service only and is deliberately absent. The list is derived from the
 * constants above, so a CORS list built from it cannot drift from them.
 */
export const OXY_TELEMETRY_REQUEST_HEADERS: readonly string[] = Object.freeze([
  OXY_ACTIVITY_ID_HEADER,
  OXY_EDGE_REGION_HEADER,
]);

/**
 * Response headers a browser client may need to read
 * (`Access-Control-Expose-Headers`).
 */
export const OXY_TELEMETRY_EXPOSED_HEADERS: readonly string[] = Object.freeze([OXY_REGION_HEADER]);

export interface AnonymousActivityMetadata {
  activityId?: string;
  edgePop?: string;
}

export type TrafficScope = 'internal' | 'external';
export type TrafficDirection = 'inbound' | 'outbound';
export type TrafficType = 'identity' | 'ai' | 'communication' | 'media' | 'platform';

/** One observed flow, as a reporter records it. */
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

/**
 * A flow with its request count and window: the exact shape the API's strict
 * `platformActivityBatchSchema` accepts on `POST /internal/activity`.
 */
export interface TrafficAggregate extends TrafficFlow {
  requests: number;
  windowStartedAt: string;
  emittedAt: string;
}

/**
 * The `platform_activity` socket payload: an aggregate plus the approximate
 * active-client count for its origin.
 */
export type ActivityAggregate = TrafficAggregate & { activeClients: number };

/** One region in the `platform_infrastructure` snapshot. */
export interface InfrastructureNode {
  region: string;
  label: string;
  coordinates: [number, number];
  services: string[];
  instances: number;
  status: 'online' | 'degraded' | 'offline' | 'unknown';
}

/** The `platform_infrastructure` socket payload. */
export interface InfrastructureSnapshot {
  emittedAt: string;
  nodes: InfrastructureNode[];
}
