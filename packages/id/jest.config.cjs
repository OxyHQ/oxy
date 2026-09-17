/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Resolve workspace packages from SOURCE so the suite needs no prior build.
    '^@oxy.so/contracts$': '<rootDir>/../contracts/src/index.ts',
    '^@oxy.so/protocol$': '<rootDir>/../protocol/src/index.ts',
    '^@oxy.so/protocol/secp256k1$': '<rootDir>/../protocol/src/secp256k1.ts',
    '^@oxy.so/core$': '<rootDir>/../core/src/index.ts',
    '^@oxy.so/telemetry/collector$': '<rootDir>/../telemetry/src/collector.ts',
    '^@oxy.so/telemetry/socket$': '<rootDir>/../telemetry/src/socket.ts',
    '^@oxy.so/telemetry/browser$': '<rootDir>/../telemetry/src/browser.ts',
  },
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { diagnostics: false, tsconfig: { module: 'commonjs', moduleResolution: 'node', esModuleInterop: true, target: 'es2020', lib: ['es2020', 'dom'], skipLibCheck: true, isolatedModules: true } }],
  },
};
