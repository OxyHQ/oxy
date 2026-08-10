import { useMutation, useQueryClient } from '@tanstack/react-query';
import { authenticatedApiCall } from '@oxyhq/core';
import type {
  AssetUploadInput,
  NotificationPreferences,
  PrivacySettings,
  User,
  UserPreferences,
} from '@oxyhq/core';
import type { UserProfileUpdate } from '@oxyhq/contracts';
import {
  queryKeys,
  invalidateAccountQueries,
  invalidateConnectedAppsQueries,
  invalidateUserQueries,
  invalidateSessionQueries,
} from '../queries/queryKeys';
import { mutationKeys } from './mutationKeys';
import { useOxy } from '../../context/OxyContext';
import { toast } from '@oxyhq/bloom/toast';
import { useAuthStore } from '../../stores/authStore';
import {
  clearedFieldsFromProfileUpdate,
  upsertCachedUser,
} from '../queries/userCache';

/**
 * Update user profile with optimistic updates and offline queue support
 */
export const useUpdateProfile = () => {
  const { oxyServices, activeSessionId, user } = useOxy();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: [...mutationKeys.account.updateProfile],
    mutationFn: async (updates: UserProfileUpdate) => {
      return authenticatedApiCall<User>(
        oxyServices,
        activeSessionId,
        () => oxyServices.updateProfile(updates)
      );
    },
    // Optimistic update
    onMutate: async (updates) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: queryKeys.accounts.current(activeSessionId) });

      // Snapshot previous value
      const previousUser = queryClient.getQueryData<User>(queryKeys.accounts.current(activeSessionId));

      // Optimistically update
      if (previousUser) {
        const optimisticUser: User = {
          ...previousUser,
          ...updates,
          name: updates.name
            ? { ...previousUser.name, ...updates.name }
            : previousUser.name,
        };
        queryClient.setQueryData<User>(queryKeys.accounts.current(activeSessionId), optimisticUser);

        // Also update profile query if sessionId is available
        if (activeSessionId) {
          queryClient.setQueryData<User>(queryKeys.users.profile(activeSessionId), optimisticUser);
        }
      }

      return { previousUser };
    },
    // On error, rollback ONLY the keys this mutation tried to change
    onError: (error, updates, context) => {
      if (context?.previousUser && updates) {
        const previousUser = context.previousUser;
        const changedKeys = Object.keys(updates) as Array<keyof User>;
        const partialRollback = changedKeys.reduce<Partial<User>>((acc, key) => {
          (acc as Record<string, unknown>)[key as string] = previousUser[key];
          return acc;
        }, {});

        const current = queryClient.getQueryData<User>(queryKeys.accounts.current(activeSessionId));
        if (current) {
          queryClient.setQueryData<User>(queryKeys.accounts.current(activeSessionId), {
            ...current,
            ...partialRollback,
          });
        }
        if (activeSessionId) {
          const currentProfile = queryClient.getQueryData<User>(queryKeys.users.profile(activeSessionId));
          if (currentProfile) {
            queryClient.setQueryData<User>(queryKeys.users.profile(activeSessionId), {
              ...currentProfile,
              ...partialRollback,
            });
          }
        }
      }
      toast.error(error instanceof Error ? error.message : 'Failed to update profile');
    },
    // On success, invalidate and refetch
    onSuccess: (data, updates) => {
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

      // Invalidate all related queries so every consumer (the account dialog,
      // session lists, managed accounts, etc.) refetches the fresh profile.
      // This is critical right after `username` is set the first time, when
      // every cached "session profile" still reports the user as unnamed.
      invalidateUserQueries(queryClient);
      invalidateAccountQueries(queryClient);
      invalidateSessionQueries(queryClient);
    },
  });
};

/**
 * Upload avatar with progress tracking and offline queue support
 */
