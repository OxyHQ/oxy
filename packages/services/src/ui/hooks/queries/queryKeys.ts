/**
 * Centralized query keys for TanStack Query
 *
 * Following best practices:
 * - Use arrays for hierarchical keys
 * - Include all parameters in the key
 * - Use consistent naming conventions
 */

import type { QueryClient } from '@tanstack/react-query';

export const queryKeys = {
  // Account queries
  accounts: {
    all: ['accounts'] as const,
    lists: () => [...queryKeys.accounts.all, 'list'] as const,
    list: (sessionIds: string[]) => [...queryKeys.accounts.lists(), sessionIds] as const,
    details: () => [...queryKeys.accounts.all, 'detail'] as const,
    detail: (sessionId: string) => [...queryKeys.accounts.details(), sessionId] as const,
    current: (sessionId?: string | null) =>
      sessionId
        ? ([...queryKeys.accounts.all, 'current', sessionId] as const)
        : ([...queryKeys.accounts.all, 'current'] as const),
    settings: () => [...queryKeys.accounts.all, 'settings'] as const,
  },

  // Session queries
  sessions: {
    all: ['sessions'] as const,
    lists: () => [...queryKeys.sessions.all, 'list'] as const,
    list: (userId?: string) => [...queryKeys.sessions.lists(), userId] as const,
    details: () => [...queryKeys.sessions.all, 'detail'] as const,
    detail: (sessionId: string) => [...queryKeys.sessions.details(), sessionId] as const,
    active: () => [...queryKeys.sessions.all, 'active'] as const,
    device: (deviceId: string) => [...queryKeys.sessions.all, 'device', deviceId] as const,
  },
} as const;

/**
 * Helper to invalidate all account-related queries
 */
export const invalidateAccountQueries = (queryClient: QueryClient): void => {
  queryClient.invalidateQueries({ queryKey: queryKeys.accounts.all });
};

/**
 * Helper to invalidate all session-related queries
 */
export const invalidateSessionQueries = (queryClient: QueryClient): void => {
  queryClient.invalidateQueries({ queryKey: queryKeys.sessions.all });
};
