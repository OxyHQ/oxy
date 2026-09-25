import type { ApiError } from '../models/interfaces';
import { logger } from '../logger';

/**
 * Error handling utilities for consistent error processing
 */

/**
 * Common error codes
 */
export const ErrorCodes = {
  // Authentication errors
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  INVALID_TOKEN: 'INVALID_TOKEN',
  MISSING_TOKEN: 'MISSING_TOKEN',
  
  // Validation errors
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  MISSING_PARAMETER: 'MISSING_PARAMETER',
  INVALID_FORMAT: 'INVALID_FORMAT',
  
  // Resource errors
  NOT_FOUND: 'NOT_FOUND',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  CONFLICT: 'CONFLICT',
  
  // Server errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  
  // Network errors
  NETWORK_ERROR: 'NETWORK_ERROR',
  CONNECTION_FAILED: 'CONNECTION_FAILED',

  /**
   * The CALLER cancelled this request — it did not fail.
   *
   * Distinct from {@link ErrorCodes.TIMEOUT} on purpose, and the distinction is
   * load-bearing rather than cosmetic. Both arrive from `fetch` as an
   * `AbortError` carrying no status, so for a long time both collapsed to
   * `TIMEOUT` with `status: 0` — and since `status: 0` is not 4xx, the retry
   * predicate treated a cancellation as a transient failure and re-issued the
   * request the caller had just abandoned. A cancellation is an INSTRUCTION;
   * nothing may retry it. See `retryAsync`'s default predicate, which refuses
   * this code specifically.
   */
  CANCELLED: 'CANCELLED'
} as const;

/**
 * The `Error` shape the SDK rejects with when an HTTP request fails.
 *
 * `HttpService` throws this for every non-2xx response, and
 * `OxyServices.handleError` (the wrapper the mixin methods rethrow through)
 * preserves `message`, `status`, `code` and `details`. `response` only survives
 * on the raw `HttpService`/`makeRequest` path, so treat it as optional.
 *
 * Narrow a caught value with {@link isHttpRequestError} instead of asserting.
 */
export interface HttpRequestError extends Error {
    /** HTTP status of the failed response. */
    status: number;
    /** Machine-readable code the server sent, when it sent one. */
    code?: string;
    /** Structured error detail the server sent, when it sent an object. */
    details?: Record<string, unknown>;
    /**
     * Present on errors thrown directly by `HttpService`. `data` is the parsed
     * JSON error body verbatim — the escape hatch for any server field the SDK
     * does not lift onto `code`/`details`.
     */
    response?: {
        status: number;
        statusText: string;
        data?: unknown;
    };
}

/**
 * Narrow a caught value to {@link HttpRequestError}.
 *
 * Returns `false` for a plain {@link ApiError} object (those are objects, not
 * `Error`s) — run an arbitrary thrown value through {@link handleHttpError}
 * first if you need one normalized.
 */
export function isHttpRequestError(value: unknown): value is HttpRequestError {
    if (!(value instanceof Error)) {
        return false;
    }
    return typeof (value as Partial<HttpRequestError>).status === 'number';
}

/**
 * The fields {@link parseHttpErrorBody} lifts off a parsed error response body.
 */
