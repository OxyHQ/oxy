import type { NextFunction, Request, Response } from 'express';
import type { Namespace } from 'socket.io';

export const PLATFORM_ACTIVITY_EVENT = 'platform_activity';

export interface PlatformActivityBucket {
  region: string;
  sourceRegion?: string;
  targetRegion: string;
  requests: number;
  windowStartedAt: string;
  emittedAt: string;
  direction: 'inbound';
  service: string;
}

const EMIT_INTERVAL_MS = 2_000;
const MINIMUM_BUCKET_SIZE = 5;
const EXCLUDED_PATHS = new Set(['/health', '/platform-stats', '/platform-stats/stream']);

const pendingRequestsByFlow = new Map<string, number>();
const windowStartedAtByFlow = new Map<string, number>();
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

/** Cloudflare's serving colo, not a user IP or IP-derived coordinate. */
function ingressRegion(request: Request): string | undefined {
  const forwardedRegion = request.headers['x-oxy-edge-region'];
  const forwardedValue = Array.isArray(forwardedRegion) ? forwardedRegion[0] : forwardedRegion;
  const forwardedColo = forwardedValue?.match(/^[a-z]{3}$/i)?.[0]?.toLowerCase();
  if (forwardedColo) return `edge-${forwardedColo}`;

  const ray = request.headers['cf-ray'];
  const value = Array.isArray(ray) ? ray[0] : ray;
  const colo = value?.match(/-([a-z]{3})$/i)?.[1]?.toLowerCase();
  return colo ? `edge-${colo}` : undefined;
}

function emitBucket(): void {
  if (!activityNamespace) return;

  const emittedAt = new Date().toISOString();
  for (const [flow, requests] of pendingRequestsByFlow) {
    // Small per-service aggregates are folded into the next window. The event
    // contains no IP, session, account, path or user-derived coordinate.
    if (requests < MINIMUM_BUCKET_SIZE) continue;
    const [sourceRegion = '', service = 'platform'] = flow.split('|');
    const targetRegion = processingRegion();
    const bucket: PlatformActivityBucket = {
      region: targetRegion,
      ...(sourceRegion ? { sourceRegion } : {}),
      targetRegion,
      requests,
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
      const service = destinationService(req.path);
      const flow = `${ingressRegion(req) ?? ''}|${service}`;
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
}
