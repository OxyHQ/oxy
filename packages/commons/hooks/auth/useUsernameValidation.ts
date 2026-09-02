import { useState, useEffect, useCallback } from 'react';
import type { OxyServices } from '@oxyhq/core';
import { isValidUsername, USERNAME_MIN_LENGTH, USERNAME_INVALID_MESSAGE } from '@oxyhq/contracts';
import { USERNAME_DEBOUNCE_MS } from '@/constants/auth';
import { isNetworkOrTimeoutError, extractAuthErrorMessage } from '@/utils/auth/errorUtils';
import type { UsernameValidationResult } from '@/types/auth';

/**
 * Hook for username validation with debouncing and availability checking
 * 
 * @param username - The username to validate
 * @param oxyServices - OxyServices instance for API calls
 * @returns Username validation state and result
 */
export function useUsernameValidation(
  username: string,
  oxyServices: OxyServices | null
): UsernameValidationResult {
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  useEffect(() => {
    // Reset state if username is too short
    if (!username || username.length < USERNAME_MIN_LENGTH) {
      setIsAvailable(null);
      setError(null);
      setIsChecking(false);
      return;
    }

    // Validate format
    if (!isValidUsername(username)) {
      setError(USERNAME_INVALID_MESSAGE);
      setIsAvailable(false);
      setIsChecking(false);
      return;
    }

    setError(null);

    // Debounce API check
    const timer = setTimeout(async () => {
      if (!oxyServices) {
        return;
      }

      setIsChecking(true);
      try {
        const result = await oxyServices.checkUsernameAvailability(username);
        setIsAvailable(result.available);
        if (!result.available) {
          setError(result.message || 'Username is already taken');
        }
      } catch (err: unknown) {
        // Handle timeout and network errors gracefully
        if (isNetworkOrTimeoutError(err)) {
          // Allow proceeding if offline/network issue
          setIsAvailable(true);
        } else {
          setIsAvailable(false);
          setError(extractAuthErrorMessage(err, 'Failed to check username availability'));
        }
      } finally {
        setIsChecking(false);
      }
    }, USERNAME_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [username, oxyServices]);

  return {
    isValid: isValidUsername(username),
    isAvailable,
    error,
    isChecking,
  };
}