export const useUploadAvatar = () => {
  const { oxyServices, activeSessionId } = useOxy();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: [...mutationKeys.account.uploadAvatar],
    mutationFn: async (file: { uri: string; type?: string; name?: string; size?: number }) => {
      return authenticatedApiCall<User>(oxyServices, activeSessionId, async () => {
        const uploadResult = await oxyServices.assetUpload(file, 'public');
        const fileId = uploadResult?.file?.id;

        if (!fileId || typeof fileId !== 'string') {
          throw new Error('Upload succeeded but response did not contain a file ID');
        }

        // Update profile with file ID
        return await oxyServices.updateProfile({ avatar: fileId });
      });
    },
    onMutate: async (file) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.accounts.current(activeSessionId) });
      const previousUser = queryClient.getQueryData<User>(queryKeys.accounts.current(activeSessionId));

      // Optimistically set a temporary avatar (using file URI as placeholder)
      if (previousUser) {
        const optimisticUser = {
          ...previousUser,
          avatar: file.uri, // Temporary, will be replaced with fileId
        };
        queryClient.setQueryData<User>(queryKeys.accounts.current(activeSessionId), optimisticUser);
        if (activeSessionId) {
          queryClient.setQueryData<User>(queryKeys.users.profile(activeSessionId), optimisticUser);
        }
      }

      return { previousUser };
    },
    onError: (error, _file, context) => {
      // Avatar upload only mutates the `avatar` field — restore only that key
      if (context?.previousUser) {
        const previousAvatar = context.previousUser.avatar;
        const current = queryClient.getQueryData<User>(queryKeys.accounts.current(activeSessionId));
        if (current) {
          queryClient.setQueryData<User>(queryKeys.accounts.current(activeSessionId), {
            ...current,
            avatar: previousAvatar,
          });
        }
        if (activeSessionId) {
          const currentProfile = queryClient.getQueryData<User>(queryKeys.users.profile(activeSessionId));
          if (currentProfile) {
            queryClient.setQueryData<User>(queryKeys.users.profile(activeSessionId), {
              ...currentProfile,
              avatar: previousAvatar,
            });
          }
        }
      }
      toast.error(error instanceof Error ? error.message : 'Failed to upload avatar');
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.accounts.current(activeSessionId), data);
      if (activeSessionId) {
        queryClient.setQueryData(queryKeys.users.profile(activeSessionId), data);
      }
      
      // Update authStore so frontend components see the changes immediately
      useAuthStore.getState().setUser(data);
      
      // Invalidate all related queries to refresh everywhere, including the
      // sessions cache so other-account avatars update too.
      invalidateUserQueries(queryClient);
      invalidateAccountQueries(queryClient);
      invalidateSessionQueries(queryClient);
      toast.success('Avatar updated successfully');
    },
  });
};

/**
 * Variables accepted by the `useUpdateAccountSettings` mutation.
 *
 * `currentUser` is captured at dispatch time so the rebuilt user object the
 * mutation returns is computed against a stable snapshot — NOT the cache
 * value at the moment the API call settles. Reading from the cache inside
 * `mutationFn` would race with sibling optimistic updates: a concurrent
 * write could already have overwritten the cache by the time the privacy
 * update returns, causing the rebuilt user to clobber the sibling's
 * optimistic value.
 */
interface UpdateAccountSettingsVariables {
  /** Subset of privacy fields to write. */
  updates: Partial<PrivacySettings>;
  /**
   * The User snapshot captured at mutation dispatch time. The mutation
   * rebuilds this user with the updated `privacySettings` and returns it
   * to `onSuccess`. Required to avoid the race described above.
   */
  currentUser: User;
}

/**
 * Update account settings (privacy preferences).
 *
 * Privacy settings are not part of the `PUT /users/me` allow-list; the API
 * would silently drop them. Route through `updatePrivacySettings` so the
 * dedicated `PATCH /privacy/:id/privacy` endpoint performs a dot-path merge
 * and returns the updated `privacySettings` object.
 *
 * The returned object exposes the standard mutation surface PLUS a
 * convenience `mutate(updates)` / `mutateAsync(updates)` that snapshots
 * the current user from `useOxy()` at dispatch time. Callers that need to
 * supply their own user snapshot (testing, server-side) can call the
 * underlying `.mutate({ updates, currentUser })` form via `.mutation`.
 */
