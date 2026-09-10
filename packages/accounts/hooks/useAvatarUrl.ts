import { useMemo } from 'react';
import { useOxy } from '@oxy.so/services';

/** Minimal shape needed to resolve an avatar download URL. */
interface AvatarUserShape {
  avatar?: string | null;
}

/**
 * Resolves the thumbnail download URL for a user's avatar file id.
 *
 * Consolidates the identical `getFileDownloadUrl(user.avatar, 'thumb')` memo
 * that was copy-pasted into the home, about-identity, authorize, and search
 * screens. Returns `undefined` when the user has no avatar or the services
 * client is not yet available.
 *
 * @param user - The user (or any object exposing an `avatar` file id).
 * @param variant - Image variant to request. Defaults to `'thumb'`.
 */
export function useAvatarUrl(
  user: AvatarUserShape | null | undefined,
  variant = 'thumb',
): string | undefined {
  const { oxyServices } = useOxy();
  const avatar = user?.avatar;

  return useMemo(() => {
    if (avatar && oxyServices) {
      return oxyServices.getFileDownloadUrl(avatar, variant);
    }
    return undefined;
  }, [avatar, oxyServices, variant]);
}
