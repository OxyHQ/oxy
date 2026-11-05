const path = require('node:path');

const shared = {
  transformIgnorePatterns: [],
  testMatch: ['<rootDir>/__tests__/**/*.test.tsx'],
  moduleNameMapper: {
    '\\.(woff2?|otf)$': '<rootDir>/__tests__/asset-stub.js',
    '^@peable\\.to/sdk/display$': '<rootDir>/node_modules/@peable.to/sdk/dist/esm/display.js',
  },
};

const ios = require('jest-expo/ios/jest-preset');
const reactNativeMacOS = path.dirname(require.resolve('react-native-macos/package.json'));
const babelJest = Object.keys(ios.transform).find((key) => Array.isArray(ios.transform[key]));

/**
 * react-native-macos 0.81, resolved the way Astro's Metro config does it
 * (`react-native` -> `react-native-macos`, platform `macos`, then `native`).
 */
const macos = {
  ...ios,
  ...shared,
  displayName: 'macos',
  haste: { defaultPlatform: 'macos', platforms: ['macos', 'native'] },
  moduleFileExtensions: ios.moduleFileExtensions.map((extension) =>
    extension.replace(/^ios\./, 'macos.'),
  ),
  resolver: path.join(reactNativeMacOS, 'jest/resolver.js'),
  testEnvironment: path.join(reactNativeMacOS, 'jest/react-native-env.js'),
  transform: {
    ...ios.transform,
    [babelJest]: ['babel-jest', { caller: { name: 'metro', bundler: 'metro', platform: 'macos' } }],
  },
  moduleNameMapper: {
    ...ios.moduleNameMapper,
    ...shared.moduleNameMapper,
    '^react-native$': reactNativeMacOS,
    '^react-native/(.*)$': `${reactNativeMacOS}/$1`,
  },
  setupFiles: [
    path.join(reactNativeMacOS, 'jest/setup.js'),
    require.resolve('jest-expo/src/preset/setup.js'),
    '<rootDir>/__tests__/setup.js',
    '<rootDir>/__tests__/setup-native.js',
    '<rootDir>/__tests__/setup-macos.js',
  ],
};

module.exports = {
  testTimeout: 30000,
  projects: [
    {
      ...shared,
      displayName: 'ios',
      preset: 'jest-expo/ios',
      setupFiles: [
        '<rootDir>/__tests__/setup.js',
        '<rootDir>/__tests__/setup-native.js',
        '<rootDir>/__tests__/setup-ios.js',
      ],
    },
    {
      ...shared,
      displayName: 'web',
      preset: 'jest-expo/web',
      setupFiles: ['<rootDir>/__tests__/setup.js', '<rootDir>/__tests__/setup-web.js'],
    },
    macos,
  ],
};
