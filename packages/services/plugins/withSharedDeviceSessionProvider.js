/**
 * Config plugin: withSharedDeviceSessionProvider (UID-member hub apps).
 *
 * The shared DeviceSession credential is how several official Oxy apps end up on
 * ONE `DeviceSession` — and therefore one globally active account context —
 * WITHOUT any of them reading Commons's private identity key. This plugin wires
 * the Android side of `@oxyhq/services`:
 *
 *  - Defines a `signature`-level permission
 *    `so.oxy.shared.permission.READ_DEVICE_SESSION`. `signature` means only apps
 *    signed with the SAME certificate (the shared Oxy release keystore) can hold
 *    it — the trust boundary is the signing key, not the deprecated `sharedUserId`.
 *  - Requests that same permission so this app can also read cross-authority.
 *  - Declares `OxyDeviceSessionProvider` at authority
 *    `${applicationId}.devicesession` (AGP substitutes `${applicationId}` at
 *    build), guarded by that permission. The provider is READ-only across the
 *    process boundary: a sibling may join the device session, never overwrite it.
 *  - Adds `<queries>` entries so Android 11+ package-visibility filtering never
 *    hides the sibling providers from the resolver.
 *
 * WHICH APPS USE THIS PLUGIN: exactly the apps listed in `PROVIDER_AUTHORITIES`
 * below, which must be apps inside the `so.oxy.shared` UID. UID members share one
 * data directory, so they all serve the SAME file and the sweep in
 * `OxyDeviceSessionModule` is deterministic whichever one answers. An app that is
 * same-signature but outside that UID must use `withSharedDeviceSessionReader`
 * instead — hosting from there would publish a second, independent copy of "the
 * shared credential" and make the winner depend on list order.
 *
 * Keep this list identical to `PROVIDER_AUTHORITIES` in
 * `android/src/main/java/so/oxy/devicesession/OxyDeviceSessionModule.kt`.
 *
 * This is deliberately a SEPARATE permission and a SEPARATE provider from
 * `withSharedIdentityProvider`. Two secrets with different blast radii: the
 * identity key is self-custody and irreplaceable, the device credential is
 * server-revocable and re-publishable. An app that only needs a session gets only
 * the second one.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

const READ_DEVICE_SESSION_PERMISSION = 'so.oxy.shared.permission.READ_DEVICE_SESSION';
const PROVIDER_CLASS = 'so.oxy.devicesession.OxyDeviceSessionProvider';
const PROVIDER_AUTHORITIES = [
  'so.oxy.accounts.devicesession',
  'so.oxy.accounts.dev.devicesession',
  'so.oxy.commons.devicesession',
  'so.oxy.commons.dev.devicesession',
];

module.exports = function withSharedDeviceSessionProvider(config) {
  return withAndroidManifest(config, (modConfig) => {
    const manifest = modConfig.modResults.manifest;

    // 1. Define the signature-level permission.
    manifest['permission'] = manifest['permission'] ?? [];
    if (!manifest['permission'].some((p) => p.$['android:name'] === READ_DEVICE_SESSION_PERMISSION)) {
      manifest['permission'].push({
        $: {
          'android:name': READ_DEVICE_SESSION_PERMISSION,
          'android:protectionLevel': 'signature',
        },
      });
    }

    // 2. Request it (a hub app reads its siblings too — prod ⇆ dev variant).
    manifest['uses-permission'] = manifest['uses-permission'] ?? [];
    if (!manifest['uses-permission'].some((p) => p.$['android:name'] === READ_DEVICE_SESSION_PERMISSION)) {
      manifest['uses-permission'].push({ $: { 'android:name': READ_DEVICE_SESSION_PERMISSION } });
    }

    // 3. Make the sibling provider authorities visible under package filtering.
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

    // 4. Host the provider.
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
          'android:permission': READ_DEVICE_SESSION_PERMISSION,
        },
      });
    }

    return modConfig;
  });
};
