/**
 * Reanimated 4 and react-native-worklets 0.13 run their JS implementations under Jest: their own
 * resolver (`react-native-reanimated/jest/resolver`, which chains worklets') resolves their files
 * without the `.native` extensions. `withWorklets(base)` lays it over a preset's resolver.
 */
const reanimated = require('react-native-reanimated/jest/resolver');

const withWorklets = (base) => (request, options) =>
  reanimated(request, {
    ...options,
    defaultResolver: (inner, innerOptions) =>
      base(inner, { ...innerOptions, defaultResolver: options.defaultResolver }),
  });

module.exports = withWorklets(require('@react-native/jest-preset/jest/resolver'));
module.exports.withWorklets = withWorklets;