export const useUpdateAccountSettings = () => {
  const { oxyServices, activeSessionId, user } = useOxy();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationKey: [...mutationKeys.account.updateSettings],
    mutationFn: async ({ updates, currentUser }: UpdateAccountSettingsVariables) => {
      const userId = currentUser.id;
      if (!userId) {
        throw new Error('User ID is required to update account settings');
      }
      const updatedPrivacy = await authenticatedApiCall<PrivacySettings>(
        oxyServices,
        activeSessionId,
        () => oxyServices.updatePrivacySettings(updates, userId)
      );
      // Rebuild against the dispatch-time snapshot, NOT the live cache.
      // The cache may have been mutated by a sibling write between
      // dispatch and settle; using `currentUser` keeps this mutation
      // hermetic.
      return {
        ...currentUser,
        privacySettings: updatedPrivacy,
      };
    },
    onMutate: async ({ updates }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.accounts.settings() });
      const previousUser = queryClient.getQueryData<User>(queryKeys.accounts.current(activeSessionId));

      if (previousUser) {
        queryClient.setQueryData<User>(queryKeys.accounts.current(activeSessionId), {
          ...previousUser,
          privacySettings: {
            ...previousUser.privacySettings,
            ...updates,
          },
        });
      }

      return { previousUser };
    },
    onError: (error, { updates }, context) => {
      // Restore only the privacySettings keys this mutation tried to change
      if (context?.previousUser && updates) {
        const previousPrivacy = context.previousUser.privacySettings ?? {};
        const changedKeys = Object.keys(updates) as Array<keyof PrivacySettings>;
        const partialPrivacyRollback = changedKeys.reduce<Partial<PrivacySettings>>((acc, key) => {
          (acc as Record<string, unknown>)[key as string] = (previousPrivacy as Record<string, unknown>)[key as string];
          return acc;
        }, {});

        const current = queryClient.getQueryData<User>(queryKeys.accounts.current(activeSessionId));
        if (current) {
          queryClient.setQueryData<User>(queryKeys.accounts.current(activeSessionId), {
            ...current,
            privacySettings: {
              ...(current.privacySettings ?? {}),
              ...partialPrivacyRollback,
            },
          });
        }
      }
      toast.error(error instanceof Error ? error.message : 'Failed to update settings');
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.accounts.current(activeSessionId), data);

      // Update authStore so frontend components see the changes immediately
      useAuthStore.getState().setUser(data);

      invalidateAccountQueries(queryClient);
      toast.success('Settings updated successfully');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.accounts.settings() });
    },
  });

  // Snapshot the current user at dispatch time. Reading `user` here (from
  // the `useOxy()` closure of the call to `useUpdateAccountSettings`) is
  // the dispatch-time value, captured the moment `mutate()` runs — exactly
  // what the race fix needs.
  return {
    ...mutation,
    mutate: (updates: Partial<PrivacySettings>): void => {
      const currentUser = user ?? queryClient.getQueryData<User>(queryKeys.accounts.current(activeSessionId));
      if (!currentUser) {
        toast.error('Cannot update account settings: no current user');
        return;
      }
      mutation.mutate({ updates, currentUser });
    },
    mutateAsync: async (updates: Partial<PrivacySettings>): Promise<User> => {
      const currentUser = user ?? queryClient.getQueryData<User>(queryKeys.accounts.current(activeSessionId));
      if (!currentUser) {
        throw new Error('Cannot update account settings: no current user');
      }
      return mutation.mutateAsync({ updates, currentUser });
    },
  };
};

/**
 * Update privacy settings with optimistic updates and authentication handling
 */
