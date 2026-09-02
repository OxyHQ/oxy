/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  moduleNameMapper: {
    // Resolve workspace deps from TypeScript SOURCE so core tests do not depend
    // on packages being built first (mirrors packages/api/jest.config.js).
    '^@oxyhq/contracts$': '<rootDir>/../contracts/src/index.ts',
    // Resolve @oxyhq/protocol from its TypeScript SOURCE so core tests do not
    // depend on the protocol package being built first, and so the
    // `jest.mock('@oxyhq/protocol', () => ({ ...jest.requireActual(...) }))`
    // overrides in the KeyManager suites resolve deterministically.
    '^@oxyhq/protocol$': '<rootDir>/../protocol/src/index.ts',
    '^@oxyhq/protocol/secp256k1$': '<rootDir>/../protocol/src/secp256k1.ts',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      diagnostics: false,
      tsconfig: {
        module: 'commonjs',
        moduleResolution: 'node',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        target: 'es2020',
        lib: ['es2020', 'dom'],
        skipLibCheck: true,
        isolatedModules: true,
      },
    }],
  },
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
  testTimeout: 10000,
};
