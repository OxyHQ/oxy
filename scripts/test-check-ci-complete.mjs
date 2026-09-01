#!/usr/bin/env bun

/**
 * Exercises check-ci-complete.mjs against mutated copies of the REAL workflow it
 * guards.
 *
 * This gate needs its own tests more than most, because of what it is: once
 * `CI complete` is the single required status check, it is the only thing
 * between a merge and `main`. A gate that returns success no matter what it is
 * shown is strictly worse than no gate, since it is trusted. Every case below
 * therefore asserts a VERDICT and the REASON given for it — an aggregate that
 * goes red without naming which job failed is one nobody can act on.
 *
 * The four cases that matter are the four results GitHub can put in
 * `needs.*.result`, since collapsing any of them into the wrong bucket is a
 * real, shipped failure mode of this pattern:
 *
 *   success    → passes
 *   skipped    → passes when the job declares `if:`, fails when nothing explains
 *                it (collapse it into failure and every path-filtered pull
 *                request is blocked; collapse it into success and one `if: false`
 *                silently retires a suite)
 *   failure    → fails
 *   cancelled  → fails
 *
 * Fixtures are copies of `.github/workflows/ci.yml`, not hand-written
 * miniatures: a synthetic workflow would drift and start proving something about
 * the fixture rather than about CI. `NEEDS_JSON` is DERIVED from each fixture —
 * every job except the gate itself, reported `success` — so the coverage case is
 * the only one where a job is missing from it, and it is missing on purpose.
 *
 * Offline, and deliberately run with no `node_modules` anywhere in the fixture
 * root: the CI job runs this gate without `bun install`, exactly like the three
 * gates beside it, so both files must work with an empty dependency tree.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkScript = join(repoRoot, 'scripts', 'check-ci-complete.mjs');

const WORKFLOW = join('.github', 'workflows', 'ci.yml');
const GATE_JOB_ID = 'ci-complete';

const fixturePrefix = join(tmpdir(), 'oxy-ci-complete-');
const createdFixtures = [];
const failures = [];

function createFixture() {
  const root = mkdtempSync(fixturePrefix);
  createdFixtures.push(root);
  mkdirSync(join(root, dirname(WORKFLOW)), { recursive: true });
  cpSync(join(repoRoot, WORKFLOW), join(root, WORKFLOW));
  return root;
}

/** Rewrite a fixture file, failing loudly if the edit matched nothing. */
function edit(root, caseName, replacer) {
  const path = join(root, WORKFLOW);
  const before = readFileSync(path, 'utf8');
  const after = replacer(before);
  if (after === before) {
    failures.push(
      `${caseName}: the fixture edit changed nothing — the mutation never happened, so the case proves nothing.`
    );
    return;
  }
  writeFileSync(path, after);
}

/**
 * Every job in the fixture except the gate, reported `success`, with overrides
 * applied. Derived rather than hard-coded so a job added to ci.yml is covered by
 * these tests the day it lands.
 */
function needsFor(root, overrides = {}) {
  const parsed = Bun.YAML.parse(readFileSync(join(root, WORKFLOW), 'utf8'));
  const needs = {};
  for (const id of Object.keys(parsed?.jobs ?? {})) {
    if (id === GATE_JOB_ID) continue;
    needs[id] = { result: 'success', outputs: {} };
  }
  for (const [id, result] of Object.entries(overrides)) {
    if (result === undefined) delete needs[id];
    else needs[id] = { result, outputs: {} };
  }
  return needs;
}