export const useUpdatePrivacySettings = () => {
  const { oxyServices, activeSessionId, user } = useOxy();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: [...mutationKeys.account.updatePrivacySettings],
    mutationFn: async ({ settings, userId }: { settings: Partial<PrivacySettings>; userId?: string }) => {
      const targetUserId = userId || user?.id;
      if (!targetUserId) {
        throw new Error('User ID is required');
      }

      return authenticatedApiCall<PrivacySettings>(
        oxyServices,
        activeSessionId,
        () => oxyServices.updatePrivacySettings(settings, targetUserId)
      );
    },
    // Optimistic update
    onMutate: async ({ settings, userId }) => {
      const targetUserId = userId || user?.id;
      if (!targetUserId) return;

      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: queryKeys.privacy.settings(targetUserId) });
      await queryClient.cancelQueries({ queryKey: queryKeys.accounts.current(activeSessionId) });

      // Snapshot previous values
      const previousPrivacySettings = queryClient.getQueryData(queryKeys.privacy.settings(targetUserId));
      const previousUser = queryClient.getQueryData<User>(queryKeys.accounts.current(activeSessionId));

      // Optimistically update privacy settings
      if (previousPrivacySettings) {
        queryClient.setQueryData<PrivacySettings>(queryKeys.privacy.settings(targetUserId), {
          ...(previousPrivacySettings as PrivacySettings),
          ...settings,
        });
      }

      // Also update user query if available
      if (previousUser) {
        queryClient.setQueryData<User>(queryKeys.accounts.current(activeSessionId), {
          ...previousUser,
          privacySettings: {
            ...previousUser.privacySettings,
            ...settings,
          },
        });
      }

      return { previousPrivacySettings, previousUser };
    },
    // On error, rollback ONLY the privacy keys this mutation tried to change.
    // Restoring the entire previous object would wipe out other concurrent
    // optimistic updates (e.g. user toggles two privacy switches in quick
    // succession; failure on one must not revert the other).
    onError: (error, { settings, userId }, context) => {
      const targetUserId = userId || user?.id;
      const changedKeys = settings ? (Object.keys(settings) as Array<keyof PrivacySettings>) : [];

      // Rollback the privacy.settings query (partial)
      if (context?.previousPrivacySettings && targetUserId && changedKeys.length > 0) {
        const previousPrivacy = context.previousPrivacySettings as Record<string, unknown>;
        const partialPrivacyRollback = changedKeys.reduce<Partial<PrivacySettings>>((acc, key) => {
          (acc as Record<string, unknown>)[key as string] = previousPrivacy[key as string];
          return acc;
        }, {});
        const currentPrivacy = queryClient.getQueryData<PrivacySettings>(queryKeys.privacy.settings(targetUserId));
        if (currentPrivacy) {
          queryClient.setQueryData<PrivacySettings>(queryKeys.privacy.settings(targetUserId), {
            ...currentPrivacy,
            ...partialPrivacyRollback,
          });
        }
      }

      // Rollback the accounts.current() user.privacySettings (partial)
      if (context?.previousUser && changedKeys.length > 0) {
        const previousPrivacy = (context.previousUser.privacySettings ?? {}) as Record<string, unknown>;
        const partialPrivacyRollback = changedKeys.reduce<Partial<PrivacySettings>>((acc, key) => {
          (acc as Record<string, unknown>)[key as string] = previousPrivacy[key as string];
          return acc;
        }, {});
        const current = queryClient.getQueryData<User>(queryKeys.accounts.current(activeSessionId));
        if (current) {
          queryClient.setQueryData<User>(queryKeys.accounts.current(activeSessionId), {
            ...current,
            privacySettings: {
              ...(current.privacySettings ?? {}),
              ...partialPrivacyRollback,
            },
          });
        }
      }

      // After partial rollback, force a fresh fetch from the server so any
      // concurrent-mutation state we may have failed to restore correctly
      // gets reconciled with the source of truth. Targeted at privacy.settings
      // only — NOT onSettled, which would defeat the merge fix on success.
      if (targetUserId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.privacy.settings(targetUserId) });
      }

      toast.error(error instanceof Error ? error.message : 'Failed to update privacy settings');
    },
    // On success, MERGE the server response into the cached state. Older
    // API builds returned only the changed field (or wiped the privacySettings
    // subdocument when handed a partial update), which would clobber every
    // other toggle if we blindly replaced. Defensive merge means the UI stays
    // consistent regardless of server behaviour.
    //
    // BOTH the privacy.settings query AND the accounts.current() user are
    // gated on `targetUserId`. If it's missing (no userId param, no logged-in
    // user) the optimistic update in onMutate would have early-returned too,
    // so neither cache was ever touched — there's nothing to reconcile here.
    onSuccess: (data, { userId, settings }) => {
      const targetUserId = userId || user?.id;
      if (!targetUserId) return;

      const incoming = (data ?? {}) as PrivacySettings;
      const requested = (settings ?? {}) as Partial<PrivacySettings>;

      queryClient.setQueryData<PrivacySettings>(
        queryKeys.privacy.settings(targetUserId),
        (previous) => ({
          ...(previous ?? {}),
          ...requested,
          ...incoming, // server wins for fields it explicitly returned
        }),
      );

      const currentUser = queryClient.getQueryData<User>(queryKeys.accounts.current(activeSessionId));
      if (currentUser) {
        const updatedUser: User = {
          ...currentUser,
          privacySettings: {
            ...(currentUser.privacySettings ?? {}),
            ...requested,
            ...incoming,
          },
        };
        queryClient.setQueryData<User>(queryKeys.accounts.current(activeSessionId), updatedUser);
        useAuthStore.getState().setUser(updatedUser);
      }
      // Deliberately NOT invalidating any queries here. invalidateAccountQueries
      // invalidates accounts.all which is the prefix for accounts.current(),
      // triggering a background refetch of useCurrentUser that would overwrite
      // the merged state above. The onSuccess merge is the source of truth.
    },
  });
};

/** Uploaded file data structure from API */
interface UploadedFile {
  id: string;
  originalName?: string;
  sha256?: string;
  mime?: string;
  size?: number;
  createdAt?: string;
  metadata?: Record<string, unknown>;
  variants?: Array<{ type: string; key: string; width?: number; height?: number; readyAt?: string; metadata?: Record<string, unknown> }>;
}

/** Upload result type that supports both single file and batch responses */
interface UploadResult {
  file?: UploadedFile;
  files?: UploadedFile[];
  id?: string;
}

/**
 * Update the authenticated user's notification preferences with optimistic
 * updates. Persisted on the User document via `PUT /users/me` — same cache-
 * invalidation behaviour as `useUpdateProfile`.
 */
