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
    '^@oxyhq/bloom/theme$': '<rootDir>/__mocks__/bloom-theme.ts',
    '^expo-router$': '<rootDir>/__mocks__/expo-router.tsx',
    '^expo-secure-store$': '<rootDir>/__mocks__/expo-secure-store.ts',
    '^@expo/vector-icons(/.*)?$': '<rootDir>/__mocks__/expo-vector-icons.tsx',
  },
  testTimeout: 10000,
};
