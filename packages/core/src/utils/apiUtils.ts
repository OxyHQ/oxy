/**
 * Utility functions for common API patterns
 */

/**
 * Build a plain query-parameter record from an object, stringifying values and
 * dropping `undefined`/`null` entries.
 *
 * This is the shape `OxyServices.makeRequest` expects for a GET's `params`:
 * `HttpService` inspects it with `Object.keys(...)` (both to decide whether to
 * append a query string and to build the request's cache key), and
 * `Object.keys(new URLSearchParams({ limit: '20' }))` is `[]` — a
 * `URLSearchParams` exposes its entries through iterator methods, never as own
 * enumerable properties. Passing one to `makeRequest` therefore silently drops
 * the whole query string. Always hand `makeRequest` a plain record.
 *
 * Generic over the input object rather than taking `Record<string, unknown>`,
 * because a TypeScript `interface` (`PaginationParams`, `FollowGraphParams`, …)
 * has no implicit index signature and so is not assignable to that type.
 */
export function buildQueryParams<T extends object>(params: T): Record<string, string> {
  const query: Record<string, string> = {};

  // Widening the value to `unknown` is always sound; the default overload of
  // `Object.entries` would otherwise infer `any` here.
  for (const [key, value] of Object.entries(params) as [string, unknown][]) {
    if (value !== undefined && value !== null) {
      query[key] = String(value);
    }
  }

  return query;
}

/**
 * Build URL search parameters from an object.
 *
 * For building a URL string only — see {@link buildQueryParams} for the shape
 * `makeRequest` needs.
 *
 * @param params Object with parameter key-value pairs
 * @returns URLSearchParams instance
 */
export function buildSearchParams<T extends object>(params: T): URLSearchParams {
  return new URLSearchParams(buildQueryParams(params));
}

/**
 * Build URL with search parameters
 * @param baseUrl Base URL
 * @param params Object with parameter key-value pairs
 * @returns Complete URL with search parameters
 */
export function buildUrl<T extends object>(baseUrl: string, params?: T): string {
  if (!params) return baseUrl;
  
  const searchParams = buildSearchParams(params);
  const queryString = searchParams.toString();
  
  return queryString ? `${baseUrl}?${queryString}` : baseUrl;
}

/**
 * Common pagination parameters
 */
export interface PaginationParams {
  limit?: number;
  offset?: number;
}

/**
 * Ordering for the follow-graph list endpoints (`/users/:id/followers`,
 * `/users/:id/following`, `/users/:id/mutuals`).
 *
 * - `recent` — newest follow edge first (the server default).
 * - `oldest` — oldest follow edge first.
 */
export type FollowGraphSort = 'recent' | 'oldest';

/**
 * Pagination plus the follow-graph ordering.
 *
 * Kept separate from {@link PaginationParams}, which is shared by endpoints
 * that have no `sort` at all.
 */
export interface FollowGraphParams extends PaginationParams {
  sort?: FollowGraphSort;
}

/**
 * Build pagination query parameters.
 *
 * Returns a plain record — NOT a `URLSearchParams` — because that is the only
 * shape `makeRequest`/`HttpService` can read. See {@link buildQueryParams}.
 *
 * @param params Pagination parameters
 * @returns Query record with pagination
 */
export function buildPaginationParams(params: PaginationParams): Record<string, string> {
  return buildQueryParams(params);
}

/**
 * Common API response wrapper
 */
export interface ApiResponse<T = any> {
  data: T;
  message?: string;
  success?: boolean;
}

/**
 * Common error response wrapper
 */
export interface ErrorResponse {
  message: string;
  code: string;
  status: number;
  details?: any;
}

/**
 * Safe JSON parsing with error handling
 * @param data Data to parse
 * @param fallback Fallback value if parsing fails
 * @returns Parsed data or fallback
 */
export function safeJsonParse<T>(data: any, fallback: T): T {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data);
    } catch {
      return fallback;
    }
  }
  return data as T;
} 