import { z } from 'zod';

export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_SKIP = 1000;

const paginationParam = (name: string, max: number) =>
  z.preprocess(
    (value) => (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value),
    z
      .number({ invalid_type_error: `${name} must be a positive integer` })
      .int(`${name} must be a positive integer`)
      .min(1, `${name} must be at least 1`)
      .max(max, `${name} is too large`),
  );

// GET /search
export const searchQuerySchema = z
  .object({
    query: z.string().trim().optional(),
    type: z.enum(['all', 'users']).optional().default('all'),
    page: paginationParam('page', MAX_SEARCH_SKIP + 1)
      .optional()
      .default(1),
    limit: paginationParam('limit', MAX_SEARCH_LIMIT).optional().default(DEFAULT_SEARCH_LIMIT),
  })
  .refine(({ page, limit }) => (page - 1) * limit <= MAX_SEARCH_SKIP, {
    path: ['page'],
    message: `page is too large; search results are limited to an offset of ${MAX_SEARCH_SKIP}`,
  });
