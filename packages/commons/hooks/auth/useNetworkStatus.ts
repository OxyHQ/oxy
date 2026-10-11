import { useState, useEffect, useCallback } from 'react';
import { checkIfOffline } from '@/utils/auth/networkUtils';

/**
 * Hook for managing network status
 *
 * @param checkOnMount - Whether to check network status on mount
 * @returns Network status state and check function
 */
export function useNetworkStatus(checkOnMount = false) {
  const [isOffline, setIsOffline] = useState<boolean>(false);

  const checkNetworkStatus = useCallback(async () => {
    const offline = await checkIfOffline();
    setIsOffline(offline);
    return offline;
  }, []);

  useEffect(() => {
    if (checkOnMount) {
      checkNetworkStatus();
    }
  }, [checkOnMount, checkNetworkStatus]);

  return {
    isOffline,
    checkNetworkStatus,
  };
}
