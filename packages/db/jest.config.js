/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  // ts-jest resolves its own compiler options by reading the nearest
  // tsconfig.json (this package's, shared with the tsc build configs) and
  // layering this `tsconfig` override on top. tsconfig.json sets
  // `isolatedModules: true` so the tsc build configs stay safe for
  // single-file bundler transpilation downstream; ts-jest reads that same
  // flag as an instruction to skip creating a TypeScript LanguageService and
  // fall back to per-file `transpileModule` with zero type diagnostics, which
  // silently dropped type-checking for every file Jest transforms, tests
  // included. Overriding it back to `false` here (and only here) restores
  // the LanguageService — and with it real diagnostics on test files — without
  // touching the tsconfig.json the tsc builds depend on.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: { isolatedModules: false } }],
  },
};
