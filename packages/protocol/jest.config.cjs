/**
 * Jest config for @oxyhq/protocol.
 *
 * `@oxyhq/contracts` is resolved from its TypeScript SOURCE (mirroring
 * `packages/api/jest.config.js` and `packages/node/jest.config.cjs`) so the
 * protocol tests never depend on the contracts package being built first.
 * Runtime dependencies resolve normally from node_modules.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@oxyhq/contracts$': '<rootDir>/../contracts/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      diagnostics: false,
      tsconfig: {
        module: 'commonjs',
        moduleResolution: 'node',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        resolveJsonModule: true,
        isolatedModules: true,
        target: 'es2020',
        lib: ['es2020', 'dom'],
        skipLibCheck: true,
      },
    }],
  },
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
  testTimeout: 10000,
};
