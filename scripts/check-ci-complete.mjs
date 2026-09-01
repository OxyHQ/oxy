#!/usr/bin/env bun
/**
 * The body of the `CI complete` job — the single check name `main` requires.
 *
 * THE OUTAGE THIS EXISTS FOR
 *
 * This repository's branch protection carried `required_status_checks: null`.
 * Nothing was required, so `gh pr merge --auto` did not wait for anything: it
 * merged the moment the mergeability check cleared. Measured on the last six
 * merged pull requests, #803 merged at 14:09:46Z with `Core Tests`, `API Build`
 * and `Lockfile Sync` all still `queued`, having started at 14:09:45Z — one
 * second of CI, then main. `--auto` in the pull request title reads as "merged
 * after CI passed" and meant nothing of the kind. One of those merges took
 * production down (see scripts/check-migration-phases.mjs for that half).
 *
 * Requiring the test jobs BY NAME is not the fix, and the reason is the whole
 * design of this file:
 *
 *   - A required check that never reports blocks the pull request FOREVER, with
 *     no way to merge short of an admin override. So every name required must be
 *     a job that runs on every pull request, forever, including after edits
 *     nobody has made yet.
 *   - Naming today's nineteen jobs freezes that list into a repository setting
 *     nothing in this tree can see. A job added next month is required by
 *     nothing, and no reviewer looking at the diff has any signal that it is not.
 *
 * One aggregate job avoids both: it always runs, it reports the verdict of every
 * other job, and — because it reads this workflow back and compares — it fails
 * when a job exists that it was not wired to.
 *
 * WHAT IS CHECKED
 *
 *   1. `on.pull_request` still fires this workflow for every pull request into
 *      `main`. A `paths:` filter here, or a `branches:` list that drops `main`,
 *      stops the workflow running at all — and a required check that does not
 *      report is not a lenient gate, it is an unmergeable repository. Branch
 *      protection already fails closed on this; the point of checking is to make
 *      the pull request that would cause it red and legible, instead of every
 *      unrelated pull request afterwards mysteriously unmergeable.
 *   2. Coverage: every job in this workflow is a dependency of this one. This is
 *      the defence against the classic aggregate-gate rot, where the `needs:`
 *      list silently stops covering the repository months after anyone looked.
 *   3. The verdict, per dependency, treating each `needs.*.result` explicitly:
 *        success   pass.
 *        skipped   pass ONLY if that job could legitimately skip — it declares a
 *                  job-level `if:`, or something it `needs` skipped. Reading an
 *                  unexplained `skipped` as "fine" is how a required check stops
 *                  checking: one accidental `if: false` and the gate is green
 *                  over a suite that never ran.
 *        failure   fail.
 *        cancelled fail. A cancelled job verified nothing. Collapsing it into
 *                  success makes this a rubber stamp, and cancellation is common
 *                  precisely when several pushes race — the moment the gate
 *                  matters most.
 *        anything else, including a missing result, fails. Unknown is not good
 *                  news.
 *
 * WHAT IS NOT CHECKED, AND CANNOT BE
 *
 * Jobs in OTHER workflow files. `needs:` cannot cross a workflow, so CodeQL,
 * Socket Security and the scaffold smoke test are invisible here and this gate
 * makes no claim about them. Requiring those separately is a branch-protection
 * decision, not something this file can enforce.
 *
 * Paths resolve from the working directory, so the fixture tests in
 * scripts/test-check-ci-complete.mjs can run this against mutated copies of the
 * real workflow.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOW_PATH = join('.github', 'workflows', 'ci.yml');

/** This job's own id. It is excluded from the coverage set — it cannot need itself. */
const GATE_JOB_ID = 'ci-complete';

/**
 * Vacuity floor. A parse that yields nothing would check nothing and report no
 * problems, which is the shape that lets a broken traversal pass as a clean run.
 * The exact number is not the guard — finding this gate's OWN job id is, because
 * that one cannot legitimately leave the file while this code is running.
 */
