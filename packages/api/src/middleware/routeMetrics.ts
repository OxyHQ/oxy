import type { NextFunction, Request, Response } from 'express';
import {
  createEmfPublisher,
  type EmfPublisher,
  HTTP_RATE_LIMITED,
  HTTP_REQUEST_LATENCY,
  statusClass,
} from '@oxy.so/telemetry/metrics';
import { refusingRateLimiter } from './rateLimiter';
import { requestCaller } from './security';

/**
 * Per-route request metrics, published as CloudWatch EMF (`Oxy/Api`).
 *
 * Mention, Allo, Clarity and Mercaria call this API fail-closed on every
 * request, so its availability is theirs — and until this existed nothing
 * could say which route was slow, which application a 429 landed on, or which
 * limiter refused it. Billed dimensions are `Service`, `StatusClass` and
 * `Caller` only; `Route`, `Method`, `Client` and `Limiter` are free log
 * properties for Logs Insights (see `@oxy.so/telemetry/metrics` on why).
 */

/** The Express route TEMPLATE that served a request — never the raw path. */
export function routeTemplate(req: Request): string {
  const path: unknown = req.route?.path;
  if (typeof path === 'string') return `${req.baseUrl}${path}`;
  if (req.route) return `${req.baseUrl}/<pattern>`;
  // Mounted with `app.use(path, handler)` rather than a router verb.
  return req.baseUrl ? `${req.baseUrl}/*` : 'unmatched';
}

export function createRouteMetricsMiddleware(publisher: EmfPublisher | null) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!publisher) {
      next();
      return;
    }
    const startedAt = performance.now();
    // `close` fires for every response, aborted ones included; `finish` does not.
    res.once('close', () => {
      try {
        const { caller, client } = requestCaller(req);
        const labels: Record<string, string> = {
          Route: routeTemplate(req),
          Method: req.method,
          StatusClass: res.writableFinished ? statusClass(res.statusCode) : 'aborted',
          Caller: caller,
          ...(client ? { Client: client } : {}),
        };
        publisher.record(HTTP_REQUEST_LATENCY, performance.now() - startedAt, labels);
        if (res.statusCode === 429) {
          const limiter = refusingRateLimiter(res);
          publisher.record(
            HTTP_RATE_LIMITED,
            1,
            limiter ? { ...labels, Limiter: limiter } : labels,
          );
        }
      } catch {
        // Metrics are best effort and must never reach a response.
      }
    });
    next();
  };
}

/**
 * Only on ECS: CloudWatch extracts EMF from the task's `awslogs` stream, and
 * anywhere else the lines would be noise in a developer's terminal.
 */
const publisher = process.env.ECS_CONTAINER_METADATA_URI_V4
  ? createEmfPublisher({ namespace: 'Oxy/Api', service: 'oxy-api' })
  : null;

export const routeMetricsMiddleware = createRouteMetricsMiddleware(publisher);

/** Flush the last interval during graceful shutdown. */
export function stopRouteMetrics(): void {
  publisher?.stop();
}
