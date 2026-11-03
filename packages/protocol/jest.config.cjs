/**
 * Jest config for @oxy.so/protocol.
 *
 * `@oxy.so/contracts` is resolved from its TypeScript SOURCE (mirroring
 * `packages/api/jest.config.js` and `packages/node/jest.config.cjs`) so the
 * protocol tests never depend on the contracts package being built first.
 * Runtime dependencies resolve normally from node_modules; the ESM-only
 * `@noble/*` ones are lowered to CommonJS (`scripts/jest-esm-only.cjs`).
 *
 * @type {import('jest').Config}
 */
const {
  NOBLE_ESM_PACKAGES,
  esmOnlyTransform,
  esmOnlyTransformIgnorePattern,
} = require('../../scripts/jest-esm-only.cjs');

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@oxy.so/contracts$': '<rootDir>/../contracts/src/index.ts',
    '^@oxy.so/contracts/client$': '<rootDir>/../contracts/src/client/index.ts',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        diagnostics: false,
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'bundler',
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          resolveJsonModule: true,
          isolatedModules: true,
          target: 'es2020',
          lib: ['es2020', 'dom'],
          skipLibCheck: true,
        },
      },
    ],
    ...esmOnlyTransform(NOBLE_ESM_PACKAGES),
  },
  transformIgnorePatterns: [esmOnlyTransformIgnorePattern(NOBLE_ESM_PACKAGES)],
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
  testTimeout: 10000,
};
