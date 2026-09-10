/**
 * Expo Config Plugin: withOxyBuildProperties
 *
 * Wraps `expo-build-properties` with the native build defaults every Oxy app
 * ships with — iOS deployment target and the Android SDK / minification knobs —
 * so apps stop copy-pasting the same `expo-build-properties` block. Caller
 * overrides deep-merge over these defaults.
 *
 * `expo-build-properties` is required lazily (it is an optional peer): a missing
 * install throws a clear, actionable error only when this plugin actually runs
 * with build properties enabled.
 *
 * @param {import('expo/config').ExpoConfig} config
 * @param {object} [options]
 * @param {object|false} [options.ios]     iOS overrides, or `false` to skip iOS.
 * @param {object|false} [options.android] Android overrides, or `false` to skip Android.
 */
const DEFAULTS = {
  ios: {
    deploymentTarget: '16.4',
  },
  android: {
    compileSdkVersion: 36,
    targetSdkVersion: 35,
    buildToolsVersion: '36.0.0',
    enableProguardInReleaseBuilds: true,
    enableShrinkResourcesInReleaseBuilds: true,
    useLegacyPackaging: false,
  },
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(override)) {
    return base;
  }
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(value) && isPlainObject(result[key])
      ? deepMerge(result[key], value)
      : value;
  }
  return result;
}

function resolveBuildPropertiesPlugin() {
  let mod;
  try {
    mod = require('expo-build-properties');
  } catch (error) {
    throw new Error(
      "[@oxy.so/app-preset] withOxyBuildProperties requires the peer dependency 'expo-build-properties'. "
        + "Install it with `npx expo install expo-build-properties`, or disable it by passing "
        + '`{ ios: false, android: false }` to the preset.',
    );
  }
  const plugin = typeof mod === 'function' ? mod : mod.withBuildProperties || mod.default;
  if (typeof plugin !== 'function') {
    throw new Error(
      "[@oxy.so/app-preset] Could not resolve the 'expo-build-properties' config plugin from the installed package.",
    );
  }
  return plugin;
}

module.exports = function withOxyBuildProperties(config, options = {}) {
  const { ios = {}, android = {} } = options;

  if (ios === false && android === false) {
    return config;
  }

  const props = {};
  if (ios !== false) {
    props.ios = deepMerge(DEFAULTS.ios, ios);
  }
  if (android !== false) {
    props.android = deepMerge(DEFAULTS.android, android);
  }

  const withBuildProperties = resolveBuildPropertiesPlugin();
  return withBuildProperties(config, props);
};

module.exports.DEFAULTS = DEFAULTS;
