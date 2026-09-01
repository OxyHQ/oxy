/**
 * Async Handler Utility
 * 
 * Wraps async route handlers to automatically catch and handle errors.
 * Provides consistent error handling across all routes.
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from './logger';
import { ApiError } from './error';

type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void | Response>;

/**
 * Wraps an async route handler to automatically catch errors
 * and pass them to Express error handler
 */
export const asyncHandler = (fn: AsyncRequestHandler) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch((error) => {
      // If error is already an ApiError, pass it through
      if (error instanceof ApiError) {
        return res.status(error.statusCode).json(error.toJSON());
      }

      // Log unexpected errors
      logger.error('Unexpected error in route handler', error instanceof Error ? error : new Error(String(error)), {
        path: req.path,
        method: req.method,
      });

      // Default to 500 for unexpected errors
      const isDev = process.env.NODE_ENV === 'development';
      const message = error?.message || 'Internal server error';
      const details = isDev ? { stack: error?.stack } : undefined;

      res.status(500).json({
        error: 'INTERNAL_SERVER_ERROR',
        message: isDev ? message : 'An unexpected error occurred',
        ...(details && { details }),
      });
    });
  };
};

/**
 * Creates a success response with consistent format
 */
export const sendSuccess = <T = unknown>(
  res: Response,
  data: T,
  statusCode = 200,
  meta?: Record<string, unknown>
) => {
  const response: { data: T; meta?: Record<string, unknown> } = { data };

  if (meta) {
    response.meta = meta;
  }

  return res.status(statusCode).json(response);
};

/**
 * Creates a paginated response with consistent format
 */
export const sendPaginated = <T = unknown>(
  res: Response,
  data: T[],
  total: number,
  limit: number,
  offset: number
) => {
  return res.json({
    data,
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
    },
  });
};

