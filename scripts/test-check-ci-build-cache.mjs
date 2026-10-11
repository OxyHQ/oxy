#!/usr/bin/env bun
/**
 * Exercises check-ci-build-cache.mjs against mutated copies of the REAL
 * ci.yml, ci-build-cache.yml, turbo.json and workspace manifests.
 *
 * The check guards a security boundary (nothing a pull request runs may write
 * what the merge queue reads) and a correctness one (a cache hit may skip a
 * compile, never a test, never with an input missing from the hash). Every case
 * breaks exactly one of those properties the way a plausible edit would, and
 * asserts the check goes red naming it; the unmutated tree is the positive
 * control.
 *
 * Offline, no install: the check reads YAML and JSON through Bun.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkScript = join(repoRoot, 'scripts', 'check-ci-build-cache.mjs');
const CI = join('.github', 'workflows', 'ci.yml');
const WRITER = join('.github', 'workflows', 'ci-build-cache.yml');
const TURBO = 'turbo.json';

const failures = [];
const fixtures = [];
let cases = 0;

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'oxy-ci-build-cache-'));
  fixtures.push(root);
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  for (const path of [
    CI,
    WRITER,
    TURBO,
    'package.json',
    ...manifest.workspaces.packages.map((dir) => join(dir, 'package.json')),
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(repoRoot, path), join(root, path));
  }
  return root;
}

function expectCheck(name, mutations, expectedCode, fragment) {
  cases += 1;
  const root = createFixture();
  for (const [path, replacer] of mutations) {
    const before = readFileSync(join(root, path), 'utf8');
    const after = replacer(before);
    if (after === before) {
      failures.push(`${name}: the mutation of ${path} changed nothing — the case proves nothing.`);
      return;
    }
    writeFileSync(join(root, path), after);
  }
  let code = 0;
  let output = '';
  try {
    output = execFileSync('bun', [checkScript], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    code = error.status ?? 1;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  if (code !== expectedCode) {
    failures.push(`${name}: expected exit ${expectedCode}, got ${code}.\n${output}`);
  } else if (!output.includes(fragment)) {
    failures.push(`${name}: output does not contain ${JSON.stringify(fragment)}.\n${output}`);
  }
}

const turboJson = (edit) => [
  TURBO,
  (text) => {
    const value = JSON.parse(text);
    edit(value);
    return `${JSON.stringify(value, null, 2)}\n`;
  },
];
const ci = (replacer) => [CI, replacer];
const writer = (replacer) => [WRITER, replacer];
const RESTORE = 'actions/cache/restore@';

// ── Positive control ───────────────────────────────────────────────────────
expectCheck('the-real-tree-passes', [], 0, 'only `build` is cacheable');

// ── A. A hit skips a compile, never a test, never a missing input ──────────
expectCheck(
  'a-cacheable-test-task-fails',
  [
    turboJson((t) => {
      delete t.tasks.test.cache;
    }),
  ],
  1,
  'task `test` is cacheable',
);
expectCheck(
  'a-new-cacheable-task-fails',
  [
    turboJson((t) => {
      t.tasks.typecheck = {};
    }),
  ],
  1,
  'task `typecheck` is cacheable',
);
expectCheck(
  'narrowed-build-inputs-fail',
  [
    turboJson((t) => {
      t.tasks.build.inputs = ['src/**'];
    }),
  ],
  1,
  'narrows `build.inputs`',
);
expectCheck(
  'empty-build-outputs-fail',
  [
    turboJson((t) => {
      t.tasks.build.outputs = [];
    }),
  ],
  1,
  '`build.outputs` is empty',
);
for (const file of ['bun.lock', 'package.json', 'bunfig.toml', 'tsconfig.json']) {
  expectCheck(
    `the-lockfile-family-${file}-must-be-hashed`,
    [
      turboJson((t) => {
        t.globalDependencies = t.globalDependencies.filter((f) => f !== file);
      }),
    ],
    1,
    `does not name ${file}`,
  );
}
expectCheck(
  'loose-env-mode-fails',
  [
    turboJson((t) => {
      t.envMode = 'loose';
    }),
  ],
  1,
  'envMode: loose',
);
expectCheck(
  'turbo-running-tests-fails',
  [
    ci((y) =>
      y.replace(
        'run: bunx turbo run build --filter=oxy-console...',
        'run: bunx turbo run test --filter=oxy-console...',
      ),
    ),
  ],
  1,
  'runs `turbo test`',
);
expectCheck(
  'the-root-test-script-fails',
  [
    ci((y) =>
      y.replace(
        "      - name: 'Console Tests: typecheck'\n",
        "      - name: all tests\n        run: bun run test\n      - name: 'Console Tests: typecheck'\n",
      ),
    ),
  ],
  1,
  'runs the ROOT `test` script',
);

// ── B. Nothing a pull request or queue run executes can write ──────────────
expectCheck(
  'a-saving-cache-action-in-ci-fails',
  [ci((y) => y.replace(RESTORE, 'actions/cache@'))],
  1,
  'which SAVES a cache',
);
expectCheck(
  'a-save-step-in-ci-fails',
  [ci((y) => y.replace(RESTORE, 'actions/cache/save@'))],
  1,
  'which SAVES a cache',
);
expectCheck(
  'a-remote-cache-in-ci-fails',
  [
    ci((y) =>
      y.replace('name: CI/CD Pipeline\n', 'name: CI/CD Pipeline\n\nenv:\n  TURBO_TOKEN: x\n'),
    ),
  ],
  1,
  'mentions TURBO_TOKEN',
);
expectCheck(
  'a-turbo-remote-cache-action-in-ci-fails',
  [ci((y) => y.replace(RESTORE, 'rharkor/caching-for-turbo@'))],
  1,
  'mentions caching-for-turbo',
);
for (const trigger of [
  'pull_request:\n',
  'merge_group:\n',
  'workflow_dispatch:\n',
  'pull_request_target:\n    branches: [main]\n',
]) {
  expectCheck(
    `the-writer-on-${trigger.split(':')[0]}-fails`,
    [writer((y) => y.replace('on:\n  push:\n', `on:\n  ${trigger}  push:\n`))],
    1,
    'must trigger on `push` to `main` and nothing else',
  );
}
expectCheck(
  'the-writer-on-another-branch-fails',
  [writer((y) => y.replace('    branches: [main]\n', '    branches: [main, develop]\n'))],
  1,
  'must trigger on `push` to `main` and nothing else',
);
expectCheck(
  'the-writer-with-write-permissions-fails',
  [
    writer((y) =>
      y.replace('permissions:\n  contents: read\n', 'permissions:\n  contents: write\n'),
    ),
  ],
  1,
  'must declare exactly `permissions: contents: read`',
);
expectCheck(
  'the-writer-restoring-first-fails',
  [
    writer((y) =>
      y.replace(
        '      - name: Install dependencies\n',
        '      - uses: actions/cache/restore@x\n        with:\n          path: .turbo/cache\n          key: k\n      - name: Install dependencies\n',
      ),
    ),
  ],
  1,
  'restores a cache before building',
);
expectCheck(
  'the-writer-saving-something-else-fails',
  [writer((y) => y.replace('          path: .turbo/cache\n', '          path: node_modules\n'))],
  1,
  'must save exactly one cache, `.turbo/cache`',
);

// ── Wiring: a cache that would silently never hit ──────────────────────────
expectCheck(
  'a-job-running-turbo-without-a-restore-fails',
  [
    ci((y) => {
      const start = y.indexOf('\n  packages-apps:\n');
      const at = y.indexOf('      - name: Restore the Turbo build cache (read-only)\n', start);
      const end = y.indexOf('\n\n', at);
      return y.slice(0, at) + y.slice(end + 2);
    }),
  ],
  1,
  'job `packages-apps` runs Turbo before restoring',
);
expectCheck(
  'a-mismatched-key-prefix-fails',
  [writer((y) => y.replace('key: turbo-build-', 'key: turbo-other-'))],
  1,
  'never matches',
);
expectCheck(
  'the-writer-not-building-console-fails',
  [writer((y) => y.replace(' --filter=oxy-console...', ''))],
  1,
  'asks Turbo to build oxy-console',
);
expectCheck(
  'ci-building-something-the-writer-does-not-fails',
  [
    ci((y) =>
      y.replace(
        'run: bunx turbo run build --filter=@oxy.so/contracts\n',
        'run: bunx turbo run build --filter=@oxy.so/ship\n',
      ),
    ),
  ],
  1,
  'asks Turbo to build @oxy.so/ship',
);

for (const root of fixtures) rmSync(root, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`check-ci-build-cache.mjs is BROKEN (${failures.length} of ${cases} case(s)):\n`);
  for (const failure of failures) console.error(`- ${failure}\n`);
  process.exit(1);
}
console.log(
  `check-ci-build-cache.mjs behaves: ${cases} cases — cacheable tasks, hash inputs, env mode, every ci.yml write ` +
    "path, the writer's triggers, permissions and fresh build, and the restore/save wiring.",
);
