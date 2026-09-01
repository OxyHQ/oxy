/**
 * Mutation Factory - Creates standardized mutations with optimistic updates
 *
 * This factory reduces boilerplate code for mutations that follow the common pattern:
 * 1. Cancel outgoing queries
 * 2. Snapshot previous data
 * 3. Apply optimistic update
 * 4. On error: rollback and show toast
 * 5. On success: update cache, stores, and invalidate queries
 */

import type { QueryClient, UseMutationOptions } from '@tanstack/react-query';
import type { User } from '@oxyhq/core';
import { queryKeys, invalidateAccountQueries, invalidateUserQueries } from '../queries/queryKeys';
import { toast } from '@oxyhq/bloom/toast';
import { useAuthStore } from '../../stores/authStore';

/**
 * Configuration for creating a standard profile mutation
 */
export interface ProfileMutationConfig<TData, TVariables> {
  /** The mutation function that makes the API call */
  mutationFn: (variables: TVariables) => Promise<TData>;
  /**
   * Stable mutation key for the offline queue. Required so TanStack Query
   * can correlate paused mutations across refetches/resume cycles.
   */
  mutationKey: readonly unknown[];
  /** Query keys to cancel before mutation */
  cancelQueryKeys?: unknown[][];
  /** Function to apply optimistic update to the user data */
  optimisticUpdate?: (previousUser: User, variables: TVariables) => Partial<User>;
  /** Error message to show on failure */
  errorMessage?: string | ((error: Error) => string);
  /** Success message to show (optional) */
  successMessage?: string;
  /** Whether to update authStore on success (default: true) */
  updateAuthStore?: boolean;
  /** Whether to invalidate user queries on success (default: true) */
  invalidateUserQueries?: boolean;
  /** Whether to invalidate account queries on success (default: true) */
  invalidateAccountQueries?: boolean;
  /** Custom onSuccess handler */
  onSuccess?: (data: TData, variables: TVariables, queryClient: QueryClient) => void;
}

/**
 * Creates a standard profile mutation with optimistic updates
 *
 * @example
 * ```ts
 * const updateProfile = createProfileMutation({
 *   mutationKey: mutationKeys.account.updateProfile,
 *   mutationFn: (updates) => oxyServices.updateProfile(updates),
 *   optimisticUpdate: (user, updates) => updates,
 *   errorMessage: 'Failed to update profile',
 * });
 * ```
 */
export function createProfileMutation<TVariables>(
  config: ProfileMutationConfig<User, TVariables>,
  queryClient: QueryClient,
  activeSessionId: string | null
): UseMutationOptions<User, Error, TVariables, { previousUser?: User }> {
  const {
    mutationFn,
    mutationKey,
    cancelQueryKeys = [],
    optimisticUpdate,
    errorMessage = 'Operation failed',
    successMessage,
    updateAuthStore = true,
    invalidateUserQueries: shouldInvalidateUserQueries = true,
    invalidateAccountQueries: shouldInvalidateAccountQueries = true,
    onSuccess: customOnSuccess,
  } = config;

  return {
    mutationKey: [...mutationKey],
    mutationFn,

    onMutate: async (variables) => {
      // Cancel queries that might conflict
      await queryClient.cancelQueries({ queryKey: queryKeys.accounts.current(activeSessionId) });
      for (const key of cancelQueryKeys) {
        await queryClient.cancelQueries({ queryKey: key });
      }

      // Snapshot previous user data
      const previousUser = queryClient.getQueryData<User>(queryKeys.accounts.current(activeSessionId));

      // Apply optimistic update if provided
      if (previousUser && optimisticUpdate) {
        const updates = optimisticUpdate(previousUser, variables);
        const optimisticUser = { ...previousUser, ...updates };

        queryClient.setQueryData<User>(queryKeys.accounts.current(activeSessionId), optimisticUser);

        if (activeSessionId) {
          queryClient.setQueryData<User>(queryKeys.users.profile(activeSessionId), optimisticUser);
        }
      }

      return { previousUser };
    },

    onError: (error, _variables, context) => {
      // Rollback optimistic update
      if (context?.previousUser) {
        queryClient.setQueryData(queryKeys.accounts.current(activeSessionId), context.previousUser);
        if (activeSessionId) {
          queryClient.setQueryData(queryKeys.users.profile(activeSessionId), context.previousUser);
        }
      }

      // Show error toast
      const message = typeof errorMessage === 'function'
        ? errorMessage(error)
        : (error instanceof Error ? error.message : errorMessage);
      toast.error(message);
    },

    onSuccess: (data, variables) => {
      // Update cache with server response
      queryClient.setQueryData(queryKeys.accounts.current(activeSessionId), data);
      if (activeSessionId) {
        queryClient.setQueryData(queryKeys.users.profile(activeSessionId), data);
      }

      // Update authStore for immediate UI updates
      if (updateAuthStore) {
        useAuthStore.getState().setUser(data);
      }

      // Invalidate related queries
      if (shouldInvalidateUserQueries) {
        invalidateUserQueries(queryClient);
      }
      if (shouldInvalidateAccountQueries) {
        invalidateAccountQueries(queryClient);
      }

      // Show success toast if configured
      if (successMessage) {
        toast.success(successMessage);
      }

      // Call custom onSuccess handler
      if (customOnSuccess) {
        customOnSuccess(data, variables, queryClient);
      }
    },
  };
}

/**
 * Configuration for creating a generic mutation (non-profile)
 */
export interface GenericMutationConfig<TData, TVariables, TContext> {
  /** The mutation function */
  mutationFn: (variables: TVariables) => Promise<TData>;
  /**
   * Stable mutation key for the offline queue. Required so TanStack Query
   * can correlate paused mutations across refetches/resume cycles.
   */
  mutationKey: readonly unknown[];
  /** Query key for optimistic data */
  queryKey: unknown[];
  /** Function to create optimistic data */
  optimisticData?: (previous: TData | undefined, variables: TVariables) => TData;
  /** Error message */
  errorMessage?: string;
  /** Success message */
  successMessage?: string;
  /** Additional queries to invalidate on success */
  invalidateQueries?: unknown[][];
}

/**
 * Creates a generic mutation with optimistic updates
 */
export function createGenericMutation<TData, TVariables>(
  config: GenericMutationConfig<TData, TVariables, { previous?: TData }>,
  queryClient: QueryClient
): UseMutationOptions<TData, Error, TVariables, { previous?: TData }> {
  const {
    mutationFn,
    mutationKey,
    queryKey,
    optimisticData,
    errorMessage = 'Operation failed',
    successMessage,
    invalidateQueries = [],
  } = config;

  return {
    mutationKey: [...mutationKey],
    mutationFn,

    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<TData>(queryKey);

      if (optimisticData) {
        queryClient.setQueryData<TData>(queryKey, optimisticData(previous, variables));
      }

      return { previous };
    },

    onError: (error, _variables, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(queryKey, context.previous);
      }
      toast.error(error instanceof Error ? error.message : errorMessage);
    },

    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);

      for (const key of invalidateQueries) {
        queryClient.invalidateQueries({ queryKey: key });
      }

      if (successMessage) {
        toast.success(successMessage);
      }
    },
  };
}