function expectVerdict(caseName, root, needs, expectedCode, expectedFragment) {
  let code = 0;
  let output = '';
  const env = { ...process.env };
  if (needs === null) delete env.NEEDS_JSON;
  else env.NEEDS_JSON = JSON.stringify(needs);

  try {
    output = execFileSync('bun', [checkScript], {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    code = error.status ?? 1;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }

  if (code !== expectedCode) {
    failures.push(`${caseName}: expected exit ${expectedCode}, got ${code}.\n${output}`);
    return;
  }
  if (!output.includes(expectedFragment)) {
    failures.push(`${caseName}: output does not contain ${JSON.stringify(expectedFragment)}.\n${output}`);
  }
}

// ── Positive control ───────────────────────────────────────────────────────
// Runs first and on the unmutated workflow. If this is red every case below is
// measuring the harness, not the gate.
{
  const root = createFixture();
  expectVerdict('unmutated-workflow-passes', root, needsFor(root), 0, 'CI is complete');
}

// ── The four results, which is what this gate is for ───────────────────────
{
  const root = createFixture();
  expectVerdict(
    'a-failed-job-fails-the-gate',
    root,
    needsFor(root, { 'core-test': 'failure' }),
    1,
    '`core-test` failed.'
  );
}

{
  const root = createFixture();
  expectVerdict(
    'a-cancelled-job-fails-the-gate',
    root,
    needsFor(root, { 'api-build': 'cancelled' }),
    1,
    '`api-build` was cancelled'
  );
}

{
  // A job that declares `if:` is one somebody deliberately made conditional, so
  // `skipped` is the designed outcome and must NOT block. This is the case that
  // makes the gate satisfiable if a path-filtered job is ever added.
  const root = createFixture();
  edit(root, 'a-conditional-job-may-skip', (yaml) =>
    yaml.replace(
      '  ship-test:\n    name: Ship Tests\n',
      "  ship-test:\n    name: Ship Tests\n    if: \"github.event_name == 'pull_request'\"\n"
    )
  );
  expectVerdict(
    'a-conditional-job-may-skip',
    root,
    needsFor(root, { 'ship-test': 'skipped' }),
    0,
    '1 skipped for a declared reason'
  );
}

{
  // The other half of the same rule: no `if:`, nothing upstream skipped, so
  // nothing explains the skip. Reading this as a pass is how the gate rots.
  const root = createFixture();
  expectVerdict(
    'an-unexplained-skip-fails-the-gate',
    root,
    needsFor(root, { 'ship-test': 'skipped' }),
    1,
    '`ship-test` was skipped, but it declares no `if:`'
  );
}

{
  // Skipped because a dependency skipped — the job made no choice, so it is not
  // the thing to report. The gate names the root of the chain instead.
  const root = createFixture();
  edit(root, 'a-skip-inherited-from-a-dependency', (yaml) =>
    yaml
      .replace(
        '  ship-test:\n    name: Ship Tests\n',
        "  ship-test:\n    name: Ship Tests\n    if: \"github.event_name == 'push'\"\n"
      )
      .replace('  node-test:\n    name: Node Tests\n', '  node-test:\n    name: Node Tests\n    needs: [ship-test]\n')
  );
  expectVerdict(
    'a-skip-inherited-from-a-dependency',
    root,
    needsFor(root, { 'ship-test': 'skipped', 'node-test': 'skipped' }),
    0,
    '2 skipped for a declared reason'
  );
}

{
  const root = createFixture();
  expectVerdict(
    'an-unrecognised-result-fails-the-gate',
    root,
    needsFor(root, { 'auth-test': 'neutral' }),
    1,
    'reported "neutral", which this gate does not recognise as a pass'
  );
}

// ── Coverage: the defence against silent rot ───────────────────────────────
{
  // The failure this gate exists to prevent: somebody adds a job and does not
  // add it to `needs:`, so it can fail without blocking anything.
  const root = createFixture();
  edit(root, 'a-job-missing-from-needs-fails-the-gate', (yaml) =>
    yaml.replace(
      '  security-audit:\n',
      '  brand-new-suite:\n    name: Brand New Suite\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 0\n\n  security-audit:\n'
    )
  );
  expectVerdict(
    'a-job-missing-from-needs-fails-the-gate',
    root,
    needsFor(root, { 'brand-new-suite': undefined }),
    1,
    'are not dependencies of `ci-complete`: brand-new-suite'
  );
}

// ── The workflow must keep reporting at all ────────────────────────────────
{
  // Path-filtering the WORKFLOW is the one edit that makes a required check
  // unsatisfiable rather than lenient.
  const root = createFixture();
  edit(root, 'a-path-filtered-workflow-fails-the-gate', (yaml) =>
    yaml.replace(
      '  pull_request:\n    branches: [main, develop]\n',
      "  pull_request:\n    branches: [main, develop]\n    paths: ['packages/**']\n"
    )
  );
  expectVerdict(
    'a-path-filtered-workflow-fails-the-gate',
    root,
    needsFor(root),
    1,
    'filters `on.pull_request` by `paths`'
  );
}

{
  const root = createFixture();
  edit(root, 'a-workflow-that-skips-main-fails-the-gate', (yaml) =>
    yaml.replace('  pull_request:\n    branches: [main, develop]\n', '  pull_request:\n    branches: [develop]\n')
  );
  expectVerdict(
    'a-workflow-that-skips-main-fails-the-gate',
    root,
    needsFor(root),
    1,
    'which excludes `main`'
  );
}

// ── The gate's own guards, so none can rot into decoration ─────────────────
{
  // No verdicts to read. Passing here would mean the job reports success having
  // measured nothing at all.
  const root = createFixture();
  expectVerdict('a-missing-NEEDS_JSON-fails-the-gate', root, null, 1, 'NEEDS_JSON is empty or unset');
}

{
  const root = createFixture();
  expectVerdict('an-empty-needs-fails-the-gate', root, {}, 1, 'This job depends on nothing');
}

{
  // The vacuity floor. If the gate cannot find its own job in the file it is
  // parsing, every set it computes below is empty and every check is vacuous.
  const root = createFixture();
  const yaml = readFileSync(join(root, WORKFLOW), 'utf8');
  writeFileSync(join(root, WORKFLOW), `${yaml.split('\njobs:\n')[0]}\njobs:\n  only-one:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 0\n`);
  expectVerdict(
    'a-workflow-without-the-gate-job-fails-the-gate',
    root,
    { 'only-one': { result: 'success' } },
    1,
    'is not among the jobs parsed out of'
  );
}

// ── Report ─────────────────────────────────────────────────────────────────
for (const root of createdFixtures) rmSync(root, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`check-ci-complete.mjs is BROKEN (${failures.length} case(s)):\n`);
  for (const failure of failures) console.error(`- ${failure}\n`);
  process.exit(1);
}

console.log(
  `check-ci-complete.mjs behaves: ${createdFixtures.length} fixtures, covering every ` +
  '`needs.*.result` value, the coverage guard, both workflow-trigger guards, and the gate\'s own ' +
  'vacuity floors.'
);
