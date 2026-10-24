/**
 * @oxy.so/app-preset — Babel config factory.
 *
 * In development the config is exactly `babel-preset-expo`, nothing else.
 * Expo's oxc transformer (Noxcturnal, `experiments.noxcturnalTransformWorker`,
 * which the preset's config plugin turns on) runs only when the project's Babel
 * config resolves to the bare Expo preset; one extra plugin or preset option
 * sends every file back to Babel. Everything the config used to add is covered
 * without it in SDK 58: `babel-preset-expo` adds `react-native-worklets/plugin`
 * and the `import.meta` transform itself, and Metro resolves `@/` from the
 * app's `tsconfig.json` paths.
 *
 * A production build adds the build-id inliner (`./inline-oxy-build-id`).
 * Production stays on Babel either way: Noxcturnal keeps the requires of dead
 * platform branches, pulling native-only packages into a web bundle.
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
 * synchronous call to it from a worker runtime throws. Its plugin options make
 * the config non-default, so a Bundle Mode app stays on Babel.
 *
 * The peer packages (`babel-preset-expo`, `react-native-worklets`) resolve from
 * the consuming app's node_modules, where Expo already installs them.
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
    const production = api.cache.using(() => process.env.NODE_ENV === 'production');
    const plugins = [
      // The build id `@oxy.so/services` busts its persisted caches on.
      ...(production ? [require.resolve('./inline-oxy-build-id')] : []),
      // In Bundle Mode the worklets plugin needs its options, so
      // babel-preset-expo must not add a second, option-less copy.
      ...(bundleMode ? [['react-native-worklets/plugin', bundleMode]] : []),
    ];
    return {
      presets: [bundleMode ? ['babel-preset-expo', { worklets: false }] : 'babel-preset-expo'],
      plugins,
    };
  };
}

const oxyBabelPreset = createOxyBabelConfig();

module.exports = oxyBabelPreset;
module.exports.createOxyBabelConfig = createOxyBabelConfig;
