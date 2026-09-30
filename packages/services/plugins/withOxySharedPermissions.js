/**
 * Config plugin: withOxySharedPermissions (EVERY Oxy Android app).
 *
 * Oxy Android apps do not share a UID. They share the Oxy identity and the
 * device session with Commons (and Accounts) through signature-protected
 * ContentProvider `call()` IPC, the way apps use `AccountManager`. Crossing a UID
 * needs two `signature`-level permissions:
 *
 *  - `so.oxy.permission.IDENTITY` — Commons' identity host
 *    (`so.oxy.commons[.dev].identity`): public key, challenge proofs, scoped
 *    derivations. Never the private key.
 *  - `so.oxy.permission.DEVICE_SESSION` — the device-session hosts
 *    (`so.oxy.commons[.dev].devicesession`, `so.oxy.accounts[.dev].devicesession`).
 *
 * This plugin makes the app both DECLARE and REQUEST both, and adds `<queries>`
 * for every host authority:
 *
 *  - Declared by every app, not only by the hosts: a signature permission is
 *    granted when the requesting app is installed, if the declaring app is
 *    already there. With every app declaring it, install order never matters.
 *    Android accepts the same declaration from several packages signed with one
 *    certificate, and rejects it from a differently-signed one
 *    (`INSTALL_FAILED_DUPLICATE_PERMISSION`), which is the protection we want.
 *    Every declaration must be identical, which is why this ONE plugin owns
 *    them; the provider plugins do not declare anything.
 *  - `<queries>`: Android 11+ package visibility hides a provider the app has
 *    not declared an interest in, and `ContentResolver.call` then silently finds
 *    nothing.
 *
 * `signature` is the whole trust boundary at the manifest level; each provider
 * also checks the calling package and its certificate itself.
 */
const { withAndroidManifest } = require('@expo/config-plugins');

const IDENTITY_PERMISSION = 'so.oxy.permission.IDENTITY';
const DEVICE_SESSION_PERMISSION = 'so.oxy.permission.DEVICE_SESSION';
const PERMISSIONS = [IDENTITY_PERMISSION, DEVICE_SESSION_PERMISSION];

/**
 * Every host authority an Oxy app calls. Keep in step with `COMMONS_AUTHORITIES`
 * in `OxyIdentityModule.kt` and `HOST_AUTHORITIES` in `OxyDeviceSessionModule.kt`
 * (a test compares them).
 */
const HOST_AUTHORITIES = [
  'so.oxy.commons.identity',
  'so.oxy.commons.dev.identity',
  'so.oxy.commons.devicesession',
  'so.oxy.commons.dev.devicesession',
  'so.oxy.accounts.devicesession',
  'so.oxy.accounts.dev.devicesession',
];

function withOxySharedPermissions(config) {
  return withAndroidManifest(config, (modConfig) => {
    const manifest = modConfig.modResults.manifest;

    manifest.permission = manifest.permission ?? [];
    manifest['uses-permission'] = manifest['uses-permission'] ?? [];
    for (const name of PERMISSIONS) {
      if (!manifest.permission.some((p) => p.$['android:name'] === name)) {
        manifest.permission.push({
          $: { 'android:name': name, 'android:protectionLevel': 'signature' },
        });
      }
      if (!manifest['uses-permission'].some((p) => p.$['android:name'] === name)) {
        manifest['uses-permission'].push({ $: { 'android:name': name } });
      }
    }

    manifest.queries = manifest.queries ?? [];
    if (manifest.queries.length === 0) {
      manifest.queries.push({});
    }
    const queries = manifest.queries[0];
    queries.provider = queries.provider ?? [];
    for (const authority of HOST_AUTHORITIES) {
      if (!queries.provider.some((p) => p.$['android:authorities'] === authority)) {
        queries.provider.push({ $: { 'android:authorities': authority } });
      }
    }

    return modConfig;
  });
}

module.exports = withOxySharedPermissions;
module.exports.IDENTITY_PERMISSION = IDENTITY_PERMISSION;
module.exports.DEVICE_SESSION_PERMISSION = DEVICE_SESSION_PERMISSION;
module.exports.HOST_AUTHORITIES = HOST_AUTHORITIES;
