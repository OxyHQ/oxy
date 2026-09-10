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
 * The peer packages (`babel-preset-expo`, `babel-plugin-module-resolver`,
 * `react-native-worklets`) resolve from the consuming app's node_modules, where
 * Expo already installs them.
 *
 * @param {import('@babel/core').ConfigAPI} api
 * @returns {import('@babel/core').TransformOptions}
 */
module.exports = function oxyBabelPreset(api) {
  api.cache(true);
  return {
    presets: [
      ['babel-preset-expo', { unstable_transformImportMeta: true }],
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
      // Must be LAST.
      'react-native-worklets/plugin',
    ],
  };
};
