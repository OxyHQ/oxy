import {
  type ActivityAggregate,
  type AnonymousActivityMetadata,
  OXY_ACTIVITY_ID_HEADER,
  OXY_EDGE_REGION_HEADER,
} from './index.js';

export const DEFAULT_PRESENCE_BUCKET_MS = 30_000;
/** @deprecated Unused by any Oxy repo; `presenceKeys` already encodes the window. Removal is planned for the next major. */
export const DEFAULT_ACTIVE_CLIENT_WINDOW_MS = 60_000;

export type TelemetryHeaderValue = string | readonly string[] | undefined;
export type TelemetryHeaders = Readonly<Record<string, TelemetryHeaderValue>>;

/**
 * @deprecated Unused by any Oxy repo (presence counting lives in the API). No
 * replacement; removal is planned for the next major.
 */
export interface ActivityCardinalityAdapter {
  add(key: string, activityId: string, ttlSeconds: number): Promise<void>;
  count(keys: readonly string[]): Promise<number>;
}

/** @deprecated Unused by any Oxy repo; see `activityFlow`. */
export interface ActivityFlow {
  sourceRegion?: string;
  service: string;
  key: string;
}

function firstHeaderValue(value: TelemetryHeaderValue): string | undefined {
  if (typeof value === 'string') return value;
  const first = value?.[0];
  return typeof first === 'string' ? first : undefined;
}

export function normalizeEdgePop(value: TelemetryHeaderValue): string | undefined {
  return firstHeaderValue(value)
    ?.match(/^[a-z]{3}$/i)?.[0]
    ?.toLowerCase();
}

export function normalizeActivityId(value: TelemetryHeaderValue): string | undefined {
  const candidate = firstHeaderValue(value);
  return candidate && /^[a-z0-9_-]{16,64}$/i.test(candidate) ? candidate : undefined;
}

/**
 * The collector's source region for a normalised edge PoP (`edge-<pop>`), the
 * one derivation every reporter shares. `undefined` when there is no PoP.
 */
export function sourceRegionFromEdgePop(edgePop: string | undefined): string | undefined {
  return edgePop ? `edge-${edgePop}` : undefined;
}

export function metadataFromHeaders(headers: TelemetryHeaders): AnonymousActivityMetadata {
  const forwardedPop = normalizeEdgePop(headers[OXY_EDGE_REGION_HEADER.toLowerCase()]);
  const ray = firstHeaderValue(headers['cf-ray']);
  const rayPop = ray?.match(/-([a-z]{3})$/i)?.[1]?.toLowerCase();
  const activityId = normalizeActivityId(headers[OXY_ACTIVITY_ID_HEADER.toLowerCase()]);
  return {
    ...(activityId ? { activityId } : {}),
    ...(forwardedPop || rayPop ? { edgePop: forwardedPop ?? rayPop } : {}),
  };
}

/**
 * @deprecated Unused by any Oxy repo. For the bounded activity category of a
 * path use `trafficType` from `@oxy.so/telemetry/collector`. Removal is planned
 * for the next major.
 */
export function serviceFromPath(path: string): string {
  const segment = path.split('/').filter(Boolean)[0];
  return segment && /^[a-z][a-z0-9-]{0,31}$/i.test(segment) ? segment.toLowerCase() : 'platform';
}

/**
 * @deprecated Unused by any Oxy repo; `createTrafficCollector` keys its own
 * flows. Removal is planned for the next major.
 */
export function activityFlow(sourceRegion: string | undefined, service: string): ActivityFlow {
  return { sourceRegion, service, key: `${sourceRegion ?? ''}|${service}` };
}

/**
 * @deprecated Unused outside `presenceKeys`; call `presenceKeys` for the
 * current and previous bucket keys. Removal is planned for the next major.
 */
export function presenceBucket(observedAt: number, bucketMs = DEFAULT_PRESENCE_BUCKET_MS): number {
  if (!Number.isFinite(observedAt) || !Number.isFinite(bucketMs) || bucketMs <= 0) {
    throw new RangeError('observedAt and bucketMs must define a finite positive bucket');
  }
  return Math.floor(observedAt / bucketMs);
}

export function presenceKeys(
  sourceRegion: string,
  observedAt: number,
  bucketMs = DEFAULT_PRESENCE_BUCKET_MS,
): readonly [string, string] {
  const current = presenceBucket(observedAt, bucketMs);
  return [
    `platform-activity:clients:${sourceRegion}:${current}`,
    `platform-activity:clients:${sourceRegion}:${current - 1}`,
  ];
}

/** @deprecated Unused by any Oxy repo; use `ActivityAggregate` from `@oxy.so/telemetry`. */
export type ActivityBucket = ActivityAggregate;
