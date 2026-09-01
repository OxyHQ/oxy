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
    '^@oxyhq/core$': '<rootDir>/../core/src/index.ts',
    '^@oxyhq/protocol$': '<rootDir>/../protocol/src/index.ts',
    '^@oxyhq/contracts$': '<rootDir>/../contracts/src/index.ts',
    // Mock heavy native modules with lightweight stubs.
    '^react-native$': '<rootDir>/__mocks__/react-native.ts',
    '^@react-native-async-storage/async-storage$':
      '<rootDir>/__mocks__/async-storage.ts',
    '^@oxyhq/services$': '<rootDir>/__mocks__/oxyhq-services.ts',
    // The push adapter ships behind its own entry point. It maps to the SAME
    // stub as the barrel so a test asserting on `installForegroundNotificationHandler`
    // sees the one `jest.fn()` instance no matter which specifier the code under
    // test imported it from.
    '^@oxyhq/services/notifications$': '<rootDir>/__mocks__/oxyhq-services.ts',
    '^@oxyhq/bloom/theme$': '<rootDir>/__mocks__/bloom-theme.ts',
    '^@oxyhq/bloom/composition-bar$': '<rootDir>/__mocks__/bloom-composition-bar.tsx',
    '^react-native-reanimated$': '<rootDir>/__mocks__/react-native-reanimated.ts',
    '^react-native-keyboard-controller$':
      '<rootDir>/__mocks__/react-native-keyboard-controller.ts',
    '^react-native-safe-area-context$':
      '<rootDir>/__mocks__/react-native-safe-area-context.ts',
    // App code imports one family per subpath so Metro bundles one font instead
    // of all 19; the barrel entry stays mapped for anything that still uses it.
    '^@expo/vector-icons(/.*)?$': '<rootDir>/__mocks__/expo-vector-icons.tsx',
    '^@shopify/react-native-skia$': '<rootDir>/__mocks__/react-native-skia.tsx',
    '^expo-router$': '<rootDir>/__mocks__/expo-router.tsx',
    '^expo-secure-store$': '<rootDir>/__mocks__/expo-secure-store.ts',
  },
  testTimeout: 10000,
};
