import { useEffect, useRef } from 'react';
import { isTimeoutOrNetworkError } from '@oxy.so/services';
import type { OxyServices } from '@oxy.so/core';
import { isUsernameRequiredError } from '@/utils/auth/errorUtils';
import {
  createCircuitBreakerState,
  recordFailure,
  recordSuccess,
  type CircuitBreakerState,
} from './reconnectPolicy';
import { getIdentitySyncStateFromStorage } from './identityStore';

export interface UseNetworkReconnectOptions {
  /** OxyServices instance */
  oxyServices: OxyServices | null;
  /** Whether user is authenticated */
  isAuthenticated: boolean;
  /** Function to check if identity exists */
  hasIdentity: () => Promise<boolean>;
  /** Function to sync identity */
  syncIdentity: () => Promise<unknown>;
  /** Whether sync is already in progress (from sync lock) */
  isSyncing: boolean;
}

/**
 * Hook that monitors network connectivity and automatically syncs identity when online.
 * 
 * Features:
 * - Circuit breaker pattern to prevent excessive retries
 * - Exponential backoff for failed network checks
 * - Automatic sync when coming back online
 * - Respects sync lock to prevent concurrent operations
 */
export const useNetworkReconnect = (options: UseNetworkReconnectOptions): void => {
  const {
    oxyServices,
    isAuthenticated,
    hasIdentity,
    syncIdentity,
    isSyncing,
  } = options;

  const wasOfflineRef = useRef(false);
  const checkTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const circuitBreakerRef = useRef<CircuitBreakerState>(
    createCircuitBreakerState()
  );

  useEffect(() => {
    if (!oxyServices) return;

    const scheduleNextCheck = () => {
      if (checkTimeoutRef.current) {
        clearTimeout(checkTimeoutRef.current);
      }
      checkTimeoutRef.current = setTimeout(() => {
        checkNetworkAndSync();
      }, circuitBreakerRef.current.currentInterval) as unknown as NodeJS.Timeout;
    };

    const checkNetworkAndSync = async () => {
      try {
        // Skip if sync is already in progress or user is already authenticated
        if (isSyncing || isAuthenticated) {
          scheduleNextCheck();
          return;
        }

        // Try a lightweight health check to see if we're online
        await oxyServices.healthCheck().catch(() => {
          wasOfflineRef.current = true;
          throw new Error('Health check failed');
        });

        // Health check succeeded - reset circuit breaker and backoff
        circuitBreakerRef.current = recordSuccess(circuitBreakerRef.current);

        // If we were offline and now we're online, sync identity if needed
        if (wasOfflineRef.current && !isAuthenticated) {
          // Sync identity first (if not synced)
          try {
            const hasIdentityValue = await hasIdentity();
            if (hasIdentityValue && !isSyncing) {
              // Check sync status directly from secure storage - sync if not explicitly 'true'
              const syncStatus = await getIdentitySyncStateFromStorage();
              if (!syncStatus) {
                await syncIdentity();
              }
            }
          } catch (syncError: unknown) {
            // Skip sync silently if username is required (expected when offline onboarding)
            if (isUsernameRequiredError(syncError)) {
              // Don't log or show error - username will be set later
            } else if (!isTimeoutOrNetworkError(syncError)) {
              // Only log unexpected errors
              if (__DEV__) {
                console.warn('[useNetworkReconnect] Error syncing identity on reconnect', syncError);
              }
            }
          }

          wasOfflineRef.current = false;
        }
      } catch {
        // Network check failed - we're offline
        wasOfflineRef.current = true;

        // Update circuit breaker state
        circuitBreakerRef.current = recordFailure(circuitBreakerRef.current);
      } finally {
        // Always schedule next check (will use updated interval)
        scheduleNextCheck();
      }
    };

    // Check immediately
    checkNetworkAndSync();

    return () => {
      if (checkTimeoutRef.current) {
        clearTimeout(checkTimeoutRef.current);
        checkTimeoutRef.current = null;
      }
    };
  }, [oxyServices, syncIdentity, isAuthenticated, hasIdentity, isSyncing]);
};
