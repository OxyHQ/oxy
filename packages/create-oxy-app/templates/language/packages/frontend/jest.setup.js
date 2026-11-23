// The native libraries' Jest stand-ins: Jest runs no native runtime. Worklets
// and Reanimated ship their own mocks (with `resolver` in jest.config.js, which
// picks their non-native initialisers); Bloom's press animation reads
// `useReducedMotion`, which Reanimated's mock leaves out.
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('react-native-reanimated', () => ({
  ...require('react-native-reanimated/mock'),
  useReducedMotion: () => false,
}));
require('react-native-reanimated').setUpTests();

require('react-native-gesture-handler/jestSetup');
jest.mock('react-native-keyboard-controller', () =>
  require('react-native-keyboard-controller/jest'),
);
