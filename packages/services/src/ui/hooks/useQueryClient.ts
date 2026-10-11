import { useQueryClient as useTanStackQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';

/**
 * Custom hook to access the QueryClient
 * Provides type safety and ensures client is available
 */
export const useQueryClient = (): QueryClient => {
  const queryClient = useTanStackQueryClient();

  if (!queryClient) {
    throw new Error('QueryClient is not available. Make sure OxyProvider is wrapping your app.');
  }

  return queryClient;
};
