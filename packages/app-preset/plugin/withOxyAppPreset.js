/**
 * Expo Config Plugin: withOxyAppPreset
 *
 * The single config-plugin entry every Oxy app adds in place of the four
 * copy-pasted plugin entries (`withSharedUserId`, keychain entitlement,
 * `expo-build-properties`, `@oxy.so/services/plugins/withSharedIdentityReader`).
 *
 * In app.config.js / app.json:
 *
 *   plugins: [
 *     // …app-specific plugins…
 *     ['@oxy.so/app-preset', {}],
 *   ]
 *
 * Each piece is individually disableable by passing its option as `false`:
 *
 *   ['@oxy.so/app-preset', {
 *     sharedUserId: 'so.oxy.shared',        // false → skip android:sharedUserId
 *     keychainGroup: 'group.so.oxy.shared', // false → skip iOS keychain entitlement
 *     ios: { deploymentTarget: '17.0' },    // false → skip iOS build properties
 *     android: { targetSdkVersion: 34 },    // false → skip Android build properties
 *     sharedIdentityReader: true,           // false → skip @oxy.so/services reader plugin
 *   }]
 *
 * @param {import('expo/config').ExpoConfig} config
 * @param {object} [options]
 * @param {string|false} [options.sharedUserId='so.oxy.shared']
 * @param {string|false} [options.keychainGroup='group.so.oxy.shared']
 * @param {object|false}  [options.ios]
 * @param {object|false}  [options.android]
 * @param {boolean}       [options.sharedIdentityReader=true]
 */
const withSharedUserId = require('./withSharedUserId');
const withOxyKeychain = require('./withOxyKeychain');
const withOxyBuildProperties = require('./withOxyBuildProperties');

module.exports = function withOxyAppPreset(config, options = {}) {
  const {
    sharedUserId = 'so.oxy.shared',
    keychainGroup = 'group.so.oxy.shared',
    ios = {},
    android = {},
    sharedIdentityReader = true,
  } = options;

  let next = config;

  if (sharedUserId !== false) {
    next = withSharedUserId(next, sharedUserId);
  }

  if (keychainGroup !== false) {
    next = withOxyKeychain(next, keychainGroup);
  }

  if (ios !== false || android !== false) {
    next = withOxyBuildProperties(next, { ios, android });
  }

  if (sharedIdentityReader !== false) {
    let withSharedIdentityReader;
    try {
      withSharedIdentityReader = require('@oxy.so/services/plugins/withSharedIdentityReader');
    } catch (error) {
      throw new Error(
        "[@oxy.so/app-preset] sharedIdentityReader is enabled but the peer dependency '@oxy.so/services' "
          + 'is not installed. Install it, or pass `{ sharedIdentityReader: false }` to the preset.',
      );
    }
    next = withSharedIdentityReader(next);
  }

  return next;
};
