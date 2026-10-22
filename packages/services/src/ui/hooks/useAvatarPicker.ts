/**
 * Avatar Picker Hook
 *
 * The ONE write path for a user's profile picture. It owns no UI: the whole
 * choose-and-crop experience is a single surface. The choosing half —
 * {@link pickAvatarFile} — is account-agnostic and also serves a managed
 * account's picture (`AccountSettings`), so there is one picker, one cropper and
 * one upload for every account an app can edit.
 *
 * Flow (typed promise over the shared surface stack — no callback props):
 *   1. `openWithinOrPresent('ChangeAvatar')` opens the source list (device gallery,
 *      camera, existing Oxy files, remove) — MORPHING into the caller's surface
 *      when one is open, else presenting cold. Whichever source the user picks, it
 *      navigates WITHIN to the crop editor — so there is exactly one cropper and
 *      one entry into it.
 *   2. The surface resolves with the cropped JPEG, with `{ removed: true }` when
 *      the user removed their photo, or `undefined` when they cancelled.
 *   3. A crop is uploaded as a NEW file via `oxyServices.assets.upload` and set as
 *      the avatar; a removal clears the avatar field.
 *
 * `expo-image-manipulator` is required for the crop step and `expo-image-picker`
 * for the device/camera sources (both declared as optional peers in the
 * consuming app) — see AvatarCropScreen / ChangeAvatarScreen.
 */

import { useCallback } from 'react';
import type { OxyServices } from '@oxy.so/core';
import { translate, updateAvatarVisibility } from '@oxy.so/core';
import type { QueryClient } from '@tanstack/react-query';
import { toast } from '@oxy.so/bloom/toast';
import { updateProfileWithAvatar } from '../utils/avatarUtils';
import { openWithinOrPresent } from '../navigation/surfaces';

interface UseAvatarPickerOptions {
  oxyServices: OxyServices;
  currentLanguage: string | null | undefined;
  activeSessionId: string | null;
  queryClient: QueryClient;
}

/** Upload result shape returned by oxyServices.assets.upload (single-file path). */
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

/**
 * Whose picture the picker is changing, when it is not the signed-in user's —
 * the source list previews it and offers "Remove" only when there is one.
 */
export interface AvatarPickerSubject {
  avatar?: string | null;
  displayName?: string;
}

/**
 * The shared choose-and-crop flow, then the crop uploaded as a NEW public file.
 *
 * Resolves the new file's id, `null` when the person chose to remove the
 * picture, or `undefined` when they backed out. It writes no account: the
 * caller decides whose picture the file becomes, which is what lets the
 * signed-in user's profile and a managed account share every step before that.
 * An upload failure rejects.
 */
export async function pickAvatarFile(
  oxyServices: OxyServices,
  subject?: AvatarPickerSubject,
): Promise<string | null | undefined> {
  // The source list + crop editor are ONE flow. When triggered from a screen
  // already inside a surface (EditProfile, ManageAccount, WelcomeNewUser,
  // AccountSettings), it MORPHS into that surface and pops back on finish;
  // triggered with no surface open it presents cold. Either way it resolves with
  // the cropped JPEG, a removal, or `undefined` when the user backs out.
  const result = await openWithinOrPresent('ChangeAvatar', subject ? { subject } : undefined);
  if (!result) return undefined;
  if ('removed' in result) return null;
  const uploadResult = (await oxyServices.assets.upload(
    { uri: result.uri, type: result.mime, name: `avatar-${Date.now()}.jpg` },
    { visibility: 'public' },
  )) as AssetUploadResult;
  const fileId = extractUploadedFileId(uploadResult);
  if (!fileId) {
    throw new Error('Avatar upload succeeded but no file ID was returned');
  }
  await updateAvatarVisibility(fileId, oxyServices, 'pickAvatarFile');
  return fileId;
}

export function useAvatarPicker({
  oxyServices,
  currentLanguage,
  activeSessionId,
  queryClient,
}: UseAvatarPickerOptions) {
  const openAvatarPicker = useCallback(async () => {
    const locale = currentLanguage ?? undefined;
    try {
      const fileId = await pickAvatarFile(oxyServices);
      if (fileId === undefined) return;
      // `''` clears the field on `updateMe`, so the profile falls back to the
      // user's initials.
      await updateProfileWithAvatar(
        { avatar: fileId ?? '' },
        oxyServices,
        activeSessionId,
        queryClient,
      );
      toast.success(
        translate(
          locale,
          fileId === null ? 'editProfile.toasts.avatarRemoved' : 'editProfile.toasts.avatarUpdated',
        ),
      );
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : undefined;
      toast.error(message || translate(locale, 'editProfile.toasts.updateAvatarFailed'));
    }
  }, [activeSessionId, currentLanguage, oxyServices, queryClient]);

  return { openAvatarPicker };
}
