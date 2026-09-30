/**
 * Expo Config Plugin: withOxyAppPreset
 *
 * The single config-plugin entry every Oxy app adds in place of the copy-pasted
 * plugin entries (iOS keychain entitlement, `expo-build-properties`,
 * `@oxy.so/services/plugins/withOxySharedPermissions`).
 *
 * In app.config.js / app.json:
 *
 *   plugins: [
 *     // …app-specific plugins…
 *     ['@oxy.so/app-preset', {}],
 *   ]
 *
 * Options:
 *
 *   ['@oxy.so/app-preset', {
 *     keychainGroup: 'group.so.oxy.shared', // false → skip iOS keychain entitlement
 *     ios: { deploymentTarget: '17.0' },    // false → skip iOS build properties
 *     android: { targetSdkVersion: 34 },    // false → skip Android build properties
 *   }]
 *
 * Android never gets `android:sharedUserId`: each Oxy app has its own UID and
 * shares the identity and the device session with Commons over
 * signature-protected IPC. `withOxySharedPermissions` (always applied) declares
 * and requests the two Oxy signature permissions and the `<queries>` for the
 * host authorities. The removed `sharedUserId` and `sharedIdentityReader`
 * options throw, so an app config that still passes them fails loudly instead
 * of silently doing something else.
 *
 * @param {import('expo/config').ExpoConfig} config
 * @param {object} [options]
 * @param {string|false} [options.keychainGroup='group.so.oxy.shared']
 * @param {object|false}  [options.ios]
 * @param {object|false}  [options.android]
 */
const withOxyKeychain = require('./withOxyKeychain');
const withOxyBuildProperties = require('./withOxyBuildProperties');
const { projectRootOf, requireFromProject } = require('./requireFromProject');

const REMOVED_OPTIONS = {
  sharedUserId:
    'Oxy Android apps no longer share a UID: they share the identity and the session with Commons '
    + 'over signature-protected IPC. Remove the option (and any android:sharedUserId).',
  sharedIdentityReader:
    'the reader plugin is gone; every Oxy app now applies @oxy.so/services/plugins/withOxySharedPermissions, '
    + 'which the preset always does. Remove the option.',
};

module.exports = function withOxyAppPreset(config, options = {}) {
  for (const [name, reason] of Object.entries(REMOVED_OPTIONS)) {
    if (Object.hasOwn(options, name)) {
      throw new Error(`[@oxy.so/app-preset] The \`${name}\` option was removed: ${reason}`);
    }
  }

  const {
    keychainGroup = 'group.so.oxy.shared',
    ios = {},
    android = {},
  } = options;

  let next = config;

  if (keychainGroup !== false) {
    next = withOxyKeychain(next, keychainGroup);
  }

  if (ios !== false || android !== false) {
    next = withOxyBuildProperties(next, { ios, android });
  }

  let withOxySharedPermissions;
  try {
    withOxySharedPermissions = requireFromProject(
      '@oxy.so/services/plugins/withOxySharedPermissions',
      projectRootOf(config),
    );
  } catch (error) {
    throw new Error(
      "[@oxy.so/app-preset] needs '@oxy.so/services' 11 or later (for plugins/withOxySharedPermissions). "
        + `Install it in the app. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  next = withOxySharedPermissions(next);

  return next;
};
