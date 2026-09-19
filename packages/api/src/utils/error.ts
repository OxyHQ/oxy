/**
 * API Error Classes
 * 
 * Standardized error handling for consistent error responses across the API.
 */

/**
 * Common error codes used across the application
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
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  TIMEOUT: 'TIMEOUT',
  
  // Network errors
  NETWORK_ERROR: 'NETWORK_ERROR',
  CONNECTION_FAILED: 'CONNECTION_FAILED',
  
  // Unknown
  UNKNOWN_ERROR: 'UNKNOWN_ERROR',
} as const;

/**
 * Get error code from HTTP status code
 */
export function getErrorCodeFromStatus(statusCode: number): string {
  const codes: Record<number, string> = {
    400: ErrorCodes.BAD_REQUEST,
    401: ErrorCodes.UNAUTHORIZED,
    403: ErrorCodes.FORBIDDEN,
    404: ErrorCodes.NOT_FOUND,
    409: ErrorCodes.CONFLICT,
    422: ErrorCodes.VALIDATION_ERROR,
    500: ErrorCodes.INTERNAL_SERVER_ERROR,
    503: ErrorCodes.SERVICE_UNAVAILABLE,
  };
  return codes[statusCode] || ErrorCodes.UNKNOWN_ERROR;
}

export class ApiError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    statusCode: number,
    message: string,
    code?: string,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code || getErrorCodeFromStatus(statusCode);
    this.details = details;
    this.name = 'ApiError';
    
    // Maintains proper stack trace for where error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      ...(this.details && { details: this.details }),
    };
  }
}

export class BadRequestError extends ApiError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(400, message, ErrorCodes.BAD_REQUEST, details);
    this.name = 'BadRequestError';
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = 'Authentication required', details?: Record<string, unknown>) {
    super(401, message, ErrorCodes.UNAUTHORIZED, details);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends ApiError {
  constructor(message = 'Access forbidden', details?: Record<string, unknown>) {
    super(403, message, ErrorCodes.FORBIDDEN, details);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends ApiError {
  constructor(message = 'Resource not found', details?: Record<string, unknown>) {
    super(404, message, ErrorCodes.NOT_FOUND, details);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends ApiError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(409, message, ErrorCodes.CONFLICT, details);
    this.name = 'ConflictError';
  }
}

export class ValidationError extends ApiError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(422, message, ErrorCodes.VALIDATION_ERROR, details);
    this.name = 'ValidationError';
  }
}

export class InternalServerError extends ApiError {
  constructor(message = 'Internal server error', details?: Record<string, unknown>) {
    super(500, message, ErrorCodes.INTERNAL_SERVER_ERROR, details);
    this.name = 'InternalServerError';
  }
}

/**
 * The request was well-formed and authorised, but a dependency this server
 * needs is absent or misconfigured, so it cannot be served AT ALL — and
 * retrying the same request changes nothing until an operator acts.
 *
 * Distinct from {@link InternalServerError}, which says "something went wrong
 * here"; this says "this capability is not configured". Outbound email uses it
 * when no SMTP relay is set: answering 202 "queued" to a message that can never
 * leave is worse than answering 503, because the sender is told it was sent.
 */
export class ServiceUnavailableError extends ApiError {
  constructor(message = 'Service unavailable', details?: Record<string, unknown>) {
    super(503, message, ErrorCodes.SERVICE_UNAVAILABLE, details);
    this.name = 'ServiceUnavailableError';
  }
}

/**
 * Handle HTTP errors and convert to ApiError
 * Useful for converting axios errors and other HTTP errors to ApiError instances
 */
export function handleHttpError(error: unknown): ApiError {
  // If it's already an ApiError, return it
  if (error instanceof ApiError) {
    return error;
  }

  // Handle axios errors
  if (error && typeof error === 'object' && 'response' in error) {
    const axiosError = error as { response?: { status: number; data?: { message?: string; error?: string; code?: string } } };
    if (axiosError.response) {
      const { status, data } = axiosError.response;
      const message = data?.message || data?.error || `HTTP ${status} error`;
      const code = data?.code || getErrorCodeFromStatus(status);
      
      return new ApiError(status, message, code, data);
    }
  }

  // Handle network errors (no response received)
  if (error && typeof error === 'object' && 'request' in error && !('response' in error)) {
    return new ApiError(0, 'Network error - no response received', ErrorCodes.NETWORK_ERROR);
  }

  // Handle standard errors
  if (error instanceof Error) {
    return new InternalServerError(error.message || 'Unknown error occurred');
  }

  // Handle other errors
  return new InternalServerError(String(error) || 'Unknown error occurred');
} 