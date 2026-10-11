// Pin the zone so `date.test.ts`'s DST cases test a real transition on every
// machine — CI runs in UTC, which has none, and a DST test there passes
// vacuously. Set here (not in the test) because jest hands each test file a
// COPY of `process.env`, so assigning TZ inside a test never reaches V8. The
// test asserts the transition exists before relying on it.
process.env.TZ = 'America/New_York';

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleNameMapper: {
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
          isolatedModules: true,
          target: 'es2020',
          lib: ['es2020', 'dom'],
        },
      },
    ],
  },
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
};
