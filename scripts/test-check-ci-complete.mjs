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
      `${caseName}: the fixture edit changed nothing — the mutation never happened, so the case proves nothing.`,
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
    // `race-finish` is never a dependency of the gate (NOT_GATED).
    if (id === GATE_JOB_ID || id === 'race-finish') continue;
    // The Seldon race's control jobs, hosted twins and rescues are skipped
    // whenever the race is off and no Seldon lane failed, which is the run
    // these defaults describe.
    const raceOnly =
      id === 'race' || id === 'race-finish' || id.endsWith('-hosted') || id.endsWith('-rescue');
    needs[id] = { result: raceOnly ? 'skipped' : 'success', outputs: {} };
  }
  // The scope job's outputs are part of the verdict: a real run reports them.
  if (needs.scope)
    needs.scope.outputs = { api: 'true', platform: 'true', apps: 'true', android: 'true' };
  for (const [id, result] of Object.entries(overrides)) {
    if (result === undefined) delete needs[id];
    else if (typeof result === 'object') needs[id] = { outputs: {}, ...result };
    else needs[id] = { result, outputs: {} };
  }
  return needs;
}

function expectVerdict(
  caseName,
  root,
  needs,
  expectedCode,
  expectedFragment,
  eventName = 'pull_request',
  extraEnv = {},
) {
  let code = 0;
  let output = '';
  const env = { ...process.env, ...extraEnv };
  if (needs === null) delete env.NEEDS_JSON;
  else env.NEEDS_JSON = JSON.stringify(needs);
  if (eventName === null) delete env.EVENT_NAME;
  else env.EVENT_NAME = eventName;

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
    failures.push(
      `${caseName}: output does not contain ${JSON.stringify(expectedFragment)}.\n${output}`,
    );
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
    needsFor(root, { 'packages-platform': 'failure' }),
    1,
    '`packages-platform` failed.',
  );
}

{
  const root = createFixture();
  expectVerdict(
    'a-cancelled-job-fails-the-gate',
    root,
    needsFor(root, { 'api-build': 'cancelled' }),
    1,
    '`api-build` was cancelled',
  );
}

{
  // A job that declares `if:` is one somebody deliberately made conditional, so
  // `skipped` is the designed outcome and must NOT block. This is the case that
  // makes the gate satisfiable if a path-filtered job is ever added.
  const root = createFixture();
  edit(root, 'a-conditional-job-may-skip', (yaml) =>
    yaml.replace(
      '  guards:\n    name: Guards\n',
      '  guards:\n    name: Guards\n    if: "github.event_name == \'pull_request\'"\n',
    ),
  );
  expectVerdict(
    'a-conditional-job-may-skip',
    root,
    needsFor(root, { guards: 'skipped' }),
    0,
    '1 skipped for a declared reason',
  );
}

{
  // The other half of the same rule: no `if:`, nothing upstream skipped, so
  // nothing explains the skip. Reading this as a pass is how the gate rots.
  const root = createFixture();
  expectVerdict(
    'an-unexplained-skip-fails-the-gate',
    root,
    needsFor(root, { guards: 'skipped' }),
    1,
    '`guards` was skipped, but it declares no `if:`',
  );
}

{
  // Skipped because a dependency skipped — the job made no choice, so it is not
  // the thing to report. The gate names the root of the chain instead.
  const root = createFixture();
  edit(root, 'a-skip-inherited-from-a-dependency', (yaml) =>
    yaml
      .replace(
        '  guards:\n    name: Guards\n',
        '  guards:\n    name: Guards\n    if: "github.event_name == \'push\'"\n',
      )
      // `api-coverage`'s `if:` only follows its dependencies.
      .replace(
        '    needs: [api-test, api-test-hosted, api-test-rescue, race]\n',
        '    needs: [api-test, api-test-hosted, api-test-rescue, race, guards]\n',
      ),
  );
  expectVerdict(
    'a-skip-inherited-from-a-dependency',
    root,
    needsFor(root, { guards: 'skipped', 'api-coverage': 'skipped' }),
    0,
    '2 skipped for a declared reason',
  );
}

