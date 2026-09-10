import { useQuery } from '@tanstack/react-query';
import { authenticatedApiCall } from '@oxy.so/core';
import type { AccountStorageUsageResponse, ClientSession } from '@oxy.so/core';
import { queryKeys } from './queryKeys';
import { useOxy } from '../../context/OxyContext';
import { fetchSessionsWithFallback, mapSessionsToClient } from '../../utils/sessionHelpers';

// Per-account query scope. In the real-session switch model the active session
// id uniquely identifies the active account (switching mints a new session), so
// it alone scopes the cache — no separate acting-as key is needed.
const accountQueryScope = (activeSessionId: string | null): string =>
  `${activeSessionId ?? 'no-session'}`;

/**
 * Get all active sessions for the current user
 */
export const useSessions = (userId?: string, options?: { enabled?: boolean }) => {
  const { oxyServices, activeSessionId } = useOxy();

  return useQuery({
    queryKey: queryKeys.sessions.list(userId),
    queryFn: async () => {
      if (!activeSessionId) {
        throw new Error('No active session');
      }
      
      const sessions = await fetchSessionsWithFallback(oxyServices, activeSessionId, {
        fallbackDeviceId: undefined,
        fallbackUserId: userId,
      });
      
      return mapSessionsToClient(sessions, activeSessionId);
    },
    enabled: (options?.enabled !== false) && !!activeSessionId,
    staleTime: 2 * 60 * 1000, // 2 minutes (sessions change frequently)
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
};

/**
 * Get specific session by ID
 */
export const useSession = (sessionId: string | null, options?: { enabled?: boolean }) => {
  const { oxyServices } = useOxy();

  return useQuery({
    queryKey: queryKeys.sessions.detail(sessionId || ''),
    queryFn: async () => {
      if (!sessionId) {
        throw new Error('Session ID is required');
      }
      
      const validation = await oxyServices.validateSession(sessionId, { useHeaderValidation: true });
      if (!validation?.valid || !validation.user) {
        throw new Error('Session not found or invalid');
      }

      const now = new Date();
      return {
        sessionId,
        deviceId: '', // Device ID not available from validation response
        expiresAt: validation.expiresAt || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        lastActive: validation.lastActivity || now.toISOString(),
        userId: validation.user.id?.toString() ?? '',
        isCurrent: false,
      } as ClientSession;
    },
    enabled: (options?.enabled !== false) && !!sessionId,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
};

/**
 * Get device sessions for the current active session
 */
export const useDeviceSessions = (options?: { enabled?: boolean }) => {
  const { oxyServices, activeSessionId } = useOxy();

  return useQuery({
    queryKey: queryKeys.sessions.active(),
    queryFn: async () => {
      if (!activeSessionId) {
        throw new Error('No active session');
      }
      
      return await oxyServices.getDeviceSessions(activeSessionId);
    },
    enabled: (options?.enabled !== false) && !!activeSessionId,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  });
};

/**
 * Get user devices
 */
export const useUserDevices = (options?: { enabled?: boolean }) => {
  const { oxyServices, isAuthenticated, activeSessionId } = useOxy();

  return useQuery({
    queryKey: queryKeys.devices.list(accountQueryScope(activeSessionId)),
    queryFn: async () => {
      return authenticatedApiCall(
        oxyServices,
        activeSessionId,
        () => oxyServices.getUserDevices()
      );
    },
    enabled: (options?.enabled !== false) && isAuthenticated && !!activeSessionId,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
};

/**
 * Get security information
 */
export const useSecurityInfo = (options?: { enabled?: boolean }) => {
  const { oxyServices, isAuthenticated } = useOxy();

  return useQuery({
    queryKey: [...queryKeys.devices.all, 'security'],
    queryFn: async () => {
      return await oxyServices.getSecurityInfo();
    },
    enabled: (options?.enabled !== false) && isAuthenticated,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
};

/**
 * Get account storage usage (server-aggregated usage across assets, mail,
 * recordings, etc.). Wraps `oxyServices.getAccountStorageUsage()` in a
 * TanStack query so consumers get caching, background refetch, and a
 * consistent `isLoading` / `refetch` surface instead of hand-rolled
 * `useEffect` fetches.
 */
export const useAccountStorageUsage = (options?: { enabled?: boolean }) => {
  const { oxyServices, isAuthenticated, activeSessionId } = useOxy();

  return useQuery<AccountStorageUsageResponse>({
    queryKey: queryKeys.storage.usage(accountQueryScope(activeSessionId)),
    queryFn: async () => {
      return authenticatedApiCall(
        oxyServices,
        activeSessionId,
        () => oxyServices.getAccountStorageUsage()
      );
    },
    enabled: (options?.enabled !== false) && isAuthenticated && !!activeSessionId,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });
};

