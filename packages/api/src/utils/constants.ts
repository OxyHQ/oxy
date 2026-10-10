/**
 * Shared constants for the API package
 * Consolidates pagination, cache, and other common constants
 */

/**
 * Pagination constants
 */
export const PAGINATION = {
  DEFAULT_LIMIT: 50,
  MAX_LIMIT: 100,
  DEFAULT_OFFSET: 0,
  DEFAULT_PAGE: 1,
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
} as const;

/**
 * Cache time constants (in milliseconds)
 */
export const CACHE_TIMES = {
  SHORT: 1 * 60 * 1000, // 1 minute
  MEDIUM: 2 * 60 * 1000, // 2 minutes
  LONG: 5 * 60 * 1000, // 5 minutes
  VERY_LONG: 10 * 60 * 1000, // 10 minutes
  EXTRA_LONG: 30 * 60 * 1000, // 30 minutes
} as const;

/**
 * Transaction-specific constants
 */
export const TRANSACTION = {
  DEFAULT_LIMIT: 10,
  MAX_LIMIT: 100,
  DEFAULT_OFFSET: 0,
} as const;