const MINIMUM_JOBS = 5;

const problems = [];

function fail(message) {
  problems.push(message);
}

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    console.error(`Cannot read ${path}: ${error.message}`);
    process.exit(1);
  }
}

// ── The workflow, as GitHub sees it ────────────────────────────────────────
let workflow;
try {
  workflow = Bun.YAML.parse(read(WORKFLOW_PATH));
} catch (error) {
  console.error(`${WORKFLOW_PATH} is not parseable YAML (${error.message}); the gate cannot see any job.`);
  process.exit(1);
}

const jobs = workflow?.jobs;
if (jobs === null || typeof jobs !== 'object' || Array.isArray(jobs)) {
  console.error(`${WORKFLOW_PATH} has no \`jobs\` mapping; the gate cannot see any job.`);
  process.exit(1);
}

const jobIds = Object.keys(jobs);

// ── Vacuity guards ─────────────────────────────────────────────────────────
if (!jobIds.includes(GATE_JOB_ID)) {
  fail(
    `\`${GATE_JOB_ID}\` is not among the jobs parsed out of ${WORKFLOW_PATH} (found: ` +
    `${jobIds.join(', ') || 'none'}). This gate is running, so it is in the file — the parse is ` +
    'broken, and every check below it is reading an empty set.'
  );
}
if (jobIds.length < MINIMUM_JOBS) {
  fail(
    `Only ${jobIds.length} job(s) parsed out of ${WORKFLOW_PATH} (expected at least ` +
    `${MINIMUM_JOBS}). The parse is broken, not the workflow.`
  );
}

// ── 1. This workflow still runs on every pull request into main ────────────
// YAML 1.1 folds a bare `on` key to boolean true; Bun.YAML follows 1.2 and keeps
// the string. Read both rather than let a parser change silently skip this.
const triggers = workflow?.on ?? workflow?.[true];
const pullRequest = triggers?.pull_request;

if (pullRequest === undefined) {
  fail(
    `${WORKFLOW_PATH} no longer declares an \`on.pull_request\` trigger, so it does not run on ` +
    'pull requests at all. The one required check would never report and every pull request ' +
    'would be permanently unmergeable.'
  );
} else if (pullRequest !== null && typeof pullRequest === 'object') {
  for (const key of ['paths', 'paths-ignore']) {
    if (key in pullRequest) {
      fail(
        `${WORKFLOW_PATH} filters \`on.pull_request\` by \`${key}\`. A path-filtered workflow does ` +
        'not run when nothing matches, so the required `CI complete` check never reports and the ' +
        'pull request can never be merged. Path-filter individual JOBS with `if:` instead — a ' +
        'skipped job satisfies this gate, a missing workflow run does not.'
      );
    }
  }

  const branches = pullRequest.branches;
  if (Array.isArray(branches) && !branches.includes('main')) {
    fail(
      `${WORKFLOW_PATH} restricts \`on.pull_request.branches\` to ${branches.join(', ')}, which ` +
      'excludes `main`. The required check would never report on the branch that requires it.'
    );
  }
}

// ── The verdicts this run produced ─────────────────────────────────────────
const rawNeeds = process.env.NEEDS_JSON;
if (!rawNeeds) {
  console.error(
    'NEEDS_JSON is empty or unset. The job must pass `NEEDS_JSON: ${{ toJSON(needs) }}` — without ' +
    'it this gate has no verdicts to read and would pass over a completely red run.'
  );
  process.exit(1);
}

let needs;
try {
  needs = JSON.parse(rawNeeds);
} catch (error) {
  console.error(`NEEDS_JSON is not parseable JSON (${error.message}).`);
  process.exit(1);
}

if (needs === null || typeof needs !== 'object' || Array.isArray(needs)) {
  console.error('NEEDS_JSON did not decode to an object of job results.');
  process.exit(1);
}

