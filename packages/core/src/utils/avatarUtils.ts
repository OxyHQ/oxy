import { logger } from '../logger';

/** What `updateAvatarVisibility` needs of a client: `oxy.assets.setVisibility`. */
export interface AssetVisibilityService {
  assets: { setVisibility(fileId: string, visibility: 'private' | 'public' | 'unlisted'): Promise<unknown> };
}

/**
 * Updates file visibility to public for avatar use.
 * Logs non-404 errors to help debug upload issues.
 *
 * @param fileId - The file ID to update visibility for
 * @param oxyServices - An OxyServices client
 * @param contextName - Context name for error logging
 */
export async function updateAvatarVisibility(
  fileId: string | undefined,
  oxyServices: AssetVisibilityService,
  contextName = 'AvatarUtils'
): Promise<void> {
  if (!fileId || fileId.startsWith('temp-')) {
    return;
  }

  try {
    await oxyServices.assets.setVisibility(fileId, 'public');
  } catch (visError: unknown) {
    // 404 is expected when asset doesn't exist yet — skip logging
    const status = (visError instanceof Error && 'status' in visError)
      ? (visError as Error & { status: number }).status
      : undefined;
    if (status !== 404) {
      logger.error(`[${contextName}] Failed to update avatar visibility for ${fileId}`, visError, { component: contextName });
    }
  }
}
