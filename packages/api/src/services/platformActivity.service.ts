import type { NextFunction, Request, Response } from 'express';
import type { Namespace } from 'socket.io';

export const PLATFORM_ACTIVITY_EVENT = 'platform_activity';

export interface PlatformActivityBucket {
  region: string;
  requests: number;
  windowStartedAt: string;
  emittedAt: string;
}

const EMIT_INTERVAL_MS = 2_000;
const MINIMUM_BUCKET_SIZE = 5;
const EXCLUDED_PATHS = new Set(['/health', '/platform-stats', '/platform-stats/stream']);

let pendingRequests = 0;
let windowStartedAt = Date.now();
let activityNamespace: Namespace | null = null;
let emitTimer: ReturnType<typeof setInterval> | null = null;

function processingRegion(): string {
  return process.env.AWS_REGION || 'unknown';
}

function emitBucket(): void {
  if (!activityNamespace || pendingRequests < MINIMUM_BUCKET_SIZE) return;

  const bucket: PlatformActivityBucket = {
    region: processingRegion(),
    requests: pendingRequests,
    windowStartedAt: new Date(windowStartedAt).toISOString(),
    emittedAt: new Date().toISOString(),
  };
  pendingRequests = 0;
  windowStartedAt = Date.now();
  activityNamespace.emit(PLATFORM_ACTIVITY_EVENT, bucket);
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
      pendingRequests += 1;
    }
  });
  next();
}

export function stopPlatformActivity(): void {
  if (emitTimer) clearInterval(emitTimer);
  emitTimer = null;
  activityNamespace = null;
  pendingRequests = 0;
  windowStartedAt = Date.now();
}