export const useUpdateNotificationPreferences = () => {
  const { oxyServices, activeSessionId } = useOxy();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: [...mutationKeys.account.updateNotificationPreferences],
    mutationFn: async (preferences: Partial<NotificationPreferences>) => {
      return authenticatedApiCall<User>(
        oxyServices,
        activeSessionId,
        () => oxyServices.updateNotificationPreferences(preferences)
      );
    },
    onMutate: async (preferences) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.accounts.current(activeSessionId) });
      const previousUser = queryClient.getQueryData<User>(queryKeys.accounts.current(activeSessionId));

      if (previousUser) {
        queryClient.setQueryData<User>(queryKeys.accounts.current(activeSessionId), {
          ...previousUser,
          notificationPreferences: {
            ...previousUser.notificationPreferences,
            ...preferences,
          },
        });
      }

      return { previousUser };
    },
    onError: (error, _preferences, context) => {
      if (context?.previousUser) {
        const current = queryClient.getQueryData<User>(queryKeys.accounts.current(activeSessionId));
        if (current) {
          queryClient.setQueryData<User>(queryKeys.accounts.current(activeSessionId), {
            ...current,
            notificationPreferences: context.previousUser.notificationPreferences,
          });
        }
      }
      toast.error(
        error instanceof Error
          ? error.message
          : 'Failed to update notification preferences'
      );
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.accounts.current(activeSessionId), data);
      useAuthStore.getState().setUser(data);
      invalidateAccountQueries(queryClient);
    },
  });
};

/**
 * Update the authenticated user's general preferences (language, theme,
 * reduce-motion, timezone). Persisted on the User document via
 * `PUT /users/me`.
 */
export const useUpdateUserPreferences = () => {
  const { oxyServices, activeSessionId } = useOxy();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: [...mutationKeys.account.updateUserPreferences],
    mutationFn: async (preferences: Partial<UserPreferences>) => {
      return authenticatedApiCall<User>(
        oxyServices,
        activeSessionId,
        () => oxyServices.updateUserPreferences(preferences)
      );
    },
    onMutate: async (preferences) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.accounts.current(activeSessionId) });
      const previousUser = queryClient.getQueryData<User>(queryKeys.accounts.current(activeSessionId));

      if (previousUser) {
        queryClient.setQueryData<User>(queryKeys.accounts.current(activeSessionId), {
          ...previousUser,
          userPreferences: {
            ...previousUser.userPreferences,
            ...preferences,
          },
        });
      }

      return { previousUser };
    },
    onError: (error, _preferences, context) => {
      if (context?.previousUser) {
        const current = queryClient.getQueryData<User>(queryKeys.accounts.current(activeSessionId));
        if (current) {
          queryClient.setQueryData<User>(queryKeys.accounts.current(activeSessionId), {
            ...current,
            userPreferences: context.previousUser.userPreferences,
          });
        }
      }
      toast.error(error instanceof Error ? error.message : 'Failed to update preferences');
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.accounts.current(activeSessionId), data);
      useAuthStore.getState().setUser(data);
      invalidateAccountQueries(queryClient);
    },
  });
};

/**
 * Revoke the current user's grant for a connected application (by its
 * `applicationId`). Removes the grant so the app no longer appears in the user's
 * "Connected apps" list — next sign-in for that app will require explicit
 * re-consent.
 */
export const useRevokeConnectedApp = () => {
  const { oxyServices, activeSessionId } = useOxy();
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: [...mutationKeys.connectedApps.revoke],
    mutationFn: async (applicationId: string) => {
      return authenticatedApiCall<void>(oxyServices, activeSessionId, () =>
        oxyServices.revokeAppGrant(applicationId)
      );
    },
    onSuccess: () => {
      invalidateConnectedAppsQueries(queryClient);
    },
    onError: (error) => {
      toast.error(
        error instanceof Error ? error.message : 'Failed to revoke connected app'
      );
    },
  });
};

/**
 * Upload file with authentication handling and progress tracking
 */
export const useUploadFile = () => {
  const { oxyServices, activeSessionId } = useOxy();

  return useMutation({
    mutationKey: [...mutationKeys.account.uploadFile],
    mutationFn: async ({
      file,
      visibility,
      metadata,
      onProgress,
    }: {
      file: AssetUploadInput;
      visibility?: 'private' | 'public' | 'unlisted';
      metadata?: Record<string, unknown>;
      onProgress?: (progress: number) => void;
    }) => {
      return authenticatedApiCall<UploadResult>(
        oxyServices,
        activeSessionId,
        () => oxyServices.assetUpload(file, visibility, metadata, onProgress)
      );
    },
  });
};
