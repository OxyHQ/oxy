import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { queryKeys } from './queryKeys';
import { useOxy } from '../../context/OxyContext';
import type { SecurityActivity, SecurityActivityResponse, SecurityEventType } from '@oxy.so/core';

/**
 * Get user's security activity with pagination
 */
export const useSecurityActivity = (
  options?: {
    limit?: number;
    offset?: number;
    eventType?: SecurityEventType;
    enabled?: boolean;
  }
) => {
  const { oxyServices, activeSessionId } = useOxy();

  return useQuery({
    queryKey: queryKeys.security.activity(
      options?.limit,
      options?.offset,
      options?.eventType
    ),
    queryFn: async () => {
      if (!activeSessionId) {
        throw new Error('No active session');
      }

      const response = await oxyServices.getSecurityActivity(
        options?.limit,
        options?.offset,
        options?.eventType
      );

      return response;
    },
    enabled: (options?.enabled !== false) && !!activeSessionId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
};

/**
 * Get recent security activity (convenience hook)
 */
export const useRecentSecurityActivity = (limit = 10) => {
  const { oxyServices, activeSessionId } = useOxy();

  return useQuery<SecurityActivity[]>({
    queryKey: queryKeys.security.recent(limit),
    queryFn: async () => {
      if (!activeSessionId) {
        throw new Error('No active session');
      }

      return await oxyServices.getRecentSecurityActivity(limit);
    },
    enabled: !!activeSessionId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
};

/**
 * Get user's security activity with infinite pagination.
 * Each page returns up to `limit` events; `getNextPageParam` walks the
 * `offset` cursor until the API reports `hasMore: false`.
 */
export const useInfiniteSecurityActivity = (
  options?: {
    limit?: number;
    eventType?: SecurityEventType;
    enabled?: boolean;
  }
) => {
  const { oxyServices, activeSessionId } = useOxy();
  const limit = options?.limit ?? 30;

  return useInfiniteQuery<SecurityActivityResponse, Error>({
    queryKey: queryKeys.security.infinite(limit, options?.eventType),
    queryFn: async ({ pageParam }) => {
      if (!activeSessionId) {
        throw new Error('No active session');
      }

      const offset = typeof pageParam === 'number' ? pageParam : 0;
      return await oxyServices.getSecurityActivity(
        limit,
        offset,
        options?.eventType
      );
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage) => {
      if (!lastPage.hasMore) return undefined;
      return lastPage.offset + lastPage.limit;
    },
    enabled: (options?.enabled !== false) && !!activeSessionId,
    staleTime: 5 * 60 * 1000, // 5 minutes
    gcTime: 10 * 60 * 1000, // 10 minutes
  });
};

