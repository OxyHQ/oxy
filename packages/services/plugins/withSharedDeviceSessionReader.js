/**
 * Config plugin: withSharedDeviceSessionReader (every other official Oxy app).
 *
 * A reader app JOINS the device's existing session — it adopts the shared
 * `deviceId` + `deviceSecret` a hub app published, so it lands signed in with no
 * QR and, crucially, without ever asking for Commons's private identity key.
 * This plugin wires the minimal Android side of `@oxyhq/services`:
 *
 *  - Requests the `signature`-level permission
 *    `so.oxy.shared.permission.READ_DEVICE_SESSION` (defined by the hub apps).
 *    Because it is `signature`, it is granted only when this app is signed with
 *    the SAME certificate as the hub — that is the entire trust boundary, and it
 *    is what makes an incorrectly-signed app unable to read the slot.
 *  - Adds `<queries>` entries for the hub authorities so package-visibility
 *    filtering (Android 11+) never hides them from `ContentResolver.call`.
 *
 * The provider itself is declared only by the hub apps
 * (`withSharedDeviceSessionProvider`) — see the note there about why hosting is
 * restricted to apps inside the `so.oxy.shared` UID.
 *
 * Keep this list identical to `PROVIDER_AUTHORITIES` in
 * `android/src/main/java/so/oxy/devicesession/OxyDeviceSessionModule.kt`.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

const READ_DEVICE_SESSION_PERMISSION = 'so.oxy.shared.permission.READ_DEVICE_SESSION';
const PROVIDER_AUTHORITIES = [
  'so.oxy.accounts.devicesession',
  'so.oxy.accounts.dev.devicesession',
  'so.oxy.commons.devicesession',
  'so.oxy.commons.dev.devicesession',
];

module.exports = function withSharedDeviceSessionReader(config) {
  return withAndroidManifest(config, (modConfig) => {
    const manifest = modConfig.modResults.manifest;

    manifest['uses-permission'] = manifest['uses-permission'] ?? [];
    if (!manifest['uses-permission'].some((p) => p.$['android:name'] === READ_DEVICE_SESSION_PERMISSION)) {
      manifest['uses-permission'].push({ $: { 'android:name': READ_DEVICE_SESSION_PERMISSION } });
    }

    manifest['queries'] = manifest['queries'] ?? [];
    if (manifest['queries'].length === 0) {
      manifest['queries'].push({});
    }
    const queries = manifest['queries'][0];
    queries.provider = queries.provider ?? [];
    for (const authority of PROVIDER_AUTHORITIES) {
      if (!queries.provider.some((p) => p.$['android:authorities'] === authority)) {
        queries.provider.push({ $: { 'android:authorities': authority } });
      }
    }

    return modConfig;
  });
};
