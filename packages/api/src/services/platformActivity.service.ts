import type { NextFunction, Request, Response } from 'express';
import type { Namespace } from 'socket.io';
import { getRedisClient } from '../config/redis';
import {
  metadataFromHeaders,
  presenceKeys,
} from '@oxy.so/telemetry/server';

import { createTrafficCollector, instrumentTrafficFetch, resolveOxyServiceEndpoint, trafficMiddleware, type TrafficAggregate } from '@oxy.so/telemetry/collector';

export const PLATFORM_ACTIVITY_EVENT = 'platform_activity';

export type PlatformActivityBucket = TrafficAggregate & { activeClients: number };

const EMIT_INTERVAL_MS = 2_000;
const ACTIVE_CLIENT_WINDOW_MS = 60_000;
const localClientsByOrigin = new Map<string, Map<string, number>>();
const activeClientCountByOrigin = new Map<string, number>();
let activityNamespace: Namespace | null = null;
let emitTimer: ReturnType<typeof setInterval> | null = null;
let originalFetch: typeof fetch | null = null;
let observedFetch: typeof fetch | null = null;

function processingRegion(): string {
  return process.env.AWS_REGION || 'unknown';
}

/**
 * A bounded logical destination, never the raw path. Raw paths can contain
 * account, message and file identifiers, so only the first static route group
 * may enter the public aggregate stream.
 */
function observeActiveClient(sourceRegion: string | undefined, clientId: string | undefined): void {
  if (!sourceRegion || !clientId) return;
  const now = Date.now();
  const localClients = localClientsByOrigin.get(sourceRegion) ?? new Map<string, number>();
  localClients.set(clientId, now);
  for (const [id, lastSeenAt] of localClients) {
    if (now - lastSeenAt > ACTIVE_CLIENT_WINDOW_MS) localClients.delete(id);
  }
  localClientsByOrigin.set(sourceRegion, localClients);
  activeClientCountByOrigin.set(sourceRegion, localClients.size);

  const redis = getRedisClient();
  if (!redis) return;
  const [currentKey, previousKey] = presenceKeys(sourceRegion, now);
  void redis.pipeline().pfadd(currentKey, clientId).expire(currentKey, 90).exec()
    .then(() => redis.pfcount(currentKey, previousKey))
    .then((count) => activeClientCountByOrigin.set(sourceRegion, count))
    .catch(() => {
      // The exact process-local count remains available during Redis recovery.
    });
}

export function publishPlatformActivity(events: TrafficAggregate[]): void {
  for (const event of events) {
    const origin = event.sourceRegion?.startsWith('edge-') ? event.sourceRegion : event.targetRegion;
    activityNamespace?.emit(PLATFORM_ACTIVITY_EVENT, {
      ...event,
      activeClients: origin ? activeClientCountByOrigin.get(origin) ?? 0 : 0,
    } satisfies PlatformActivityBucket);
  }
}

let collector = createTrafficCollector(async events => { publishPlatformActivity(events); });

function emitBucket(): void {
  const now = Date.now();
  for (const [origin, clients] of localClientsByOrigin) {
    for (const [id, lastSeen] of clients) if (now - lastSeen >= ACTIVE_CLIENT_WINDOW_MS) clients.delete(id);
    if (clients.size === 0) {
      localClientsByOrigin.delete(origin);
      activeClientCountByOrigin.delete(origin);
    }
  }
  void collector.flush();
}

export function initializePlatformActivity(namespace: Namespace): void {
  activityNamespace = namespace;
  if (emitTimer) return;
  originalFetch = globalThis.fetch;
  observedFetch = instrumentTrafficFetch(originalFetch, collector, 'oxy-api', processingRegion(), resolveOxyServiceEndpoint);
  globalThis.fetch = observedFetch;
  emitTimer = setInterval(emitBucket, EMIT_INTERVAL_MS);
  emitTimer.unref?.();
}

export function platformActivityMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const metadata = metadataFromHeaders(req.headers);
  observeActiveClient(metadata.edgePop ? `edge-${metadata.edgePop}` : undefined, metadata.activityId);
  trafficMiddleware(collector, 'oxy-api', processingRegion())(req, res, next);
}

export function stopPlatformActivity(): void {
  if (emitTimer) clearInterval(emitTimer);
  emitTimer = null;
  if (originalFetch && globalThis.fetch === observedFetch) globalThis.fetch = originalFetch;
  originalFetch = null;
  observedFetch = null;
  activityNamespace = null;
  collector = createTrafficCollector(async events => { publishPlatformActivity(events); });
  localClientsByOrigin.clear();
  activeClientCountByOrigin.clear();
}
