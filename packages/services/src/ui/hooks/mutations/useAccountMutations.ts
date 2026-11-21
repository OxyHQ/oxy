import { useCallback } from 'react';
import { type ActionView, useAction } from '@oxy.so/bloom-data';
import type { NotificationPreferences, PrivacySettings, User, UserPreferences } from '@oxy.so/core';
import type { UserProfileUpdate } from '@oxy.so/contracts';
import { toast } from '@oxy.so/bloom/toast';
import { useOxy } from '../../context/oxyRuntimeContext';
import {
  type AvatarFile,
  revokeConnectedApp,
  updateAccountSettings,
  updateNotificationPreferences,
  updatePrivacySettings,
  updateProfile,
  updateUserPreferences,
  uploadAvatar,
  uploadFile,
  type UploadFileInput,
  type UploadResult,
} from '../../data/account';
import { describeApiError } from '../../utils/apiErrorMessage';
import { describeUsernameRefusal } from '../../utils/usernamePolicy';
import { useApiErrorToast } from '../useApiErrorToast';
import { useI18n } from '../useI18n';

/**
 * The account family's writes, as a component calls them: each is a
 * `@oxy.so/bloom-data` action (`data/account.ts`) with the client and session
 * bound. Running one shows the change at once, rejects when it fails (the person is
 * told why, here), and `isPending`/`error` describe the last call.
 */

/** Changes the signed-in person's profile; shown at once, rolled back if refused. */
export const useUpdateProfile = (): ActionView<[UserProfileUpdate], User> => {
  const { t } = useI18n();
  const { oxyServices, activeSessionId } = useOxy();
  const view = useAction(updateProfile);
  const { run: call } = view;
  const run = useCallback(
    (updates: UserProfileUpdate) =>
      call(oxyServices, activeSessionId, updates).catch((error: unknown) => {
        toast.error(
          describeUsernameRefusal(error, updates.username ?? '', t) ??
            describeApiError(error, t, t('actionErrors.updateProfile')),
        );
        throw error;
      }),
    [call, oxyServices, activeSessionId, t],
  );
  return { ...view, run };
};

/** Uploads a new picture and makes it the signed-in person's avatar. */
export const useUploadAvatar = (): ActionView<[AvatarFile], User> => {
  const showApiError = useApiErrorToast();
  const { oxyServices, activeSessionId } = useOxy();
  const view = useAction(uploadAvatar);
  const { run: call } = view;
  const run = useCallback(
    async (file: AvatarFile) => {
      try {
        const user = await call(oxyServices, activeSessionId, file);
        toast.success('Avatar updated successfully');
        return user;
      } catch (error) {
        showApiError(error, 'actionErrors.uploadAvatar');
        throw error;
      }
    },
    [call, oxyServices, activeSessionId, showApiError],
  );
  return { ...view, run };
};

/**
 * Changes the signed-in person's privacy preferences through the dedicated
 * privacy endpoint (`PUT /users/me` would silently drop them). The person is
 * snapshotted when the write is made, and the user it returns is rebuilt
 * from that snapshot, so a sibling write settling meanwhile is not overwritten.
 */
export const useUpdateAccountSettings = (): ActionView<[Partial<PrivacySettings>], User> => {
  const showApiError = useApiErrorToast();
  const { oxyServices, activeSessionId, user } = useOxy();
  const view = useAction(updateAccountSettings);
  const { run: call } = view;
  const run = useCallback(
    async (updates: Partial<PrivacySettings>) => {
      if (!user) throw new Error('Cannot update account settings: no current user');
      try {
        const updated = await call(oxyServices, activeSessionId, user, updates);
        toast.success('Settings updated successfully');
        return updated;
      } catch (error) {
        showApiError(error, 'actionErrors.updateSettings');
        throw error;
      }
    },
    [call, oxyServices, activeSessionId, user, showApiError],
  );
  return { ...view, run };
};

/** What `useUpdatePrivacySettings` writes: some settings of a person, the active account by default. */
export interface PrivacySettingsChange {
  settings: Partial<PrivacySettings>;
  userId?: string;
}

/**
 * Changes privacy settings, shown at once. Only the fields asked for are
 * written, so two quick toggles never undo each other, and a failure drops
 * exactly its own.
 */
export const useUpdatePrivacySettings = (): ActionView<
  [PrivacySettingsChange],
  PrivacySettings
> => {
  const showApiError = useApiErrorToast();
  const { oxyServices, activeSessionId, user } = useOxy();
  const view = useAction(updatePrivacySettings);
  const { run: call } = view;
  const userId = user?.id;
  const run = useCallback(
    (change: PrivacySettingsChange) =>
      call(oxyServices, activeSessionId, change.userId || userId, change.settings).catch(
        (error: unknown) => {
          showApiError(error, 'actionErrors.updatePrivacy');
          throw error;
        },
      ),
    [call, oxyServices, activeSessionId, userId, showApiError],
  );
  return { ...view, run };
};

/** Changes the signed-in person's notification preferences, shown at once. */
export const useUpdateNotificationPreferences = (): ActionView<
  [Partial<NotificationPreferences>],
  User
> => {
  const showApiError = useApiErrorToast();
  const { oxyServices, activeSessionId } = useOxy();
  const view = useAction(updateNotificationPreferences);
  const { run: call } = view;
  const run = useCallback(
    (preferences: Partial<NotificationPreferences>) =>
      call(oxyServices, activeSessionId, preferences).catch((error: unknown) => {
        showApiError(error, 'actionErrors.updateNotifications');
        throw error;
      }),
    [call, oxyServices, activeSessionId, showApiError],
  );
  return { ...view, run };
};

/** Changes the signed-in person's general preferences (language, theme, timezone), shown at once. */
export const useUpdateUserPreferences = (): ActionView<[Partial<UserPreferences>], User> => {
  const showApiError = useApiErrorToast();
  const { oxyServices, activeSessionId } = useOxy();
  const view = useAction(updateUserPreferences);
  const { run: call } = view;
  const run = useCallback(
    (preferences: Partial<UserPreferences>) =>
      call(oxyServices, activeSessionId, preferences).catch((error: unknown) => {
        showApiError(error, 'actionErrors.updatePreferences');
        throw error;
      }),
    [call, oxyServices, activeSessionId, showApiError],
  );
  return { ...view, run };
};

/**
 * Revokes a connected application's grant (by its `applicationId`): it leaves
 * the "Connected apps" list, and its next sign-in asks for consent again.
 */
export const useRevokeConnectedApp = (): ActionView<[string], void> => {
  const showApiError = useApiErrorToast();
  const { oxyServices, activeSessionId } = useOxy();
  const view = useAction(revokeConnectedApp);
  const { run: call } = view;
  const run = useCallback(
    (applicationId: string) =>
      call(oxyServices, activeSessionId, applicationId).catch((error: unknown) => {
        showApiError(error, 'actionErrors.revokeConnectedApp');
        throw error;
      }),
    [call, oxyServices, activeSessionId, showApiError],
  );
  return { ...view, run };
};

/** Uploads a file to the person's library, reporting progress through `onProgress`. */
export const useUploadFile = (): ActionView<[UploadFileInput], UploadResult> => {
  const { oxyServices, activeSessionId } = useOxy();
  const view = useAction(uploadFile);
  const { run: call } = view;
  const run = useCallback(
    (input: UploadFileInput) => call(oxyServices, activeSessionId, input),
    [call, oxyServices, activeSessionId],
  );
  return { ...view, run };
};
