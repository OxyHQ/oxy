/**
 * An Expo app's Babel config, and one rule for Bloom 23's layout: Metro takes Bloom's `src` (the
 * `react-native` export condition) through the worklets plugin like the app's own code, while its
 * compiled `lib` (what the web and Jest resolve) already holds its worklets and must not take the
 * plugin a second time (babel-preset-expo's `reanimated: false` leaves it out; its `worklets`
 * option does not reach the web transform). The rule tests a function, not a RegExp: Expo 58's
 * Metro transforms some modules without a filename, and Babel refuses a RegExp `test` then.
 */
const BLOOM_LIB = /[\\/]node_modules[\\/]@oxy\.so[\\/]bloom[\\/]lib[\\/]/;

module.exports = (api) => {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    overrides: [
      {
        test: (filename) => filename !== undefined && BLOOM_LIB.test(filename),
        presets: [['babel-preset-expo', { reanimated: false }]],
      },
    ],
  };
};