export interface ParsedHttpErrorBody {
    message?: string;
    code?: string;
    details?: Record<string, unknown>;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim().length > 0 ? value : undefined;

/**
 * Extract `message` / `code` / `details` from a parsed HTTP error response body.
 *
 * Handles every error envelope in use across the Oxy ecosystem:
 *
 * - `{ error: { code, message, details? } }` — nested envelope (CrowdSource and
 *   other Oxy services). Never stringify the nested object: `new Error(obj)`
 *   yields the literal message `"[object Object]"`.
 * - `{ error: '<CODE>', message, details? }` — oxy-api's canonical shape
 *   (`ApiError.toJSON`), where the top-level `error` field IS the code.
 * - `{ error: '<CODE>', error_description }` — RFC 6749 §5.2 / RFC 6750 §3, the
 *   OAuth token and userinfo endpoints. `error_description` is the human text
 *   and `error` is the machine code, so both survive.
 * - `{ message, code }` — e.g. the API's middleware rejections.
 * - `{ error: '<human message>' }` — legacy hand-rolled routes. With no sibling
 *   `message`/`error_description` the string is the message, not a code: a bare
 *   `error` string is not machine-readable enough to promote to `code`.
 *
 * Anything else — a non-object body (`null`, `[]`, `"str"`, `42`), or an object
 * carrying none of these fields — yields an empty result, leaving the caller on
 * its status-based fallback message. Total function: never throws.
 */
export function parseHttpErrorBody(body: unknown): ParsedHttpErrorBody {
    if (!isPlainRecord(body)) {
        return {};
    }

    const nested = isPlainRecord(body.error) ? body.error : undefined;
    const errorString = nonEmptyString(body.error);
    // A sibling that proves the top-level `error` is a CODE rather than prose.
    const siblingMessage = nonEmptyString(body.message) ?? nonEmptyString(body.error_description);

    return {
        message: siblingMessage ?? (nested ? nonEmptyString(nested.message) : errorString),
        code:
            (nested ? nonEmptyString(nested.code) : undefined) ??
            nonEmptyString(body.code) ??
            (siblingMessage ? errorString : undefined),
        details: isPlainRecord(body.details)
            ? body.details
            : nested && isPlainRecord(nested.details)
                ? nested.details
                : undefined,
    };
}

/**
 * Create a standardized API error
 */
export function createApiError(
  message: string,
  code: string = ErrorCodes.INTERNAL_ERROR,
  status = 500,
  details?: Record<string, unknown>
): ApiError {
  return {
    message,
    code,
    status,
    details
  };
}

/**
 * The error a CALLER-cancelled request rejects with.
 *
 * Carries both identities on purpose, because consumers check for
 * cancellation two different ways and both are legitimate:
 *
 * - `name: 'AbortError'` is what every `fetch`-era consumer tests, and what
 *   React Query and friends recognise. Dropping it would silently turn
 *   cancellations into errors in every app that already handles aborts.
 * - `code: ErrorCodes.CANCELLED` / `cancelled: true` is what code inside this
 *   SDK tests, because `handleHttpError` returns PLAIN objects (not `Error`s)
 *   for most failures, so `name` is not a reliable discriminator across the
 *   whole surface.
 *
 * It is an `Error` rather than a bare `ApiError` object so a stack survives and
 * `instanceof Error` holds — the shape the abort path always looked like it
 * produced, and never did.
 */
export type CancelledError = Error & ApiError & { cancelled: true };

export function createCancelledError(message = 'Request cancelled'): CancelledError {
  const error = new Error(message) as CancelledError;
  error.name = 'AbortError';
  error.code = ErrorCodes.CANCELLED;
  error.status = 0;
  error.cancelled = true;
  return error;
}

/**
 * Whether an error represents a CALLER cancellation rather than a failure.
 *
 * Structural, never message-based: a message is localizable and rewordable,
 * and a retry predicate that keys off one is a bug waiting for a copy edit.
 */
function isAbortLike(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

export function isCancelledError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; cancelled?: unknown; name?: unknown };
  return (
    candidate.cancelled === true ||
    candidate.code === ErrorCodes.CANCELLED ||
    candidate.name === 'AbortError'
  );
}

/**
 * Handle common HTTP errors and convert to ApiError
 */
