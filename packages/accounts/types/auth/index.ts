import type { ApiError } from '@oxy.so/core';

/**
 * Authentication step type
 */
export type AuthStep = 'creating' | 'username' | 'notifications' | 'import';

/**
 * Network status type
 */
export type NetworkStatus = 'online' | 'offline' | 'unknown';

/**
 * Username validation result
 */
export interface UsernameValidationResult {
  isValid: boolean;
  isAvailable: boolean | null; // null = not checked yet
  error: string | null;
  isChecking: boolean;
}

/**
 * Authentication error interface extending ApiError
 */
export interface AuthError extends ApiError {
  context?: string;
  step?: AuthStep;
}

/**
 * Username availability check result
 */
export interface UsernameAvailabilityResult {
  available: boolean;
  message?: string;
}

