/**
 * Refuses `bun test` in a package that is configured for jest.
 *
 * Wired in as `[test].preload` from a package's own `bunfig.toml`, so it runs
 * before bun's runner loads a single test file and aborts the whole run.
 *
 * Bun ships its own test runner under a command name one character away from
 * `bun run test`, and that runner does not read `jest.config.*` at all. It
 * silently drops every setting there — `moduleNameMapper`, `setupFiles`, the
 * `ts-jest` preset, `testEnvironment` — and its `jest` global is a partial
 * shim: `fn` / `spyOn` / `mock` / timers are present, but the whole module
 * registry family is missing (`resetModules`, `isolateModules`,
 * `isolateModulesAsync`, `doMock`, `unmock`, `requireActual`, `setMock`), and
 * `mock.module` cannot express a virtual (unresolvable) module at all.
 *
 * The danger is not that `bun test` fails — it is that it fails PARTIALLY and
 * reports a plausible number:
 *
 *   @oxyhq/protocol   bun run test 137/137 pass   |  bun test 134 pass / 3 fail
 *   @oxyhq/core       bun run test 1282/1282 pass |  bun test 1183 pass / 38 fail
 *   @oxyhq/api        bun run test 2091/2091 pass |  bun test 329 pass / 214 fail
 *
 * Core's is the worse of the two: nothing in that output names a runner
 * problem, so 38 failures in a 1200-test suite read as a genuine regression.
 * This has already cost real work — protocol's `134 pass / 3 fail` was taken
 * for a regression and an agent was dispatched to rewrite a file that was never
 * broken. So this refuses outright rather than half-running the suite.
 *
 * `bunfig.toml` is resolved from the working directory and bun never walks up,
 * so a package-level bunfig covers invocations made FROM that package — the
 * common case. It cannot cover `bun test packages/<name>` from the repo root;
 * @oxyhq/protocol carries `src/__tests__/runnerGuard.test.ts` as a second layer
 * that travels with the tests.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const cwd = process.cwd();

const packageName = (() => {
  const manifest = join(cwd, 'package.json');
  if (!existsSync(manifest)) {
    return cwd;
  }
  const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
  return parsed.name ?? cwd;
})();

const jestConfig = ['jest.config.cjs', 'jest.config.js', 'jest.config.mjs', 'jest.config.ts'].find(
  (candidate) => existsSync(join(cwd, candidate)),
);

/**
 * Settings bun's runner will ignore. Named individually so the message states
 * what is actually lost in THIS package rather than a generic warning.
 */
const ignoredSettings =
  jestConfig === undefined
    ? []
    : (['preset', 'moduleNameMapper', 'setupFiles', 'setupFilesAfterEach', 'testEnvironment'] as const).filter(
        (setting) => readFileSync(join(cwd, jestConfig), 'utf8').includes(setting),
      );

console.error(
  [
    '',
    `${packageName} does not support \`bun test\`.`,
    '',
    '  Run  bun run test  (note the `run`) — the declared script, which invokes',
    `  jest and honours ${jestConfig ?? 'the jest config'}.`,
    '',
    "  `bun test` is bun's OWN runner. It never reads a jest config, so it drops",
    `  every setting in ${jestConfig ?? 'that file'}${
      ignoredSettings.length > 0 ? ` — here: ${ignoredSettings.join(', ')}` : ''
    },`,
    "  and its `jest` global omits the module registry: resetModules,",
    '  isolateModules, isolateModulesAsync, doMock, unmock, requireActual,',
    '  setMock. `mock.module` cannot stand in for doMock(..., {virtual:true}).',
    '',
    '  It does not fail cleanly — it half-runs the suite and prints a plausible',
    '  pass/fail count. Do not read that count as a result.',
    '',
  ].join('\n'),
);

process.exit(1);
