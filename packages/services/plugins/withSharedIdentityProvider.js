/**
 * Config plugin: withSharedIdentityProvider (Commons only).
 *
 * Commons is the identity vault — the ONE app that HOSTS the cross-app shared
 * identity. This plugin wires the Android side of `@oxy.so/services`:
 *
 *  - Defines a `signature`-level permission `so.oxy.shared.permission.READ_IDENTITY`.
 *    `signature` means only apps signed with the SAME certificate (the shared
 *    Oxy release keystore) can hold it — the trust boundary is the signing key,
 *    not the deprecated `sharedUserId`.
 *  - Requests that same permission (`<uses-permission>`) so Commons can also
 *    read cross-authority (e.g. prod ⇆ dev variant) through the provider.
 *  - Declares the `OxyIdentityProvider` at authority `${applicationId}.identity`
 *    (AGP substitutes `${applicationId}` at build → `so.oxy.commons.identity`,
 *    or `so.oxy.commons.dev.identity` for the dev variant), guarded by that
 *    permission.
 *  - Adds a `<queries>` entry for the provider authorities so package-visibility
 *    filtering (Android 11+) never hides the sibling provider from the resolver.
 *
 * Reader apps (accounts, Mention, …) use the companion `withSharedIdentityReader`
 * plugin, which only requests the permission + queries — they never host the
 * provider.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

const READ_IDENTITY_PERMISSION = 'so.oxy.shared.permission.READ_IDENTITY';
const PROVIDER_CLASS = 'so.oxy.identity.OxyIdentityProvider';
const PROVIDER_AUTHORITIES = ['so.oxy.commons.identity', 'so.oxy.commons.dev.identity'];

module.exports = function withSharedIdentityProvider(config) {
  return withAndroidManifest(config, (modConfig) => {
    const manifest = modConfig.modResults.manifest;

    // 1. Define the signature-level permission.
    manifest['permission'] = manifest['permission'] ?? [];
    if (!manifest['permission'].some((p) => p.$['android:name'] === READ_IDENTITY_PERMISSION)) {
      manifest['permission'].push({
        $: {
          'android:name': READ_IDENTITY_PERMISSION,
          'android:protectionLevel': 'signature',
        },
      });
    }

    // 2. Request it (Commons reads cross-authority too).
    manifest['uses-permission'] = manifest['uses-permission'] ?? [];
    if (!manifest['uses-permission'].some((p) => p.$['android:name'] === READ_IDENTITY_PERMISSION)) {
      manifest['uses-permission'].push({ $: { 'android:name': READ_IDENTITY_PERMISSION } });
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
      throw new Error('withSharedIdentityProvider: AndroidManifest has no <application>');
    }
    app.provider = app.provider ?? [];
    if (!app.provider.some((p) => p.$['android:name'] === PROVIDER_CLASS)) {
      app.provider.push({
        $: {
          'android:name': PROVIDER_CLASS,
          'android:authorities': '${applicationId}.identity',
          'android:exported': 'true',
          'android:permission': READ_IDENTITY_PERMISSION,
        },
      });
    }

    return modConfig;
  });
};
