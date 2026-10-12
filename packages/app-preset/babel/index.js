/**
 * @oxy.so/app-preset — Babel config factory.
 *
 * The standard Babel config every Oxy Expo app shares: babel-preset-expo with
 * `unstable_transformImportMeta`, the `@ → ./` module-resolver alias, and the
 * `react-native-worklets/plugin` LAST (Reanimated 4 re-exports it — it must be
 * the final plugin).
 *
 * Usage — a one-line babel.config.js:
 *
 *   module.exports = require('@oxy.so/app-preset/babel');
 *
 * With options (all opt-in; an app that passes none gets the config above):
 *
 *   module.exports = require('@oxy.so/app-preset/babel').createOxyBabelConfig({
 *     workletsBundleMode: { importForwarding: { relativePaths: ['components/engine'] } },
 *   });
 *
 * `workletsBundleMode` turns on react-native-worklets' Bundle Mode, in which a
 * worker runtime runs the app's own MODULES rather than only copied worklet
 * closures. It needs the Metro side too (`createOxyMetroConfig(…, {
 * workletsBundleMode: true })`). `importForwarding` (worklets'
 * `moduleNames`/`relativePaths`) names the modules whose imports a worklet
 * runs ON its runtime; an import not forwarded stays on the RN runtime and a
 * synchronous call to it from a worker runtime throws.
 *
 * The peer packages (`babel-preset-expo`, `babel-plugin-module-resolver`,
 * `react-native-worklets`) resolve from the consuming app's node_modules, where
 * Expo already installs them.
 */

const FORWARDING_KEYS = ['moduleNames', 'relativePaths'];

/**
 * The worklets plugin's Bundle Mode options, or `null` when it is off.
 *
 * @param {boolean | { importForwarding?: { moduleNames?: string[], relativePaths?: string[] } } | undefined} value
 */
function bundleModeOptions(value) {
  if (value === undefined || value === false) return null;
  if (value === true) return { bundleMode: true };
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(
      '[@oxy.so/app-preset/babel] `workletsBundleMode` is a boolean or an object.',
    );
  }
  for (const key of Object.keys(value)) {
    if (key !== 'importForwarding') {
      throw new TypeError(
        `[@oxy.so/app-preset/babel] Unknown \`workletsBundleMode.${key}\`; the only option is \`importForwarding\`.`,
      );
    }
  }
  const forwarding = value.importForwarding;
  if (forwarding === undefined) return { bundleMode: true };
  const importForwarding = {};
  for (const [key, list] of Object.entries(forwarding)) {
    if (!FORWARDING_KEYS.includes(key)) {
      throw new TypeError(
        `[@oxy.so/app-preset/babel] Unknown \`importForwarding.${key}\`; expected ${FORWARDING_KEYS.join(' or ')}.`,
      );
    }
    if (!Array.isArray(list) || !list.every((entry) => typeof entry === 'string')) {
      throw new TypeError(
        `[@oxy.so/app-preset/babel] \`importForwarding.${key}\` is a list of strings.`,
      );
    }
    importForwarding[key] = [...list];
  }
  return { bundleMode: true, importForwarding };
}

/**
 * @param {object} [options]
 * @param {boolean | { importForwarding?: { moduleNames?: string[], relativePaths?: string[] } }} [options.workletsBundleMode=false]
 * @returns {(api: import('@babel/core').ConfigAPI) => import('@babel/core').TransformOptions}
 */
function createOxyBabelConfig(options = {}) {
  const bundleMode = bundleModeOptions(options.workletsBundleMode);
  return function oxyBabelPreset(api) {
    api.cache(true);
    return {
      presets: [
        [
          'babel-preset-expo',
          // In Bundle Mode the worklets plugin needs its options, so
          // babel-preset-expo must not add a second, option-less copy.
          bundleMode
            ? { unstable_transformImportMeta: true, worklets: false }
            : { unstable_transformImportMeta: true },
        ],
      ],
      plugins: [
        // The module-resolver must come first for correct module resolution.
        [
          'module-resolver',
          {
            root: ['./'],
            alias: { '@': './' },
            extensions: ['.ts', '.tsx', '.js', '.jsx', '.json', '.svg'],
          },
        ],
        // The build id `@oxy.so/services` busts its persisted caches on.
        require.resolve('./inline-oxy-build-id'),
        // Must be LAST.
        bundleMode ? ['react-native-worklets/plugin', bundleMode] : 'react-native-worklets/plugin',
      ],
    };
  };
}

const oxyBabelPreset = createOxyBabelConfig();

module.exports = oxyBabelPreset;
module.exports.createOxyBabelConfig = createOxyBabelConfig;
