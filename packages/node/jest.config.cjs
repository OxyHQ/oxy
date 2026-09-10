/**
 * Jest config for @oxy.so/node.
 *
 * This package is `"type": "module"`, so the config file is `.cjs` (CommonJS)
 * and ts-jest transforms the TypeScript sources to CommonJS for the test run
 * (the same pattern `@oxy.so/core` uses), independent of the ESM build output.
 *
 * Workspace deps are resolved from their TypeScript SOURCE — mirroring
 * `packages/api/jest.config.js` — so the node tests never depend on
 * `@oxy.so/contracts` / `@oxy.so/protocol` / `@oxy.so/core` being built first
 * (matching the CI convention where workspace deps are not pre-built for the
 * test job):
 *  - `@oxy.so/contracts`  → `verify.ts` imports the runtime `signedRecordEnvelopeSchema`.
 *  - `@oxy.so/protocol`   → `verify.ts` reuses `verifyEnvelopeSignature` /
 *                          `computeRecordId`, and the tests sign real envelopes
 *                          with `signMessage` / `signedRecordSigningInput`.
 *  - `@oxy.so/core`       → the tests generate keypairs with `KeyManager`.
 *  - `@oxy.so/core/server`→ owner-key equality uses `verifySecret`.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@oxy.so/contracts$': '<rootDir>/../contracts/src/index.ts',
    '^@oxy.so/protocol/node$': '<rootDir>/../protocol/src/node/index.ts',
    '^@oxy.so/protocol$': '<rootDir>/../protocol/src/index.ts',
    '^@oxy.so/protocol/secp256k1$': '<rootDir>/../protocol/src/secp256k1.ts',
    '^@oxy.so/core/server$': '<rootDir>/../core/src/server/index.ts',
    '^@oxy.so/core$': '<rootDir>/../core/src/index.ts',
    // NodeNext ESM source uses `.js` extensions on relative imports of TS files.
    // ts-jest resolves these inside source, but jest's own resolver does not strip
    // the extension. Map relative `.js` imports back to extensionless so both source
    // loads and any `jest.mock(...)` string paths resolve to the `.ts` file.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        diagnostics: false,
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          resolveJsonModule: true,
          isolatedModules: true,
          target: 'es2020',
          skipLibCheck: true,
        },
      },
    ],
  },
  testMatch: ['<rootDir>/src/**/*.test.ts'],
  testTimeout: 15000,
};
