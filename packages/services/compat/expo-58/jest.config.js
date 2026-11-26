const fs = require('node:fs');
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
const reactNative = path.dirname(require.resolve('react-native/package.json'));
const reactNativeMacOS = path.dirname(require.resolve('react-native-macos/package.json'));
/**
 * A mapping jest-expo points into react-native, pointed into react-native-macos instead. An
 * entry point react-native-macos 0.83 does not ship fails to resolve, as in Astro's Metro
 * (`__tests__/absent-entry-point.js`).
 */
const toMacOS = (target) => {
  if (target !== reactNative && !target.startsWith(`${reactNative}/`)) return target;
  const macos = `${reactNativeMacOS}${target.slice(reactNative.length)}`;
  return target.includes('$') || fs.existsSync(macos)
    ? macos
    : '<rootDir>/__tests__/absent-entry-point.js';
};
const babelJest = Object.keys(ios.transform).find((key) => Array.isArray(ios.transform[key]));

/**
 * react-native-macos 0.83, resolved the way Astro's Metro config does it
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
  resolver: '<rootDir>/__tests__/resolver-macos.js',
  testEnvironment: path.join(reactNativeMacOS, 'jest/react-native-env.js'),
  transform: {
    ...ios.transform,
    // jest-expo's transform, for the macOS platform.
    [babelJest]: [
      ios.transform[babelJest][0],
      {
        ...ios.transform[babelJest][1],
        caller: { ...ios.transform[babelJest][1].caller, platform: 'macos' },
      },
    ],
  },
  moduleNameMapper: {
    ...Object.fromEntries(
      Object.entries(ios.moduleNameMapper).map(([request, target]) => [request, toMacOS(target)]),
    ),
    ...shared.moduleNameMapper,
    // react-native-macos's mocks, through React Native 0.88's mockComponent (see the file).
    '^\\.\\./mockComponent$': '<rootDir>/__tests__/macos-mock-component.js',
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
      resolver: '<rootDir>/__tests__/resolver.js',
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
