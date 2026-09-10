import type { NextFunction, Request, Response } from 'express';
import type { Namespace } from 'socket.io';
import { getRedisClient } from '../config/redis';
import {
  activityFlow,
  metadataFromHeaders,
  presenceKeys,
  serviceFromPath,
} from '@oxy.so/telemetry/server';

export const PLATFORM_ACTIVITY_EVENT = 'platform_activity';

export interface PlatformActivityBucket {
  region: string;
  sourceRegion?: string;
  targetRegion: string;
  requests: number;
  activeClients: number;
  windowStartedAt: string;
  emittedAt: string;
  direction: 'inbound';
  service: string;
}

const EMIT_INTERVAL_MS = 2_000;
const ACTIVE_CLIENT_WINDOW_MS = 60_000;
const MINIMUM_BUCKET_SIZE = 1;
const EXCLUDED_PATHS = new Set(['/health', '/platform-stats', '/platform-stats/stream']);

const pendingRequestsByFlow = new Map<string, number>();
const windowStartedAtByFlow = new Map<string, number>();
const localClientsByOrigin = new Map<string, Map<string, number>>();
const activeClientCountByOrigin = new Map<string, number>();
let activityNamespace: Namespace | null = null;
let emitTimer: ReturnType<typeof setInterval> | null = null;

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

function emitBucket(): void {
  if (!activityNamespace) return;

  const emittedAt = new Date().toISOString();
  for (const [flow, requests] of pendingRequestsByFlow) {
    // Each process emits one aggregate per service and edge for the window.
    // The event contains no IP, session, account, path or user-derived
    // coordinate, so a low-volume service remains anonymous without hiding
    // the real activity the dashboard exists to display.
    if (requests < MINIMUM_BUCKET_SIZE) continue;
    const [sourceRegion = '', service = 'platform'] = flow.split('|');
    const targetRegion = processingRegion();
    const bucket: PlatformActivityBucket = {
      region: targetRegion,
      ...(sourceRegion ? { sourceRegion } : {}),
      targetRegion,
      requests,
      activeClients: activeClientCountByOrigin.get(sourceRegion) ?? 0,
      windowStartedAt: new Date(windowStartedAtByFlow.get(flow) ?? Date.now()).toISOString(),
      emittedAt,
      direction: 'inbound',
      service,
    };
    activityNamespace.emit(PLATFORM_ACTIVITY_EVENT, bucket);
    pendingRequestsByFlow.delete(flow);
    windowStartedAtByFlow.delete(flow);
  }
}

export function initializePlatformActivity(namespace: Namespace): void {
  activityNamespace = namespace;
  if (emitTimer) return;
  emitTimer = setInterval(emitBucket, EMIT_INTERVAL_MS);
  emitTimer.unref?.();
}

export function platformActivityMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.once('finish', () => {
    if (res.statusCode < 400 && !EXCLUDED_PATHS.has(req.path)) {
      const service = serviceFromPath(req.path);
      const metadata = metadataFromHeaders(req.headers);
      const sourceRegion = metadata.edgePop ? `edge-${metadata.edgePop}` : undefined;
      observeActiveClient(sourceRegion, metadata.activityId);
      const flow = activityFlow(sourceRegion, service).key;
      if (!pendingRequestsByFlow.has(flow)) windowStartedAtByFlow.set(flow, Date.now());
      pendingRequestsByFlow.set(flow, (pendingRequestsByFlow.get(flow) ?? 0) + 1);
    }
  });
  next();
}

export function stopPlatformActivity(): void {
  if (emitTimer) clearInterval(emitTimer);
  emitTimer = null;
  activityNamespace = null;
  pendingRequestsByFlow.clear();
  windowStartedAtByFlow.clear();
  localClientsByOrigin.clear();
  activeClientCountByOrigin.clear();
}
