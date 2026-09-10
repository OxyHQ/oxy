import { handleHttpError, ErrorCodes, type ApiError } from '@oxy.so/core';

/** Narrow an unknown thrown value to its optional `code`/`message` fields. */
interface CodedError {
  code?: string;
  message?: string;
}

function asCodedError(error: unknown): CodedError {
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    return {
      code: typeof e.code === 'string' ? e.code : undefined,
      message: typeof e.message === 'string' ? e.message : undefined,
    };
  }
  return {};
}

/**
 * Whether a thrown value represents the "username required" signal that the
 * identity-sync flow raises when an account has no username yet. Checked by
 * code (`USERNAME_REQUIRED`) or, for older call sites, message equality.
 */
export function isUsernameRequiredError(error: unknown): boolean {
  const { code, message } = asCodedError(error);
  return code === 'USERNAME_REQUIRED' || message === 'USERNAME_REQUIRED';
}

/**
 * Check if an error is a network or timeout error using Oxy core utilities
 *
 * @param error - The error to check
 * @returns True if the error is a network or timeout error
 */
export function isNetworkOrTimeoutError(error: unknown): boolean {
  const apiError = handleHttpError(error);
  return (
    apiError.code === ErrorCodes.NETWORK_ERROR ||
    apiError.code === ErrorCodes.TIMEOUT ||
    apiError.code === ErrorCodes.CONNECTION_FAILED
  );
}

/**
 * Extract error message from an unknown error shape
 * Uses Oxy core error handling to standardize error messages
 * 
 * @param error - The error to extract message from
 * @param fallbackMessage - Fallback message if extraction fails
 * @returns The error message
 */
export function extractAuthErrorMessage(error: unknown, fallbackMessage = 'An error occurred'): string {
  const apiError = handleHttpError(error);
  return apiError.message || fallbackMessage;
}

/**
 * Handle authentication errors with context
 * 
 * @param error - The error to handle
 * @param context - Context where the error occurred
 * @returns The error message
 */
export function handleAuthError(error: unknown, context: string): string {
  const apiError = handleHttpError(error);
  
  // Log error details for debugging (in development)
  if (__DEV__) {
    console.warn(`[${context}] Auth error:`, {
      message: apiError.message,
      code: apiError.code,
      status: apiError.status,
    });
  }
  
  return apiError.message || `An error occurred in ${context}`;
}

