/**
 * `expo-screen-capture` ships READ_MEDIA_IMAGES in its library manifest for a
 * screenshot listener Commons never uses. It is a Play "photo and video"
 * permission, so the app config strips it from the merged manifest.
 */
interface AndroidConfig {
  blockedPermissions?: string[];
  permissions?: string[];
}

describe('app.config.js Android permissions', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { android } = (require('../../app.config.js') as { expo: { android: AndroidConfig } }).expo;

  it('blocks the media permission the capture guard does not need', () => {
    expect(android.blockedPermissions).toContain('android.permission.READ_MEDIA_IMAGES');
  });

  it('never requests it either', () => {
    expect(android.permissions ?? []).not.toContain('android.permission.READ_MEDIA_IMAGES');
  });
});
