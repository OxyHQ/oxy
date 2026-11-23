// Jest on Expo's preset, with the Bloom language compiler in front of its Babel
// transform: the compiler checks every chain against the language spec (an
// unknown modifier, a wrong argument count or a token outside its set fails the
// run, as it fails Metro), then babel-jest compiles the module with the app's
// own Babel config (@oxy.so/app-preset/babel), as Metro does.
const expoPreset = require('jest-expo/jest-preset');

const SOURCE = '\\.[jt]sx?$';

/** @type {import('jest').Config} */
module.exports = {
  preset: 'jest-expo',
  transform: {
    [SOURCE]: ['@oxy.so/bloom-language-compiler/jest', { upstream: expoPreset.transform[SOURCE] }],
  },
  // Expo's list, plus the Oxy packages, which ship their TypeScript source to
  // React Native (the `react-native` export condition).
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|@oxy\\.so))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
  // Reanimated 4.7's resolver (over worklets' own) resolves their initialisers
  // without the `.native` builds, which call a native runtime.
  resolver: 'react-native-reanimated/jest/resolver.js',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },
};
