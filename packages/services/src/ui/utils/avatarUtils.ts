import { authenticatedApiCall } from '@oxyhq/core';
import type { OxyServices, User } from '@oxyhq/core';
import type { UserProfileUpdate } from '@oxyhq/contracts';
import { useAuthStore } from '../stores/authStore';
import type { QueryClient } from '@tanstack/react-query';
import { queryKeys, invalidateUserQueries, invalidateAccountQueries } from '../hooks/queries/queryKeys';
import {
  clearedFieldsFromProfileUpdate,
  upsertCachedUser,
} from '../hooks/queries/userCache';

/**
 * Updates user profile with avatar and handles all side effects (cache writes,
 * query invalidation). Usable from inside the provider without `useOxy`.
 *
 * @param updates - Profile updates including avatar
 * @param oxyServices - OxyServices instance
 * @param activeSessionId - Active session ID
 * @param queryClient - TanStack Query client
 * @param syncSession - Optional function to sync session/refresh token when auth errors occur
 * @returns Promise that resolves with updated user data
 */
export async function updateProfileWithAvatar(
  updates: UserProfileUpdate,
  oxyServices: OxyServices,
  activeSessionId: string | null,
  queryClient: QueryClient,
  syncSession?: () => Promise<User>
): Promise<User> {
  const data = await authenticatedApiCall<User>(
    oxyServices,
    activeSessionId,
    () => oxyServices.updateProfile(updates),
    syncSession
  );

  // Update cache with server response
  queryClient.setQueryData(queryKeys.accounts.current(activeSessionId), data);
  if (activeSessionId) {
    queryClient.setQueryData(queryKeys.users.profile(activeSessionId), data);
  }

  // Update authStore so frontend components see the changes immediately
  useAuthStore.getState().setUser(data);

  const cleared = clearedFieldsFromProfileUpdate(updates);
  upsertCachedUser(queryClient, data, data.id, {
    cleared: cleared.length > 0 ? cleared : undefined,
  });

  // Invalidate all related queries to refresh everywhere
  invalidateUserQueries(queryClient);
  invalidateAccountQueries(queryClient);

  return data;
}