const needIds = Object.keys(needs);
if (needIds.length === 0) {
  fail(
    'This job depends on nothing (`needs:` is empty), so it reports the verdict of zero jobs while ' +
    'presenting as the gate for all of them.'
  );
}

// ── 2. Coverage: every job in the workflow is a dependency of this one ─────
const expected = jobIds.filter((id) => id !== GATE_JOB_ID);
const uncovered = expected.filter((id) => !needIds.includes(id));
if (uncovered.length > 0) {
  fail(
    `${uncovered.length} job(s) in ${WORKFLOW_PATH} are not dependencies of \`${GATE_JOB_ID}\`: ` +
    `${uncovered.join(', ')}. \`${GATE_JOB_ID}\` is the only check \`main\` requires, so a job it ` +
    'does not need can fail without blocking anything. Add each one to its `needs:` list.'
  );
}

const unknown = needIds.filter((id) => !jobIds.includes(id));
if (unknown.length > 0) {
  fail(
    `\`${GATE_JOB_ID}\` needs ${unknown.join(', ')}, which the parse of ${WORKFLOW_PATH} did not ` +
    'find. GitHub rejects a `needs:` naming a job that does not exist, so this means the gate is ' +
    'reading a different file than the one that ran.'
  );
}

// ── 3. The verdict, per dependency ─────────────────────────────────────────

/** A `needs:` value is a string or a list of strings. */
function dependenciesOf(jobId) {
  const declared = jobs?.[jobId]?.needs;
  if (typeof declared === 'string') return [declared];
  if (Array.isArray(declared)) return declared.filter((id) => typeof id === 'string');
  return [];
}

/**
 * Whether `skipped` is explicable for this job. Either it declares a job-level
 * `if:` — the supported way to make a job conditional, and the one that keeps
 * this gate satisfiable on a pull request the job does not apply to — or one of
 * its own dependencies skipped, which skips it in turn through no choice of its
 * own. The dependency case needs no recursion: if THAT job skipped without
 * cause, it is already failing this gate on its own line, which names the root
 * of the chain instead of every job downstream of it.
 */
function maySkip(jobId) {
  if (jobs?.[jobId] !== null && typeof jobs?.[jobId] === 'object' && 'if' in jobs[jobId]) return true;
  return dependenciesOf(jobId).some((id) => needs?.[id]?.result === 'skipped');
}

const counts = { success: 0, skipped: 0 };

for (const id of needIds.sort()) {
  const result = needs[id]?.result;

  if (result === 'success') {
    counts.success += 1;
    continue;
  }

  if (result === 'skipped') {
    if (maySkip(id)) {
      counts.skipped += 1;
      continue;
    }
    fail(
      `\`${id}\` was skipped, but it declares no \`if:\` and nothing it needs skipped — so nothing ` +
      'explains why it did not run. Treating that as a pass is how a required check stops ' +
      'checking: one `if: false` and this gate is green over a suite that never executed.'
    );
    continue;
  }

  if (result === 'failure') {
    fail(`\`${id}\` failed.`);
    continue;
  }

  if (result === 'cancelled') {
    fail(
      `\`${id}\` was cancelled, so it verified nothing. Cancellation is most common when pushes ` +
      'race, which is exactly when merging on an unverified tree is most likely.'
    );
    continue;
  }

  fail(
    `\`${id}\` reported ${JSON.stringify(result)}, which this gate does not recognise as a pass. ` +
    'An unrecognised result is not good news.'
  );
}

if (problems.length > 0) {
  console.error('CI is NOT complete:\n');
  for (const problem of problems) console.error(`- ${problem}`);
  console.error(
    '\n`CI complete` is the only status check `main` requires. It is red, so this pull request' +
    '\ncannot merge — which is the mechanism working, not a flake to re-run around.'
  );
  process.exit(1);
}

console.log(
  `CI is complete: ${counts.success} job(s) passed, ${counts.skipped} skipped for a declared ` +
  `reason, across all ${expected.length} job(s) in ${WORKFLOW_PATH}.`
);
