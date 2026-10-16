/**
 * Global Error Handler Middleware
 *
 * Catches all errors and returns a consistent JSON response
 * using the ApiError format: { error, message, details? }
 */

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
 * Express error-handling middleware (must have 4 parameters).
 *
 * - ApiError instances are answered by {@link sendApiError}.
 * - Unknown errors are wrapped in InternalServerError; the raw message
 *   is only exposed outside production.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    logger.error(`ApiError [${err.statusCode}] ${err.code}: ${err.message}`);
    sendApiError(res, err);
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
