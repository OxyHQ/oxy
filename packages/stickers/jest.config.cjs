/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        diagnostics: false,
        tsconfig: {
          module: 'commonjs',
          moduleResolution: 'node',
          isolatedModules: true,
          target: 'es2020',
          jsx: 'react-jsx',
          lib: ['es2020', 'dom'],
        },
      },
    ],
  },
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts?(x)'],
};
