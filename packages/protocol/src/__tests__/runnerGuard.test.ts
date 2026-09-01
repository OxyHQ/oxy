/**
 * Asserts that this suite is running under the runner it is configured for.
 *
 * @oxyhq/protocol is a JEST package: `bun run test` -> `jest` -> `jest.config.cjs`.
 * Bun also ships its OWN test runner, one character away (`bun test`), which
 * ignores `jest.config.cjs` entirely. The two disagree, and the disagreement is
 * silent — bun's runner half-runs the suite and prints a plausible pass/fail
 * count that has already been mistaken for a real regression.
 *
 * `bunfig.toml`'s `[test].preload` refuses `bun test` when it is run FROM this
 * package directory, which is the common case. It cannot cover
 * `bun test packages/protocol` from the repo root, because bun resolves
 * `bunfig.toml` from the working directory and never walks up. This file is the
 * second layer: it travels with the tests, so it fires wherever they are run
 * from.
 *
 * Both halves of the config are checked, because both are load-bearing:
 *
 *  - `moduleNameMapper` resolves `@oxyhq/contracts` from TypeScript SOURCE, so
 *    the tests never depend on that package being built first. Deleting it (or
 *    skipping it, as bun's runner does) breaks six suites on a clean checkout
 *    with `Cannot find module '@oxyhq/contracts'`.
 *  - The jest module registry (`resetModules` / `isolateModules` /
 *    `isolateModulesAsync` / `doMock`) is what `optionalNativePeers.test.ts`
 *    uses to simulate an optional peer that does not resolve AT ALL. bun 1.3.14
 *    provides `fn`/`spyOn`/`mock`/timers but none of the registry family, and
 *    its `mock.module` cannot express a virtual (unresolvable) module.
 *
 * The registry check runs at MODULE scope and exits the process rather than
 * failing an assertion: a failed assertion would still let the run finish and
 * print `134 pass / 4 fail`, which is the exact failure mode being guarded
 * against. The predicate is the capability itself, not the runner's name, so a
 * future bun that implements the registry stops tripping it on its own.
 */

import { resolve } from 'node:path';

/** The jest APIs this package's suites call. Absent ones cannot be shimmed. */
const REQUIRED_REGISTRY_APIS = [
  'resetModules',
  'isolateModules',
  'isolateModulesAsync',
  'doMock',
] as const;

const registry = jest as unknown as Record<string, unknown>;
const missingRegistryApis = REQUIRED_REGISTRY_APIS.filter(
  (name) => typeof registry[name] !== 'function',
);

if (missingRegistryApis.length > 0) {
  console.error(
    [
      '',
      '@oxyhq/protocol was started with a runner that is not jest.',
      '',
      `  Missing jest APIs this suite calls: ${missingRegistryApis.map((name) => `jest.${name}`).join(', ')}`,
      '',
      '  Run  bun run test  (note the `run`) from packages/protocol — the',
      '  declared script, which invokes jest and honours jest.config.cjs.',
      '',
      "  `bun test` uses bun's own runner, which ignores jest.config.cjs. It",
      '  does not fail cleanly: it half-runs the suite and prints a plausible',
      '  pass/fail count. Aborting so that count is never produced.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

describe('test runner configuration', () => {
  it('resolves @oxyhq/contracts from source via moduleNameMapper', () => {
    // Not a style preference: without the mapper the suites require
    // packages/contracts/dist, which does not exist on a clean checkout.
    expect(require.resolve('@oxyhq/contracts')).toBe(
      resolve(__dirname, '..', '..', '..', 'contracts', 'src', 'index.ts'),
    );
  });

  it('exposes the jest module registry the optional-peer suite depends on', () => {
    // Reached only when the module-scope guard above did not fire; keeps the
    // requirement visible as an assertion rather than only as a process exit.
    expect(missingRegistryApis).toEqual([]);
  });
});
