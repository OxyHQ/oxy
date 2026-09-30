/**
 * Expo Config Plugin: withOxyIdentityHost (Commons only)
 *
 * Declares the identity host provider (`modules/oxy-identity-host`) at
 * `${applicationId}.identity`: `so.oxy.commons.identity` in production,
 * `so.oxy.commons.dev.identity` in the dev variant. Other Oxy apps ask it for
 * the public key, a signed server challenge and scoped derivations; the
 * identity private key never leaves Commons.
 *
 * The provider is guarded by `so.oxy.permission.IDENTITY` (protectionLevel
 * `signature`). This plugin only REFERENCES that permission: every Oxy app
 * declares and requests it through ONE plugin,
 * `@oxy.so/services/plugins/withOxySharedPermissions`, so every declaration is
 * identical. Declaring it here too would be a second copy that can drift.
 */
const { withAndroidManifest } = require('expo/config-plugins');

const PROVIDER_CLASS = 'so.oxy.commons.identityhost.OxyIdentityHostProvider';
const IDENTITY_PERMISSION = 'so.oxy.permission.IDENTITY';

module.exports = function withOxyIdentityHost(config) {
  return withAndroidManifest(config, (modConfig) => {
    const app = modConfig.modResults.manifest.application?.[0];
    if (!app) {
      throw new Error('withOxyIdentityHost: AndroidManifest has no <application>');
    }
    app.provider = app.provider ?? [];
    if (!app.provider.some((p) => p.$['android:name'] === PROVIDER_CLASS)) {
      app.provider.push({
        $: {
          'android:name': PROVIDER_CLASS,
          'android:authorities': '${applicationId}.identity',
          'android:exported': 'true',
          'android:permission': IDENTITY_PERMISSION,
        },
      });
    }
    return modConfig;
  });
};
