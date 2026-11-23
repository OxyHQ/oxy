require('react-native-gesture-handler/jestSetup');

jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

// react-native-worklets 0.13 has no UI runtime under Jest: its own mock stands in for it
// (gesture-handler 3 asks it for the UI runtime as it installs).
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
