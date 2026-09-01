/**
 * Jest config for @oxyhq/federation.
 *
 * The `.` entry is pure types (the connector contract + normalized DTOs) with no
 * runtime dependencies on other workspace packages. Behavioural unit tests live
 * alongside the engine code (HTTP signatures, actor resolution, delivery).
 *
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
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
  moduleNameMapper: {
    // Resolve @oxyhq/contracts from TypeScript source so federation tests do not
    // depend on contracts being built first (actorObject.ts imports AccountKind).
    '^@oxyhq/contracts$': '<rootDir>/../contracts/src/index.ts',
  },
};
