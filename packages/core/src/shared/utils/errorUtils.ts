/**
 * Error Utility Functions
 *
 * Consolidated error handling utilities for the OxyServices ecosystem.
 * These functions help with common error patterns like checking HTTP status codes.
 *
 * @module shared/utils/errorUtils
 */

/**
 * Common HTTP status codes used in error checking.
 */
export const HttpStatus = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
} as const;

/**
 * Extracts the HTTP status code from an error object.
 *
 * @param error - Any error object
 * @returns The status code if found, undefined otherwise
 */
export const getErrorStatus = (error: unknown): number | undefined => {
  if (!error || typeof error !== 'object') return undefined;

  const err = error as Record<string, unknown>;

  // Direct status property
  if (typeof err.status === 'number') return err.status;

  // Axios-style response.status
  if (err.response && typeof err.response === 'object') {
    const response = err.response as Record<string, unknown>;
    if (typeof response.status === 'number') return response.status;
  }

  // statusCode property (some libraries use this)
  if (typeof err.statusCode === 'number') return err.statusCode;

  return undefined;
};

/**
 * Extracts the error message from an error object.
 *
 * @param error - Any error object
 * @param fallback - Fallback message if none found
 * @returns The error message
 */
export const getErrorMessage = (error: unknown, fallback = 'An unknown error occurred'): string => {
  if (!error) return fallback;

  if (typeof error === 'string') return error;

  if (error instanceof Error) return error.message;

  if (typeof error === 'object') {
    const err = error as Record<string, unknown>;

    if (typeof err.message === 'string') return err.message;
    if (typeof err.error === 'string') return err.error;

    // Axios-style response.data.message
    if (err.response && typeof err.response === 'object') {
      const response = err.response as Record<string, unknown>;
      if (response.data && typeof response.data === 'object') {
        const data = response.data as Record<string, unknown>;
        if (typeof data.message === 'string') return data.message;
        if (typeof data.error === 'string') return data.error;
      }
    }
  }

  return fallback;
};

/**
 * Check if an error indicates the user is already registered (HTTP 409 Conflict).
 *
 * The backend should always return HTTP 409 for duplicate registrations.
 *
 * @param error - Any error object
 * @returns true if the error is a 409 Conflict
 */
export const isAlreadyRegisteredError = (error: unknown): boolean => {
  return getErrorStatus(error) === HttpStatus.CONFLICT;
};

/**
 * Check if an error is an authentication error (HTTP 401).
 *
 * @param error - Any error object
 * @returns true if the error is a 401 Unauthorized
 */
export const isUnauthorizedError = (error: unknown): boolean => {
  return getErrorStatus(error) === HttpStatus.UNAUTHORIZED;
};

/**
 * Check if an error is a forbidden error (HTTP 403).
 *
 * @param error - Any error object
 * @returns true if the error is a 403 Forbidden
 */
export const isForbiddenError = (error: unknown): boolean => {
  return getErrorStatus(error) === HttpStatus.FORBIDDEN;
};

/**
 * Check if an error is a not found error (HTTP 404).
 *
 * @param error - Any error object
 * @returns true if the error is a 404 Not Found
 */
export const isNotFoundError = (error: unknown): boolean => {
  return getErrorStatus(error) === HttpStatus.NOT_FOUND;
};

/**
 * Check if an error is a rate limit error (HTTP 429).
 *
 * @param error - Any error object
 * @returns true if the error is a 429 Too Many Requests
 */
export const isRateLimitError = (error: unknown): boolean => {
  return getErrorStatus(error) === HttpStatus.TOO_MANY_REQUESTS;
};

/**
 * Check if an error is a server error (HTTP 5xx).
 *
 * @param error - Any error object
 * @returns true if the error is a 5xx server error
 */
export const isServerError = (error: unknown): boolean => {
  const status = getErrorStatus(error);
  return status !== undefined && status >= 500 && status < 600;
};

/**
 * Check if an error is a network error (no response received).
 *
 * @param error - Any error object
 * @returns true if the error appears to be a network error
 */
export const isNetworkError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;

  const err = error as Record<string, unknown>;

  // Check for common network error indicators
  if (err.name === 'NetworkError') return true;
  if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT')
    return true;

  // Axios-style: has request but no response
  if (err.request && !err.response) return true;

  // Message-based detection
  const message = getErrorMessage(error, '').toLowerCase();
  return (
    message.includes('network') || message.includes('connection') || message.includes('timeout')
  );
};

/**
 * Check if an error is retryable (network errors or 5xx server errors).
 *
 * @param error - Any error object
 * @returns true if the request should be retried
 */
export const isRetryableError = (error: unknown): boolean => {
  return isNetworkError(error) || isServerError(error) || isRateLimitError(error);
};
