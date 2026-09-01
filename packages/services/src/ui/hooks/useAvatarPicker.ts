/**
 * Avatar Picker Hook
 *
 * The ONE write path for a user's profile picture. It owns no UI: the whole
 * choose-and-crop experience is a single surface.
 *
 * Flow (typed promise over the shared surface stack — no callback props):
 *   1. `openWithinOrPresent('ChangeAvatar')` opens the source list (device gallery,
 *      camera, existing Oxy files, remove) — MORPHING into the caller's surface
 *      when one is open, else presenting cold. Whichever source the user picks, it
 *      navigates WITHIN to the crop editor — so there is exactly one cropper and
 *      one entry into it.
 *   2. The surface resolves with the cropped JPEG, with `{ removed: true }` when
 *      the user removed their photo, or `undefined` when they cancelled.
 *   3. A crop is uploaded as a NEW file via `oxyServices.assetUpload` and set as
 *      the avatar; a removal clears the avatar field.
 *
 * `expo-image-manipulator` is required for the crop step and `expo-image-picker`
 * for the device/camera sources (both declared as optional peers in the
 * consuming app) — see AvatarCropScreen / ChangeAvatarScreen.
 */

import { useCallback } from 'react';
import type { OxyServices } from '@oxyhq/core';
import { translate, updateAvatarVisibility } from '@oxyhq/core';
import type { QueryClient } from '@tanstack/react-query';
import { toast } from '@oxyhq/bloom/toast';
import { updateProfileWithAvatar } from '../utils/avatarUtils';
import { openWithinOrPresent } from '../navigation/surfaces';
import type { AvatarCropResult } from '../screens/AvatarCropScreen';

interface UseAvatarPickerOptions {
  oxyServices: OxyServices;
  currentLanguage: string | null | undefined;
  activeSessionId: string | null;
  queryClient: QueryClient;
}

/** Upload result shape returned by oxyServices.assetUpload (single-file path). */
interface AssetUploadResult {
  file?: { id?: string };
  files?: Array<{ id?: string }>;
  id?: string;
}

function extractUploadedFileId(result: AssetUploadResult | undefined): string | undefined {
  if (!result) return undefined;
  if (typeof result.id === 'string') return result.id;
  if (result.file?.id) return result.file.id;
  const first = result.files?.[0];
  if (first?.id) return first.id;
  return undefined;
}

export function useAvatarPicker({
  oxyServices,
  currentLanguage,
  activeSessionId,
  queryClient,
}: UseAvatarPickerOptions) {
  /**
   * Final step: take the cropped JPEG, upload it as a new public file, then
   * set it as the user's avatar. Fires success/error toasts.
   */
  const finalizeCroppedAvatar = useCallback(
    async (cropped: AvatarCropResult) => {
      try {
        const uploadResult = (await oxyServices.assetUpload(
          {
            uri: cropped.uri,
            type: cropped.mime,
            name: `avatar-${Date.now()}.jpg`,
          },
          'public',
        )) as AssetUploadResult;

        const newFileId = extractUploadedFileId(uploadResult);
        if (!newFileId) {
          throw new Error('Avatar upload succeeded but no file ID was returned');
        }

        await updateAvatarVisibility(newFileId, oxyServices, 'useAvatarPicker');
        await updateProfileWithAvatar(
          { avatar: newFileId },
          oxyServices,
          activeSessionId,
          queryClient,
        );

        toast.success(
          translate(currentLanguage ?? undefined, 'editProfile.toasts.avatarUpdated') ||
            'Avatar updated',
        );
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : undefined;
        toast.error(
          message ||
            translate(currentLanguage ?? undefined, 'editProfile.toasts.updateAvatarFailed') ||
            'Failed to update avatar',
        );
      }
    },
    [activeSessionId, currentLanguage, oxyServices, queryClient],
  );

  /** Clear the avatar so the profile falls back to the user's initials. */
  const removeAvatar = useCallback(async () => {
    try {
      await updateProfileWithAvatar({ avatar: '' }, oxyServices, activeSessionId, queryClient);
      toast.success(
        translate(currentLanguage ?? undefined, 'editProfile.toasts.avatarRemoved'),
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : undefined;
      toast.error(
        message ||
          translate(currentLanguage ?? undefined, 'editProfile.toasts.updateAvatarFailed'),
      );
    }
  }, [activeSessionId, currentLanguage, oxyServices, queryClient]);

  const openAvatarPicker = useCallback(async () => {
    // The source list + crop editor are ONE flow. When triggered from a screen
    // already inside a surface (EditProfile, ManageAccount, WelcomeNewUser — every
    // current entry point), it MORPHS into that surface and pops back on finish;
    // triggered with no surface open it presents cold. Either way it resolves with
    // the cropped JPEG, a removal, or `undefined` when the user backs out.
    const result = await openWithinOrPresent('ChangeAvatar');
    if (!result) return;
    if ('removed' in result) {
      await removeAvatar();
      return;
    }
    await finalizeCroppedAvatar(result);
  }, [finalizeCroppedAvatar, removeAvatar]);

  return { openAvatarPicker };
}