// ── The sharded API suite: matrix, merge, and one-off checks ───────────────
{
  // The API suite is a matrix job whose merge job needs it. One failing shard
  // makes the whole matrix `failure`, and GitHub then skips the merge. The gate
  // must name the shard failure — and must not ALSO blame the merge for a skip
  // it had no say in.
  const root = createFixture();
  const needs = needsFor(root, { 'api-test': 'failure', 'api-coverage': 'skipped' });
  expectVerdict('a-failed-shard-fails-the-gate', root, needs, 1, '`api-test` failed.');
  let output = '';
  try {
    execFileSync('bun', [checkScript], {
      cwd: root,
      env: { ...process.env, NEEDS_JSON: JSON.stringify(needs), EVENT_NAME: 'pull_request' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  if (output.includes('`api-coverage` was skipped')) {
    failures.push(
      `a-failed-shard-fails-the-gate: the merge's inherited skip was reported as its own fault.\n${output}`,
    );
  }
}

{
  // A merge that skipped while every shard passed has no excuse: the floors
  // were never enforced.
  const root = createFixture();
  expectVerdict(
    'a-coverage-merge-skipped-without-cause-fails-the-gate',
    root,
    needsFor(root, { 'api-coverage': 'skipped' }),
    1,
    '`api-coverage` was skipped, but it declares no `if:` that may skip it',
  );
}

// ── Every job, one at a time ───────────────────────────────────────────────
// The small suites run as grouped jobs (`guards`, `packages-platform`,
// `packages-apps`), so each of those ids now carries a dozen suites: dropping
// one from `needs:` would retire all of them at once. Every job is required on
// its own — the list is read from the real workflow, not written here, so a job
// added later is covered the day it lands — and the named ones must still be
// in it, so a rename that quietly empties this loop goes red too.
// ── The Seldon race ─────────────────────────────────────────────────────────
// A raced pair is judged on the race's verdict, never on its jobs' own results.
{
  const root = createFixture();
  const racedNeeds = needsFor(root, {
    race: { result: 'success', outputs: { race: 'true' } },
    'api-test': 'cancelled',
    'api-test-hosted': 'success',
  });
  expectVerdict(
    'race-loser-cancelled-passes',
    root,
    racedNeeds,
    0,
    'CI is complete',
    'merge_group',
    {
      RACED: 'true',
      RACE_VERDICT: 'success',
    },
  );
  expectVerdict(
    'race-verdict-failure-fails',
    root,
    racedNeeds,
    1,
    'passed in no lane',
    'merge_group',
    {
      RACED: 'true',
      RACE_VERDICT: 'failure',
    },
  );
  expectVerdict(
    'race-verdict-missing-fails',
    root,
    racedNeeds,
    1,
    'passed in no lane',
    'merge_group',
    { RACED: 'true' },
  );
  expectVerdict(
    'twin-without-race-fails',
    root,
    needsFor(root, { 'api-build-hosted': 'success' }),
    1,
    'although the Seldon race did not run',
    'merge_group',
  );
  expectVerdict(
    'no-race-loser-cancelled-fails',
    root,
    needsFor(root, { 'api-test': 'cancelled' }),
    1,
    '`api-test` was cancelled',
    'merge_group',
  );
  expectVerdict(
    'race-control-failure-fails',
    root,
    needsFor(root, { race: 'failure' }),
    1,
    '`race` failed',
    'merge_group',
  );
}

// ── The Seldon rescue ───────────────────────────────────────────────────────
// A Seldon lane that failed reruns hosted in `X-rescue`; the family is judged
// on the verdict whenever the rescue ran, with or without the race.
{
  const root = createFixture();
  const rescuedNeeds = needsFor(root, {
    'api-test': 'failure',
    'api-test-rescue': 'success',
  });
  for (const event of ['pull_request', 'merge_group']) {
    expectVerdict(`rescue-passes-${event}`, root, rescuedNeeds, 0, 'CI is complete', event, {
      RACE_VERDICT: 'success',
    });
  }
  expectVerdict(
    'rescue-verdict-failure-fails',
    root,
    rescuedNeeds,
    1,
    '`api-test` was rescued on hosted',
    'merge_group',
    { RACE_VERDICT: 'failure' },
  );
  expectVerdict(
    'rescue-verdict-missing-fails',
    root,
    rescuedNeeds,
    1,
    'passed in no lane',
    'merge_group',
  );
  // A genuine failure fails the rescue too, and the coverage merge then skips:
  // the gate names the family, never the merge's inherited skip.
  const genuine = needsFor(root, {
    'api-test': 'failure',
    'api-test-rescue': 'failure',
    'api-coverage': 'skipped',
  });
  expectVerdict(
    'rescue-genuine-failure-fails',
    root,
    genuine,
    1,
    '`api-test` was rescued on hosted',
    'merge_group',
    { RACE_VERDICT: 'failure' },
  );
  expectVerdict(
    'rescue-genuine-failure-pr-excuses-the-merge-skip',
    root,
    genuine,
    1,
    '`api-test` was rescued on hosted',
    'pull_request',
    { RACE_VERDICT: 'failure' },
  );
  // Raced and rescued at once: one verdict for the whole family.
  expectVerdict(
    'race-and-rescue-passes',
    root,
    needsFor(root, {
      race: { result: 'success', outputs: { race: 'true' } },
      'api-build': 'failure',
      'api-build-hosted': 'cancelled',
      'api-build-rescue': 'success',
    }),
    0,
    'CI is complete',
    'merge_group',
    { RACED: 'true', RACE_VERDICT: 'success' },
  );
  // Without the race and without a rescue, a failure is judged as any job.
  expectVerdict(
    'unrescued-failure-fails',
    root,
    needsFor(root, { 'packages-apps': 'failure' }),
    1,
    '`packages-apps` failed.',
    'pull_request',
    { RACE_VERDICT: 'success' },
  );
}

const REQUIRED_JOBS = [
  'scope',
  'guards',
  'api-test',
  'api-coverage',
  'api-build',
  'api-image',
  'packages-platform',
  'packages-apps',
  'android-kotlin',
];
const workflowJobs = Object.keys(
  Bun.YAML.parse(readFileSync(join(repoRoot, WORKFLOW), 'utf8'))?.jobs ?? {},
).filter((id) => id !== GATE_JOB_ID && id !== 'race-finish');

{
  // The race's finish and its reapers wait on Seldon: the gate must not need them.
  const root = createFixture();
  edit(root, 'race-finish-must-not-be-a-dependency', (yaml) =>
    yaml.replace('      - race\n', '      - race\n      - race-finish\n'),
  );
  expectVerdict(
    'race-finish-must-not-be-a-dependency',
    root,
    { ...needsFor(root), 'race-finish': { result: 'success', outputs: {} } },
    1,
    'which it must not',
  );
}
for (const job of REQUIRED_JOBS) {
  if (!workflowJobs.includes(job)) {
    failures.push(
      `every-job-is-required: \`${job}\` is not a job in ${WORKFLOW}; this list and the workflow disagree.`,
    );
  }
}
for (const job of workflowJobs) {
  const root = createFixture();
  edit(root, `${job}-must-be-a-dependency`, (yaml) => yaml.replace(`      - ${job}\n`, ''));
  expectVerdict(
    `${job}-must-be-a-dependency`,
    root,
    needsFor(root, { [job]: undefined }),
    1,
    `are not dependencies of \`ci-complete\`: ${job}`,
  );
}

{
  const root = createFixture();
  expectVerdict(
    'an-unrecognised-result-fails-the-gate',
    root,
    needsFor(root, { 'packages-apps': 'neutral' }),
    1,
    'reported "neutral", which this gate does not recognise as a pass',
  );
}

// ── Coverage: the defence against silent rot ───────────────────────────────
{
  // The failure this gate exists to prevent: somebody adds a job and does not
  // add it to `needs:`, so it can fail without blocking anything.
  const root = createFixture();
  edit(root, 'a-job-missing-from-needs-fails-the-gate', (yaml) =>
    yaml.replace(
      '  guards:\n',
      '  brand-new-suite:\n    name: Brand New Suite\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 0\n\n  guards:\n',
    ),
  );
  expectVerdict(
    'a-job-missing-from-needs-fails-the-gate',
    root,
    needsFor(root, { 'brand-new-suite': undefined }),
    1,
    'are not dependencies of `ci-complete`: brand-new-suite',
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
      "  pull_request:\n    branches: [main, develop]\n    paths: ['packages/**']\n",
    ),
  );
  expectVerdict(
    'a-path-filtered-workflow-fails-the-gate',
    root,
    needsFor(root),
    1,
    'filters `on.pull_request` by `paths`',
  );
}

{
  const root = createFixture();
  edit(root, 'a-workflow-that-skips-main-fails-the-gate', (yaml) =>
    yaml.replace(
      '  pull_request:\n    branches: [main, develop]\n',
      '  pull_request:\n    branches: [develop]\n',
    ),
  );
  expectVerdict(
    'a-workflow-that-skips-main-fails-the-gate',
    root,
    needsFor(root),
    1,
    'which excludes `main`',
  );
}

// ── PR-light, queue-full ───────────────────────────────────────────────────
// A scoped suite may be skipped on a pull request, on the scope job's word for
// THAT suite and nothing else; on merge_group, push, or any event not named,
// nothing may be skipped at all. This is the whole safety argument for
// PR-light, so each direction is pinned.
const scopedOut = (extra = {}) => ({
  scope: { result: 'success', outputs: { api: 'false', platform: 'true', apps: 'true' } },
  'api-test': 'skipped',
  'api-coverage': 'skipped',
  'api-build': 'skipped',
  ...extra,
});

{
  const root = createFixture();
  expectVerdict(
    'pr-a-scoped-out-api-suite-passes',
    root,
    needsFor(root, scopedOut()),
    0,
    '3 skipped for a declared reason',
  );
}
{
  // The one-package pull request: only the platform suite reaches it.
  const root = createFixture();
  expectVerdict(
    'pr-only-platform-runs-passes',
    root,
    needsFor(
      root,
      scopedOut({
        scope: { result: 'success', outputs: { api: 'false', platform: 'true', apps: 'false' } },
        'packages-apps': 'skipped',
      }),
    ),
    0,
    '4 skipped for a declared reason',
  );
}
{
  // One suite's `false` never excuses another suite's skip.
  const root = createFixture();
  expectVerdict(
    'pr-a-skip-on-another-suites-word-fails',
    root,
    needsFor(root, scopedOut({ 'packages-apps': 'skipped' })),
    1,
    '`packages-apps` was skipped, but `scope` did not decide it could be',
  );
}
{
  // A suite that ran and failed fails the gate, scope or no scope.
  const root = createFixture();
  expectVerdict(
    'pr-a-failed-scoped-suite-fails',
    root,
    needsFor(root, scopedOut({ 'packages-platform': 'failure' })),
    1,
    '`packages-platform` failed.',
  );
}
for (const [job, output] of [
  ['api-test', 'api'],
  ['api-build', 'api'],
  ['packages-platform', 'platform'],
  ['packages-apps', 'apps'],
  ['android-kotlin', 'android'],
]) {
  // Wired to another suite's output, the job would skip on the wrong word.
  const root = createFixture();
  const wrong = output === 'apps' ? 'platform' : 'apps';
  edit(root, `${job}-wired-to-the-wrong-suite`, (yaml) => {
    const start = yaml.indexOf(`\n  ${job}:\n`);
    const end = yaml.indexOf('\n    steps:', start);
    const block = yaml.slice(start, end);
    return (
      yaml.slice(0, start) +
      block.replace(
        `needs.scope.outputs.${output} != 'false'`,
        `needs.scope.outputs.${wrong} != 'false'`,
      ) +
      yaml.slice(end)
    );
  });
  expectVerdict(
    `${job}-wired-to-the-wrong-suite`,
    root,
    needsFor(root),
    1,
    `\`${job}\` must need \`scope\``,
    'merge_group',
  );
}
{
  const root = createFixture();
  edit(root, 'a-scoped-job-that-does-not-need-scope-fails', (yaml) =>
    yaml.replace(
      '  packages-apps:\n    name: Package Tests (apps)\n    needs: scope\n',
      '  packages-apps:\n    name: Package Tests (apps)\n    needs: guards\n',
    ),
  );
  expectVerdict(
    'a-scoped-job-that-does-not-need-scope-fails',
    root,
    needsFor(root),
    1,
    '`packages-apps` must need `scope`',
  );
}
// ── api-image: queue-only (QUEUE_ONLY_JOBS) ───────────────────────────────
{
  // Every pull request skips it, with no word from the scope job.
  const root = createFixture();
  expectVerdict(
    'pr-the-queue-only-image-smoke-skips',
    root,
    needsFor(root, { 'api-image': 'skipped' }),
    0,
    '1 skipped for a declared reason',
  );
}
{
  // The queue may never skip it.
  const root = createFixture();
  expectVerdict(
    'merge-group-refuses-a-skipped-image-smoke',
    root,
    needsFor(root, { 'api-image': 'skipped' }),
    1,
    '`api-image` was skipped on a `merge_group` run',
    'merge_group',
  );
}
{
  // Its `if:` is the pull-request test and nothing else: widened, it could
  // skip where the queue cannot see it coming.
  const root = createFixture();
  edit(root, 'a-queue-only-job-with-another-condition-fails', (yaml) =>
    yaml.replace(
      "    name: API Image (Bun runtime smoke)\n    if: ${{ github.event_name != 'pull_request' }}\n",
      "    name: API Image (Bun runtime smoke)\n    if: ${{ github.event_name != 'pull_request' && github.actor != 'x' }}\n",
    ),
  );
  expectVerdict(
    'a-queue-only-job-with-another-condition-fails',
    root,
    needsFor(root),
    1,
    '`api-image` is queue-only, so its `if:` must be exactly',
    'merge_group',
  );
}

// ── android-kotlin: decided by `scope` (PATH_SUITES), skippable only on its word
{
  const root = createFixture();
  expectVerdict(
    'pr-a-scoped-out-android-job-passes',
    root,
    needsFor(root, {
      scope: {
        result: 'success',
        outputs: { api: 'true', platform: 'true', apps: 'true', android: 'false' },
      },
      'android-kotlin': 'skipped',
    }),
    0,
    '1 skipped for a declared reason',
  );
}
{
  // The scope said the Kotlin is reached: a skip then has no excuse.
  const root = createFixture();
  expectVerdict(
    'pr-an-android-skip-the-scope-did-not-order-fails',
    root,
    needsFor(root, { 'android-kotlin': 'skipped' }),
    1,
    '`android-kotlin` was skipped, but `scope` did not decide it could be',
  );
}
{
  // Another output's `false` never excuses it.
  const root = createFixture();
  expectVerdict(
    'pr-an-android-skip-on-the-api-word-fails',
    root,
    needsFor(
      root,
      scopedOut({
        scope: {
          result: 'success',
          outputs: { api: 'false', platform: 'true', apps: 'true', android: 'true' },
        },
        'android-kotlin': 'skipped',
      }),
    ),
    1,
    'with android="true"',
  );
}
{
  // The queue runs it always, whatever a pull request's scope said.
  const root = createFixture();
  expectVerdict(
    'merge-group-refuses-a-scoped-out-android-job',
    root,
    needsFor(root, {
      scope: {
        result: 'success',
        outputs: { api: 'true', platform: 'true', apps: 'true', android: 'false' },
      },
      'android-kotlin': 'skipped',
    }),
    1,
    '`android-kotlin` was skipped on a `merge_group` run',
    'merge_group',
  );
}
{
  const root = createFixture();
  edit(root, 'android-kotlin-without-an-if-cannot-be-scoped', (yaml) =>
    yaml.replace(/^ {4}if: .*needs\.scope\.outputs\.android != 'false'.*\n/m, ''),
  );
  expectVerdict(
    'android-kotlin-without-an-if-cannot-be-scoped',
    root,
    needsFor(root),
    1,
    '`android-kotlin` must need `scope`',
  );
}
{
  const root = createFixture();
  expectVerdict(
    'merge-group-everything-passed-passes',
    root,
    needsFor(root),
    0,
    'full suite: nothing skipped',
    'merge_group',
  );
}
for (const event of ['merge_group', 'push', 'workflow_dispatch']) {
  const root = createFixture();
  expectVerdict(
    `${event}-refuses-a-scoped-out-api-suite`,
    root,
    needsFor(root, scopedOut()),
    1,
    `\`api-test\` was skipped on a \`${event}\` run`,
    event,
  );
}
{
  // Even a skip every other rule would excuse — a job with its own `if:` — is
  // refused in the queue.
  const root = createFixture();
  edit(root, 'merge-group-refuses-a-declared-skip', (yaml) =>
    yaml.replace(
      '  guards:\n    name: Guards\n',
      '  guards:\n    name: Guards\n    if: "github.event_name == \'pull_request\'"\n',
    ),
  );
  expectVerdict(
    'merge-group-refuses-a-declared-skip',
    root,
    needsFor(root, { guards: 'skipped' }),
    1,
    '`guards` was skipped on a `merge_group` run',
    'merge_group',
  );
}
{
  // The same for a suite the scope job said to skip: the queue does not take a
  // pull request's scope as an excuse.
  const root = createFixture();
  expectVerdict(
    'merge-group-refuses-a-scoped-out-platform-suite',
    root,
    needsFor(root, {
      scope: { result: 'success', outputs: { api: 'true', platform: 'false', apps: 'true' } },
      'packages-platform': 'skipped',
    }),
    1,
    '`packages-platform` was skipped on a `merge_group` run',
    'merge_group',
  );
}
{
  const root = createFixture();
  expectVerdict(
    'pr-a-skip-the-scope-did-not-order-fails',
    root,
    needsFor(
      root,
      scopedOut({
        scope: { result: 'success', outputs: { api: 'true', platform: 'true', apps: 'true' } },
      }),
    ),
    1,
    '`api-test` was skipped, but `scope` did not decide it could be',
  );
}
{
  const root = createFixture();
  expectVerdict(
    'pr-a-failed-scope-cannot-excuse-a-skip',
    root,
    needsFor(root, scopedOut({ scope: { result: 'failure', outputs: { api: 'false' } } })),
    1,
    '`scope` failed.',
  );
}
{
  const root = createFixture();
  expectVerdict(
    'pr-a-silent-scope-cannot-excuse-a-skip',
    root,
    needsFor(root, scopedOut({ scope: { result: 'success', outputs: {} } })),
    1,
    'with api=undefined',
  );
}
{
  const root = createFixture();
  expectVerdict(
    'a-missing-EVENT_NAME-fails-the-gate',
    root,
    needsFor(root),
    1,
    'EVENT_NAME is empty or unset',
    null,
  );
}
{
  const root = createFixture();
  edit(root, 'a-workflow-without-merge-group-fails-the-gate', (yaml) =>
    yaml.replace('  merge_group:\n', ''),
  );
  expectVerdict(
    'a-workflow-without-merge-group-fails-the-gate',
    root,
    needsFor(root),
    1,
    'no longer declares an `on.merge_group` trigger',
  );
}

// ── The gate's own guards, so none can rot into decoration ─────────────────
{
  // No verdicts to read. Passing here would mean the job reports success having
  // measured nothing at all.
  const root = createFixture();
  expectVerdict(
    'a-missing-NEEDS_JSON-fails-the-gate',
    root,
    null,
    1,
    'NEEDS_JSON is empty or unset',
  );
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
  writeFileSync(
    join(root, WORKFLOW),
    `${yaml.split('\njobs:\n')[0]}\njobs:\n  only-one:\n    runs-on: ubuntu-latest\n    steps:\n      - run: exit 0\n`,
  );
  expectVerdict(
    'a-workflow-without-the-gate-job-fails-the-gate',
    root,
    { 'only-one': { result: 'success' } },
    1,
    'is not among the jobs parsed out of',
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
    "`needs.*.result` value, the coverage guard, both workflow-trigger guards, and the gate's own " +
    'vacuity floors.',
);
