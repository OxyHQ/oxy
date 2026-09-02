import { type output, type ZodSchema, type ZodTypeAny, ZodError } from 'zod';
import type { Request, Response, NextFunction } from 'express';
import { BadRequestError } from '../utils/error';

interface ValidationSchemas {
  body?: ZodSchema;
  params?: ZodSchema;
  query?: ZodSchema;
}

/** Parse one request value with the API's canonical validation error envelope. */
export function parseValidatedRequestValue<Schema extends ZodTypeAny>(
  schema: Schema,
  value: unknown,
): output<Schema> {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new BadRequestError('Validation failed', {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      });
    }
    throw error;
  }
}

/**
 * Express middleware that validates request body, params, and/or query against Zod schemas.
 *
 * On success the parsed (and potentially transformed) values replace the raw
 * values on `req`, so downstream handlers receive clean, typed data.
 *
 * On failure a BadRequestError is thrown with structured Zod issue details,
 * which the global errorHandler middleware serialises into a 400 JSON response.
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (schemas.body) {
      req.body = parseValidatedRequestValue(schemas.body, req.body);
    }
    if (schemas.params) {
      req.params = parseValidatedRequestValue(schemas.params, req.params);
    }
    if (schemas.query) {
      req.query = parseValidatedRequestValue(schemas.query, req.query);
    }
    next();
  };
}
