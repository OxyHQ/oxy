/**
 * Global Error Handler Middleware
 *
 * Catches all errors and returns a consistent JSON response
 * using the ApiError format: { error, message, details? }
 */

import { STATUS_CODES } from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import { ApiError, InternalServerError, RateLimitedError } from '../utils/error';
import { logger } from '../utils/logger';

/**
 * Answer a request that is over a budget: 429, `Retry-After` in whole seconds
 * when there is a wait, and the typed error ({@link RateLimitedError}). The one
 * place oxy-api writes a 429: every limiter (`rateLimiter.ts`), the hand-rolled
 * budgets that cannot be an express-rate-limit middleware (device-secret
 * lockouts, the stats stream cap), and every `RateLimitedError` a service
 * throws ({@link sendApiError}). Here, not in `rateLimiter.ts`, because tests
 * mock that module for its limiters and the answer must not go with them.
 */
export function sendRateLimited(res: Response, refusal: RateLimitedError, format?: 'nested'): void {
  const { retryAfterSeconds } = refusal;
  if (retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(retryAfterSeconds));
  res.status(refusal.statusCode).json(
    format === 'nested'
      ? {
          error: {
            code: 'rate_limited',
            message: refusal.message,
            ...(refusal.details && { details: refusal.details }),
          },
        }
      : refusal.toJSON(),
  );
}

/**
 * Answer an ApiError: a RateLimitedError through `sendRateLimited`, with its
 * `Retry-After`; any other serialised via `toJSON()`. The one way, here and in
 * `asyncHandler`, which answers the errors of the handlers it wraps itself.
 */
export function sendApiError(res: Response, err: ApiError): void {
  if (err instanceof RateLimitedError) {
    sendRateLimited(res, err);
    return;
  }
  res.status(err.statusCode).json(err.toJSON());
}

/**
 * The 4xx a non-ApiError carries, if any. Express gives the URIError of an
 * undecodable path parameter (`%c0`) `status` 400; body-parser's http-errors
 * carry `status`/`statusCode` plus `expose` and `type` (`request.aborted`,
 * `entity.parse.failed`, `entity.too.large`). Each is the client's fault.
 *
 * Only those two shapes: an upstream client's error (an AxiosError carries the
 * UPSTREAM response's `status`) is this server's failure, and relaying its 401
 * would tell an SDK its own session is gone.
 */
function clientErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const { status, statusCode, expose } = err as {
    status?: unknown;
    statusCode?: unknown;
    expose?: unknown;
  };
  if (!(err instanceof URIError) && typeof expose !== 'boolean') return undefined;
  return [status, statusCode].find(
    (value): value is number =>
      Number.isInteger(value) && Number(value) >= 400 && Number(value) < 500,
  );
}

/**
 * Express error-handling middleware (must have 4 parameters).
 *
 * - ApiError instances are answered by {@link sendApiError}; a 4xx is logged
 *   at warn, since it is the client's error rather than this server's.
 * - A non-ApiError carrying a 4xx status ({@link clientErrorStatus}) is
 *   answered with that status in the same ApiError shape; its message only
 *   when the error marks it `expose`.
 * - Unknown errors are wrapped in InternalServerError; the raw message
 *   is only exposed outside production.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (err instanceof ApiError) {
    const line = `ApiError [${err.statusCode}] ${err.code}: ${err.message}`;
    if (err.statusCode < 500) logger.warn(line);
    else logger.error(line);
    sendApiError(res, err);
    return;
  }

  const status = clientErrorStatus(err);
  if (status !== undefined) {
    const { expose, message, type } = err as {
      expose?: unknown;
      message?: unknown;
      type?: unknown;
    };
    const context = { status, type, method: req.method, path: req.path };
    // A client that hung up mid-body is routine traffic, not a warning.
    if (type === 'request.aborted') logger.debug('Request aborted by the client', context);
    else logger.warn('Client error', context);
    if (res.headersSent) {
      next(err);
      return;
    }
    const refusal = new ApiError(
      status,
      expose === true && typeof message === 'string'
        ? message
        : (STATUS_CODES[status] ?? 'Bad Request'),
      status === 413 ? 'PAYLOAD_TOO_LARGE' : undefined,
    );
    res.status(refusal.statusCode).json(refusal.toJSON());
    return;
  }

  // Wrap unknown errors
  const message =
    process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : err instanceof Error
        ? err.message
        : String(err);

  logger.error('Unhandled error:', err);

  const wrapped = new InternalServerError(message);
  res.status(wrapped.statusCode).json(wrapped.toJSON());
}
