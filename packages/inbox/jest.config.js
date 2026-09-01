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
  testMatch: ['<rootDir>/__tests__/**/*.(test|spec).(ts|tsx)'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^@oxyhq/core$': '<rootDir>/../core/src/index.ts',
    '^@oxyhq/contracts$': '<rootDir>/../contracts/src/index.ts',
    // Native modules the app imports but that cannot load under Node. The
    // `@oxyhq/services` stub also stands in for the SDK's `expo-notifications`
    // adapter, so no `expo-*` module is reachable from a test at all.
    '^react-native$': '<rootDir>/__mocks__/react-native.ts',
    '^@oxyhq/services$': '<rootDir>/__mocks__/oxyhq-services.ts',
  },
  testTimeout: 10000,
};
