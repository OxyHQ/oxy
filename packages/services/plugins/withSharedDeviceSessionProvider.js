/**
 * Config plugin: withSharedDeviceSessionProvider (the device-session HOSTS:
 * Commons and Accounts, prod and dev).
 *
 * The shared DeviceSession credential is how the official Oxy apps end up on
 * ONE `DeviceSession` — and therefore one globally active account context —
 * without any of them touching the identity key. Oxy apps do not share a UID,
 * so the credential lives in the hosts' own storage, and this plugin declares
 * the provider every other app reads and writes it through:
 * `OxyDeviceSessionProvider` at `${applicationId}.devicesession` (AGP
 * substitutes `${applicationId}` at build), guarded by the `signature`-level
 * `so.oxy.permission.DEVICE_SESSION`.
 *
 * It declares NO permission itself: every Oxy app, host or not, declares and
 * requests both Oxy permissions through `withOxySharedPermissions`, so the
 * declarations stay identical. Apply that plugin too.
 *
 * WHICH APPS USE THIS PLUGIN: exactly the apps whose authorities are listed in
 * `HOST_AUTHORITIES` of `OxyDeviceSessionModule.kt` (a test compares them).
 */
const { withAndroidManifest } = require('@expo/config-plugins');

const DEVICE_SESSION_PERMISSION = 'so.oxy.permission.DEVICE_SESSION';
const PROVIDER_CLASS = 'so.oxy.devicesession.OxyDeviceSessionProvider';

/** The authorities this plugin can end up hosting, one per host app. */
const HOST_AUTHORITIES = [
  'so.oxy.commons.devicesession',
  'so.oxy.commons.dev.devicesession',
  'so.oxy.accounts.devicesession',
  'so.oxy.accounts.dev.devicesession',
];

function withSharedDeviceSessionProvider(config) {
  return withAndroidManifest(config, (modConfig) => {
    const manifest = modConfig.modResults.manifest;
    const app = manifest.application?.[0];
    if (!app) {
      throw new Error('withSharedDeviceSessionProvider: AndroidManifest has no <application>');
    }
    app.provider = app.provider ?? [];
    if (!app.provider.some((p) => p.$['android:name'] === PROVIDER_CLASS)) {
      app.provider.push({
        $: {
          'android:name': PROVIDER_CLASS,
          'android:authorities': '${applicationId}.devicesession',
          'android:exported': 'true',
          'android:permission': DEVICE_SESSION_PERMISSION,
        },
      });
    }
    return modConfig;
  });
}

module.exports = withSharedDeviceSessionProvider;
module.exports.HOST_AUTHORITIES = HOST_AUTHORITIES;
