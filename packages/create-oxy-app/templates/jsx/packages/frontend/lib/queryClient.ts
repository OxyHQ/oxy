import { QueryClient } from '@tanstack/react-query';

/**
 * The app's React Query client, passed to `OxyProvider`. Offline-first so
 * queries and mutations queue and replay when connectivity returns (the SDK's
 * persistence layer restores the cache on cold boot).
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: 'offlineFirst',
      staleTime: 60_000,
      retry: 2,
    },
    mutations: {
      networkMode: 'offlineFirst',
    },
  },
});
