import type { NextFunction, Request, Response } from 'express';
import type { Namespace } from 'socket.io';

export const PLATFORM_ACTIVITY_EVENT = 'platform_activity';

export interface PlatformActivityBucket {
  region: string;
  requests: number;
  windowStartedAt: string;
  emittedAt: string;
  direction: 'inbound';
  service: string;
}

const EMIT_INTERVAL_MS = 2_000;
const MINIMUM_BUCKET_SIZE = 5;
const EXCLUDED_PATHS = new Set(['/health', '/platform-stats', '/platform-stats/stream']);

const pendingRequestsByService = new Map<string, number>();
const windowStartedAtByService = new Map<string, number>();
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
function destinationService(path: string): string {
  const segment = path.split('/').filter(Boolean)[0];
  return segment && /^[a-z][a-z0-9-]{0,31}$/i.test(segment) ? segment.toLowerCase() : 'platform';
}

function emitBucket(): void {
  if (!activityNamespace) return;

  const emittedAt = new Date().toISOString();
  for (const [service, requests] of pendingRequestsByService) {
    // Per-service k-anonymity: a tiny bucket is folded into the next window
    // rather than exposing that one person used one product at one moment.
    if (requests < MINIMUM_BUCKET_SIZE) continue;
    const bucket: PlatformActivityBucket = {
      region: processingRegion(),
      requests,
      windowStartedAt: new Date(windowStartedAtByService.get(service) ?? Date.now()).toISOString(),
      emittedAt,
      direction: 'inbound',
      service,
    };
    activityNamespace.emit(PLATFORM_ACTIVITY_EVENT, bucket);
    pendingRequestsByService.delete(service);
    windowStartedAtByService.delete(service);
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
      const service = destinationService(req.path);
      if (!pendingRequestsByService.has(service)) windowStartedAtByService.set(service, Date.now());
      pendingRequestsByService.set(service, (pendingRequestsByService.get(service) ?? 0) + 1);
    }
  });
  next();
}

export function stopPlatformActivity(): void {
  if (emitTimer) clearInterval(emitTimer);
  emitTimer = null;
  activityNamespace = null;
  pendingRequestsByService.clear();
  windowStartedAtByService.clear();
}