export function handleHttpError(error: unknown): ApiError {
  // If it's already an ApiError, ensure it has a non-empty message
  if (error && typeof error === 'object' && 'code' in error && 'status' in error) {
    const apiError = error as ApiError;
    // Ensure message is not empty
    if (!apiError.message || !apiError.message.trim()) {
      return {
        ...apiError,
        message: apiError.message || 'An error occurred',
      };
    }
    return apiError;
  }

  // Handle AbortError (timeout or cancelled requests).
  //
  // Matched by NAME rather than `instanceof Error`, because `fetch` rejects an
  // abort with a `DOMException` and `instanceof` is realm-bound — an exception
  // built in another realm (a test VM, a worker, an iframe) fails the check and
  // falls through to the generic 500 branch below. `HttpService` classifies its
  // own aborts before reaching here, so this is the fallback for aborts raised
  // anywhere else, and it stays TIMEOUT: a caller that never passed a signal
  // cannot have cancelled anything.
  if (isAbortLike(error)) {
    return createApiError(
      'Request timeout or cancelled',
      ErrorCodes.TIMEOUT,
      0
    );
  }

  // Handle TypeError (network failures, CORS, etc.)
  if (error instanceof TypeError) {
    // Check if it's a network-related TypeError
    if (error.message.includes('fetch') || error.message.includes('network') || error.message.includes('Failed to fetch')) {
      return createApiError(
        'Network error - failed to connect to server',
        ErrorCodes.NETWORK_ERROR,
        0
      );
    }
    return createApiError(
      error.message || 'Network error occurred',
      ErrorCodes.NETWORK_ERROR,
      0
    );
  }

  // Handle fetch Response errors - check if it has response property with status
  if (error && typeof error === 'object' && 'response' in error) {
    const fetchError = error as {
      response?: {
        status: number;
        statusText?: string;
      };
      status?: number;
      message?: string;
      details?: unknown;
    };

    const status = fetchError.response?.status || fetchError.status;
    if (status) {
      // `details` is carried through when present: a body may ship structured
      // detail without a machine-readable `code` (which is what routes the
      // error to the already-an-ApiError branch above), and dropping it here
      // would make it unreachable to every caller that rethrows via
      // `OxyServices.handleError`.
      return createApiError(
        fetchError.message || `HTTP ${status} error`,
        getErrorCodeFromStatus(status),
        status,
        isPlainRecord(fetchError.details) ? fetchError.details : undefined
      );
    }
  }

  // Handle standard errors
  if (error instanceof Error) {
    // Check for common error patterns
    if (error.message.includes('timeout') || error.message.includes('aborted')) {
      return createApiError(
        'Request timeout',
        ErrorCodes.TIMEOUT,
        0
      );
    }
    
    if (error.message.includes('network') || error.message.includes('fetch')) {
      return createApiError(
        error.message || 'Network error occurred',
        ErrorCodes.NETWORK_ERROR,
        0
      );
    }

    return createApiError(
      error.message || 'Unknown error occurred',
      ErrorCodes.INTERNAL_ERROR,
      500
    );
  }

  // Handle other errors - ensure we always return a non-empty message
  const errorString = error ? String(error) : '';
  const message = errorString.trim() || 'Unknown error occurred';
  return createApiError(
    message,
    ErrorCodes.INTERNAL_ERROR,
    500
  );
}

/**
 * Get error code from HTTP status
 * Exported for use in other modules
 */
export function getErrorCodeFromStatus(status: number): string {
  switch (status) {
    case 400:
      return ErrorCodes.BAD_REQUEST;
    case 401:
      return ErrorCodes.UNAUTHORIZED;
    case 403:
      return ErrorCodes.FORBIDDEN;
    case 404:
      return ErrorCodes.NOT_FOUND;
    case 409:
      return ErrorCodes.CONFLICT;
    case 422:
      return ErrorCodes.VALIDATION_ERROR;
    case 500:
      return ErrorCodes.INTERNAL_ERROR;
    case 503:
      return ErrorCodes.SERVICE_UNAVAILABLE;
    default:
      return ErrorCodes.INTERNAL_ERROR;
  }
}

/**
 * Best-effort extraction of an HTTP status code from a thrown value.
 *
 * `HttpService` annotates the errors it throws with both `error.status` and
 * `error.response.status`; an already-normalized {@link ApiError} carries
 * `error.status`. This reads either, returning `undefined` when the value is
 * not an object or carries no numeric status (e.g. a thrown string, a network
 * `TypeError`). Used by discovery/read paths to distinguish a 404 "not found"
 * from a transport/server failure for observability without re-deriving the
 * narrowing at every call site.
 */
export function extractErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const record = error as { status?: unknown; response?: { status?: unknown } };
  if (typeof record.status === 'number') {
    return record.status;
  }
  if (typeof record.response?.status === 'number') {
    return record.response.status;
  }
  return undefined;
}

/**
 * Validate required fields and throw error if missing
 */
export function validateRequiredFields(data: Record<string, unknown>, fields: string[]): void {
  const missing = fields.filter(field => !data[field]);
  
  if (missing.length > 0) {
    throw createApiError(
      `Missing required fields: ${missing.join(', ')}`,
      ErrorCodes.MISSING_PARAMETER,
      400
    );
  }
}

/**
 * Safe error logging with context
 */
export function logError(error: unknown, context?: string): void {
  if (error instanceof Error) {
    logger.error(error.message, {
      component: context || 'errorUtils',
      method: 'logError',
      stack: error.stack,
    });
  } else {
    logger.error(String(error), {
      component: context || 'errorUtils',
      method: 'logError',
    });
  }
}

 