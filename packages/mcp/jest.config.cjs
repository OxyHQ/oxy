const core = require('../core/jest.config.cjs');

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  // Composition tests exercise the declared core dev dependency from source,
  // just as core's own suites do; CI must not rely on a previous local build.
  moduleNameMapper: {
    ...Object.fromEntries(
      Object.entries(core.moduleNameMapper).map(([pattern, target]) => [
        pattern,
        target.replaceAll('<rootDir>', '<rootDir>/../core'),
      ]),
    ),
    '^@oxy\\.so/core/server$': '<rootDir>/../core/src/server/index.ts',
  },
};
