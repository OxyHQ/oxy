const { computeMaxWorkers } = require('./jest.workerCount.cjs');

// Keep this value shared with global setup: every Jest worker owns one isolated
// Postgres database. `jest.workerCount.cjs` documents the measured stability
// limit and is the only place where it may be changed.
const MAX_WORKERS = computeMaxWorkers();

module.exports = {
  maxWorkers: MAX_WORKERS,
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Provisions one throwaway, fully-migrated Postgres database per worker, then
  // drops them all. A reachable Postgres is a hard prerequisite of this suite —
  // see jest.globalSetup.ts and jest.setupWorkerDatabase.cjs.
  globalSetup: '<rootDir>/jest.globalSetup.ts',
  globalTeardown: '<rootDir>/jest.globalTeardown.ts',
  setupFiles: ['<rootDir>/jest.setupWorkerDatabase.cjs'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.cjs'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    // Resolve @oxyhq/contracts from its TypeScript SOURCE so api tests do not
    // depend on the contracts package being built first (its dist is absent in
    // the CI `api-test` job). ts-jest transforms the source via the transform
    // regex below; the contracts source only imports `zod`, which resolves
    // normally from node_modules.
    '^@oxyhq/contracts$': '<rootDir>/../contracts/src/index.ts',
    // The protocol node subpath (NodeClient, used by nodeSync.service) — resolve
    // from source like the protocol root so the api-test job needs no prior build.
    '^@oxyhq/protocol/node$': '<rootDir>/../protocol/src/node/index.ts',
    // Same rationale for @oxyhq/protocol (canonicalize / signedRecordSigningInput /
    // computeRecordId, imported by the signed-record + civic + node-sync services):
    // resolve from source so the api-test job needs no prior protocol build.
    '^@oxyhq/protocol$': '<rootDir>/../protocol/src/index.ts',
    // Same rationale for @oxyhq/core (getNormalizedUserHandle in did.service.ts,
    // User model, etc.) and @oxyhq/core/server (safeFetch/SsrfRejection): resolve
    // from source so api tests do not depend on a prior core build.
    '^@oxyhq/core/server$': '<rootDir>/../core/src/server/index.ts',
    '^@oxyhq/core$': '<rootDir>/../core/src/index.ts',
    '^@oxyhq/federation$': '<rootDir>/../federation/src/index.ts',
    '^@oxyhq/federation/node$': '<rootDir>/../federation/src/node/index.ts',
    // @oxyhq/db is mapped to source for the same consistency reason — the
    // schema gates and every schema module reach it, and a failure should
    // point at the source under review rather than a build artefact.
    //
    // It is NOT, however, the same guarantee: unlike the four above, these
    // entries do not make the suite runnable without a build. `jest.globalSetup.ts`
    // provisions each worker's database by SPAWNING `bun run db:migrate`, a
    // separate process no `moduleNameMapper` reaches, and `src/db/migrate.ts`
    // imports `@oxyhq/db/migrate` — which resolves into `dist/`. So `ci.yml`'s
    // api-test job builds the package explicitly; see the comment on that step.
    // Do not delete the build believing this covers it.
    '^@oxyhq/db$': '<rootDir>/../db/src/index.ts',
    '^@oxyhq/db/migrate$': '<rootDir>/../db/src/migrate/index.ts',
    '^@oxyhq/db/expiry$': '<rootDir>/../db/src/expiry.ts',
    '^@oxyhq/db/testing$': '<rootDir>/../db/src/testing.ts',
    '^@oxyhq/db/assert$': '<rootDir>/../db/src/assert/index.ts',
    // NodeNext source uses `.js` extensions on relative imports of TS files
    // (e.g. `import { Topic } from '../models/Topic.js'`). ts-jest resolves
    // these inside source, but jest's own resolver (used by `jest.mock(...)`
    // string paths) does not strip the extension. Map relative `.js` imports
    // back to their extensionless form so both source loads and `jest.mock`
    // calls resolve to the `.ts` file.
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      // OFF, not `{ ignoreCodes: [...] }`. The two are not "the same setting
      // with a filter": `false` disables type-checking in the transform
      // entirely, while ANY object turns the full check ON and merely excludes
      // the listed codes. Narrowing it to silence the TS151002 config warning
      // therefore enabled type-checking across a suite that has never had it,
      // and 165 of 295 suites stopped running — TS2550 `Property 'cause' does
      // not exist on type 'Error'` (a `lib` question), TS2307 for
      // `@oxyhq/federation` (whose `dist` this job does not build), TS2339,
      // TS7006. None of them is a test failure; the suites never execute.
      //
      // `tsc --noEmit` is where this package's types are gated. Turning the
      // check on here as well is a defensible goal, but it is a real project —
      // those 165 suites have to be fixed first — not a side effect of quieting
      // a warning. The TS151002 line is noise on stderr and costs nothing.
      diagnostics: false,
    }],
  },
  testMatch: ['**/__tests__/**/*.ts', '**/*.test.ts'],
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/*.test.ts',
    '!src/**/__tests__/**',
  ],
  testTimeout: 10000,
};
