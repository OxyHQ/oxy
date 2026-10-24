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
 *     webgpu: true,                         // opt-in: react-native-webgpu's config plugin
 *     noxcturnal: false,                    // opt out of Expo's oxc transformer in development
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
 * `withOxySharedPermissions` also signs every release build with the ONE Oxy
 * ecosystem key (the `OXY_UPLOAD_*` Gradle properties) and fails a release that
 * does not carry its certificate; an app lists no signing plugin of its own.
 * `withOxyR8Optimize` (always applied) swaps in R8's `-optimize` ProGuard file on
 * Expo SDK 56/57 and is a no-op on 58.
 *
 * @param {import('expo/config').ExpoConfig} config
 * @param {object} [options]
 * @param {string|false} [options.keychainGroup='group.so.oxy.shared']
 * @param {object|false}  [options.ios]
 * @param {object|false}  [options.android]
 * @param {boolean}       [options.webgpu=false] Apply `react-native-webgpu`'s
 *   config plugin (an app drawing with WebGPU on native). Needs
 *   `react-native-webgpu` installed in the app.
 * @param {boolean}       [options.noxcturnal=true] Bundle development builds with
 *   Noxcturnal, Expo's oxc transformer (`experiments.noxcturnalTransformWorker`),
 *   about twice as fast as Babel on a cold cache. It only runs when the app's
 *   Babel config is the preset's (or none), and never in a production build: it
 *   keeps the requires of dead platform branches, pulling native-only packages
 *   into a web bundle. The Expo CLI sets NODE_ENV before it reads the config.
 *   An app that sets the experiment itself keeps its own value.
 */
const withOxyKeychain = require('./withOxyKeychain');
const withOxyBuildProperties = require('./withOxyBuildProperties');
const withOxyR8Optimize = require('./withOxyR8Optimize');
const { dirname, join } = require('node:path');
const { projectRootOf, requireFromProject, resolveFromProject } = require('./requireFromProject');

const REMOVED_OPTIONS = {
  sharedUserId:
    'Oxy Android apps no longer share a UID: they share the identity and the session with Commons ' +
    'over signature-protected IPC. Remove the option (and any android:sharedUserId).',
  sharedIdentityReader:
    'the reader plugin is gone; every Oxy app now applies @oxy.so/services/plugins/withOxySharedPermissions, ' +
    'which the preset always does. Remove the option.',
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
    webgpu = false,
    noxcturnal = true,
  } = options;

  let next = config;

  if (noxcturnal && next.experiments?.noxcturnalTransformWorker === undefined) {
    next = {
      ...next,
      experiments: {
        ...next.experiments,
        noxcturnalTransformWorker: process.env.NODE_ENV !== 'production',
      },
    };
  }

  if (keychainGroup !== false) {
    next = withOxyKeychain(next, keychainGroup);
  }

  if (ios !== false || android !== false) {
    next = withOxyBuildProperties(next, { ios, android });
  }

  next = withOxyR8Optimize(next);

  let withOxySharedPermissions;
  try {
    const permissionsPlugin = resolveFromProject(
      '@oxy.so/services/plugins/withOxySharedPermissions',
      projectRootOf(config),
    );
    // A Services older than 13.4.0 declares the permissions WITHOUT release
    // signing, and Expo's template then signs release with the debug key: refuse
    // it. Its sibling, because withOxySharedPermissions loads that very file.
    require.resolve(join(dirname(permissionsPlugin), 'withOxyReleaseSigning'));
    withOxySharedPermissions = require(permissionsPlugin);
  } catch (error) {
    throw new Error(
      "[@oxy.so/app-preset] needs '@oxy.so/services' 13.4.0 or later (for plugins/withOxySharedPermissions and withOxyReleaseSigning). " +
        `Install it in the app. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  next = withOxySharedPermissions(next);

  if (webgpu) {
    let withWebGPU;
    try {
      withWebGPU = requireFromProject('react-native-webgpu/app.plugin.js', projectRootOf(config));
    } catch (error) {
      throw new Error(
        "[@oxy.so/app-preset] `webgpu: true` needs 'react-native-webgpu' installed in the app. " +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }
    next = withWebGPU(next);
  }

  return next;
};
