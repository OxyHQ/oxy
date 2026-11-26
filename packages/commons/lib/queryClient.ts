import { QueryClient } from '@tanstack/react-query';

/**
 * Commons' own React Query client (the identity, the node, credentials,
 * vouches). `@oxy.so/services` 15 keeps its data in bloom-data and provides no
 * client, so the app holds its own, with the defaults the SDK's client gave it.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false,
      networkMode: 'offlineFirst',
    },
    mutations: {
      retry: false,
      networkMode: 'offlineFirst',
    },
  },
});
