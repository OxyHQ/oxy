import type { ActivityAggregate, AnonymousActivityMetadata } from './index.js';

export const DEFAULT_PRESENCE_BUCKET_MS = 30_000;
export const DEFAULT_ACTIVE_CLIENT_WINDOW_MS = 60_000;

export type TelemetryHeaderValue = string | readonly string[] | undefined;
export type TelemetryHeaders = Readonly<Record<string, TelemetryHeaderValue>>;

export interface ActivityCardinalityAdapter {
  add(key: string, activityId: string, ttlSeconds: number): Promise<void>;
  count(keys: readonly string[]): Promise<number>;
}

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
  return firstHeaderValue(value)?.match(/^[a-z]{3}$/i)?.[0]?.toLowerCase();
}

export function normalizeActivityId(value: TelemetryHeaderValue): string | undefined {
  const candidate = firstHeaderValue(value);
  return candidate && /^[a-z0-9_-]{16,64}$/i.test(candidate) ? candidate : undefined;
}

export function metadataFromHeaders(headers: TelemetryHeaders): AnonymousActivityMetadata {
  const forwardedPop = normalizeEdgePop(headers['x-oxy-edge-region']);
  const ray = firstHeaderValue(headers['cf-ray']);
  const rayPop = ray?.match(/-([a-z]{3})$/i)?.[1]?.toLowerCase();
  const activityId = normalizeActivityId(headers['x-oxy-activity-id']);
  return {
    ...(activityId ? { activityId } : {}),
    ...(forwardedPop || rayPop ? { edgePop: forwardedPop ?? rayPop } : {}),
  };
}

export function serviceFromPath(path: string): string {
  const segment = path.split('/').filter(Boolean)[0];
  return segment && /^[a-z][a-z0-9-]{0,31}$/i.test(segment) ? segment.toLowerCase() : 'platform';
}

export function activityFlow(sourceRegion: string | undefined, service: string): ActivityFlow {
  return { sourceRegion, service, key: `${sourceRegion ?? ''}|${service}` };
}

export function presenceBucket(observedAt: number, bucketMs = DEFAULT_PRESENCE_BUCKET_MS): number {
  if (!Number.isFinite(observedAt) || !Number.isFinite(bucketMs) || bucketMs <= 0) {
    throw new RangeError('observedAt and bucketMs must define a finite positive bucket');
  }
  return Math.floor(observedAt / bucketMs);
}

export function presenceKeys(sourceRegion: string, observedAt: number, bucketMs = DEFAULT_PRESENCE_BUCKET_MS): readonly [string, string] {
  const current = presenceBucket(observedAt, bucketMs);
  return [
    `platform-activity:clients:${sourceRegion}:${current}`,
    `platform-activity:clients:${sourceRegion}:${current - 1}`,
  ];
}

export type ActivityBucket = ActivityAggregate;
