/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        diagnostics: false,
        tsconfig: {
          jsx: 'react-jsx',
          module: 'commonjs',
          moduleResolution: 'node',
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          strict: true,
          skipLibCheck: true,
          resolveJsonModule: true,
          isolatedModules: true,
          target: 'es2020',
          lib: ['es2020', 'dom'],
        },
      },
    ],
  },
  testMatch: [
    '<rootDir>/__tests__/**/*.(test|spec).(ts|tsx)',
  ],
    moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^@oxy.so/core$': '<rootDir>/../core/src/index.ts',
    '^@oxy.so/protocol$': '<rootDir>/../protocol/src/index.ts',
    '^@oxy.so/protocol/random$': '<rootDir>/../protocol/src/random.ts',
    '^@oxy.so/contracts$': '<rootDir>/../contracts/src/index.ts',
    // Mock heavy native modules with lightweight stubs.
    '^react-native$': '<rootDir>/__mocks__/react-native.ts',
    '^@react-native-async-storage/async-storage$':
      '<rootDir>/__mocks__/async-storage.ts',
    '^@oxy.so/services$': '<rootDir>/__mocks__/oxy-services.ts',
    // The push adapter ships behind its own entry point. It maps to the SAME
    // stub as the barrel so a test asserting on `installForegroundNotificationHandler`
    // sees the one `jest.fn()` instance no matter which specifier the code under
    // test imported it from.
    '^@oxy.so/services/notifications$': '<rootDir>/__mocks__/oxy-services.ts',
    // Fonts and images are assets to Metro and raw bytes to Jest — see the file.
    '\\.(woff2?|ttf|otf|eot|png|jpe?g|gif|webp|svg|lottie)$': '<rootDir>/__mocks__/file-asset.js',
    '^react-native-svg$': '<rootDir>/__mocks__/react-native-svg.js',
    '^@oxy.so/bloom/button$': '<rootDir>/__mocks__/bloom-button.tsx',
    '^@oxy.so/bloom/badge$': '<rootDir>/__mocks__/bloom-badge.tsx',
    '^@oxy.so/bloom/admonition$': '<rootDir>/__mocks__/bloom-admonition.tsx',
    '^@oxy.so/bloom/typography$': '<rootDir>/__mocks__/bloom-typography.tsx',
    '^@oxy.so/bloom/divider$': '<rootDir>/__mocks__/bloom-divider.tsx',
    '^@oxy.so/bloom/stat-bar$': '<rootDir>/__mocks__/bloom-stat-bar.tsx',
    '^@oxy.so/bloom/item$': '<rootDir>/__mocks__/bloom-item.tsx',
    '^@oxy.so/bloom/empty-state$': '<rootDir>/__mocks__/bloom-empty-state.tsx',
    '^@oxy.so/bloom/loading$': '<rootDir>/__mocks__/bloom-loading.tsx',
    // Every per-glyph icon subpath resolves to one inert stub — see the file.
    '^@oxy\\.so/bloom/icons/.*$': '<rootDir>/__mocks__/bloom-icon.js',
    '^@oxy.so/bloom/theme$': '<rootDir>/__mocks__/bloom-theme.ts',
    '^@oxy.so/bloom/composition-bar$': '<rootDir>/__mocks__/bloom-composition-bar.tsx',
    '^react-native-reanimated$': '<rootDir>/__mocks__/react-native-reanimated.ts',
    '^react-native-keyboard-controller$':
      '<rootDir>/__mocks__/react-native-keyboard-controller.ts',
    '^react-native-safe-area-context$':
      '<rootDir>/__mocks__/react-native-safe-area-context.ts',
    '^@shopify/react-native-skia$': '<rootDir>/__mocks__/react-native-skia.tsx',
    '^expo-router$': '<rootDir>/__mocks__/expo-router.tsx',
    '^expo-secure-store$': '<rootDir>/__mocks__/expo-secure-store.ts',
    '^expo$': '<rootDir>/__mocks__/expo.ts',
    '^expo-screen-capture$': '<rootDir>/__mocks__/expo-screen-capture.ts',
  },
  testTimeout: 10000,
};
