import type { Request, Response, NextFunction } from 'express';
import { isPostgresConnected } from '../config/postgres';
import { performanceMonitor } from '../utils/performanceMonitor';

/**
 * Performance monitoring middleware
 * Tracks API response times and logs slow requests
 */
export const performanceMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();

  // Track response finish
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const route = req.route?.path;
    const routeTemplate = typeof route === 'string' ? `${req.baseUrl}${route}` : 'unmatched';
    const operation =
      typeof route === 'string' ? `${req.method} ${routeTemplate}` : `${req.method} unmatched`;

    // Record the metric
    performanceMonitor.recordMetric(operation, duration, {
      method: req.method,
      statusCode: res.statusCode,
    });
  });

  next();
};

/**
 * Get memory usage statistics
 */
export const getMemoryStats = () => {
  const usage = process.memoryUsage();
  return {
    rss: Math.round(usage.rss / 1024 / 1024), // Resident Set Size in MB
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // Total heap in MB
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // Used heap in MB
    external: Math.round(usage.external / 1024 / 1024), // External memory in MB
    arrayBuffers: Math.round(usage.arrayBuffers / 1024 / 1024), // Array buffers in MB
  };
};

/**
 * Which database this process is pointed at, for `GET /metrics`.
 *
 * `host` and `name` describe the SERVER, not the driver. `connected` answers
 * whether this process holds a database pool, in the vocabulary of the pool
 * that exists.
 *
 * `connected` is `isPostgresConnected()`, so this reports whether a pool is
 * OPEN, not whether the server answers. Liveness is `GET /health`, which issues
 * a real round trip; two probes with the same answer would be one probe too
 * many, and the health one is the ALB's.
 *
 * Parsed from `DATABASE_URL` rather than read off the pool: `postgres.js`
 * exposes no such accessor, and a URL parse cannot accidentally surface the
 * password the way a driver-options dump can.
 */
export const getDatabaseStats = () => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return null;
  }

  let host: string;
  let name: string;
  try {
    const parsed = new URL(url);
    host = parsed.hostname;
    name = parsed.pathname.replace(/^\//, '');
  } catch {
    // A malformed DATABASE_URL is a startup problem the health endpoint already
    // reports; a metrics read must not become the thing that throws.
    return { connected: isPostgresConnected(), host: null, name: null };
  }

  return {
    connected: isPostgresConnected(),
    host,
    name,
  };
};

export default performanceMiddleware;
