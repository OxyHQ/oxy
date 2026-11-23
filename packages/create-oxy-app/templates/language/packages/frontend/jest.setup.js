// The native libraries' Jest stand-ins: Jest runs no native runtime. Worklets
// and Reanimated ship their own mocks (with `resolver` in jest.config.js, which
// picks their non-native initialisers). Two corrections to Reanimated's: Bloom's
// press animation reads `useReducedMotion`, which it leaves out, and Bloom
// samples its curves at import (`Easing.elastic(0.8)(t)`), where its `Easing`
// returns its argument instead of a curve, so the real `Easing` (plain math)
// replaces it.
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('react-native-reanimated', () => ({
  ...require('react-native-reanimated/mock'),
  Easing: jest.requireActual('react-native-reanimated/src/Easing').Easing,
  useReducedMotion: () => false,
}));
require('react-native-reanimated').setUpTests();

require('react-native-gesture-handler/jestSetup');
jest.mock('react-native-keyboard-controller', () =>
  require('react-native-keyboard-controller/jest'),
);
