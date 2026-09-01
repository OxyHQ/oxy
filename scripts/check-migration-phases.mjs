#!/usr/bin/env bun
/**
 * Fail the build when a schema change could reach production out of order.
 *
 * THE OUTAGE THIS EXISTS FOR
 *
 * `0013_users_account_categories` added `users.account_categories`, and the same
 * pull request added code selecting that column by name. The pull request merged
 * (this repository has no required status checks, so `--auto` merged it at once),
 * `Deploy to AWS` built and rolled out the image, and `deploy-aws.yml` contained
 * no migration step. The image reached production; the column did not.
 * `POST /users/by-ids` returned 500 ecosystem-wide until `Run PostgreSQL
 * migrations` was dispatched by hand.
 *
 * The migration was additive, defaulted, dropped nothing, and its pull request
 * documented the ordering it needed. None of that helped, because the ordering
 * depended on a human performing two dispatches in the right order while a
 * deploy raced them.
 *
 * The fix is that the deploy applies migrations itself. This gate is what stops
 * that mechanism from being silently disarmed or silently misfed.
 *
 * WHAT IS CHECKED
 *
 *   1. Every migration in the journal declares its deploy phase — exactly one
 *      `-- oxy:deploy-phase=pre|post` line — using the SAME reader the migrator
 *      uses at runtime. No default exists, so a migration whose author never
 *      considered the question fails here rather than in production.
 *   2. `.github/workflows/deploy-aws.yml` still sets `RUN_MIGRATIONS: 'true'`.
 *      Deleting it is a one-line change that reproduces the outage exactly, with
 *      a green deploy and no other symptom.
 *   3. `.github/scripts/deploy-ecs-image.sh` still runs the pre-deploy migrator
 *      with `--phase=pre`. Without the flag the migrator refuses to run at all,
 *      but the failure would arrive as a red deploy nobody can place; with the
 *      WRONG phase it would apply destructive migrations against the image still
 *      serving, which is worse than the outage it replaced.
 *   4. `deploy-aws.yml` decides whether it needs a post-rollout migration task by
 *      grepping for the pattern `@oxyhq/db`'s `migrate/phases.ts` exports. That grep
 *      is only sound because of (1); this pins the two together so the workflow cannot
 *      drift to a pattern the marker syntax no longer matches.
 *
 * WHAT IS NOT CHECKED, DELIBERATELY
 *
 * Whether anything is PENDING. That needs the ledger, and the database is on a
 * private VPC address a pull-request check must never be given credentials for.
 * The pending question is answered at migration time, inside the VPC, by the
 * migrator itself — which names every migration it applies, defers, or refuses.
 * This gate covers the half that lives in the repository.
 *
 * Paths are resolved from the working directory, so the fixture tests in
 * `scripts/test-check-migration-phases.mjs` can run it against a mutated copy of
 * the real files.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  POST_PHASE_GREP_PATTERN,
  readMigrationPhases,
} from '../packages/db/src/migrate/phases.ts';

const DRIZZLE_FOLDER = join('packages', 'api', 'drizzle');
const JOURNAL_PATH = join(DRIZZLE_FOLDER, 'meta', '_journal.json');
const DEPLOY_WORKFLOW_PATH = join('.github', 'workflows', 'deploy-aws.yml');
const DEPLOY_SCRIPT_PATH = join('.github', 'scripts', 'deploy-ecs-image.sh');

/**
 * Vacuity guards. A journal this gate cannot read would otherwise check zero
 * migrations and report zero problems — the shape that lets a broken traversal
 * pass as a clean run. The sentinel is the first migration ever written, which
 * is the one tag that can never legitimately leave the journal.
 */
const MINIMUM_JOURNAL_ENTRIES = 10;
const JOURNAL_SENTINEL = '0000_groovy_colossus';

/** What the pre-deploy one-shot must invoke, verbatim. */
const PRE_PHASE_COMMAND = '"--phase=pre"';

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

/** Journal tags, in journal order. */
function parseJournalTags() {
  let parsed;
  try {
    parsed = JSON.parse(read(JOURNAL_PATH));
  } catch (error) {
    fail(`${JOURNAL_PATH} is not readable JSON (${error.message}); the gate cannot see any migration.`);
    return [];
  }

  const entries = parsed?.entries;
  if (!Array.isArray(entries)) {
    fail(`${JOURNAL_PATH} has no \`entries\` array; the gate cannot see any migration.`);
    return [];
  }

  return entries.map((entry) => entry?.tag).filter((tag) => typeof tag === 'string');
}

const tags = parseJournalTags();

// ── Vacuity guards ─────────────────────────────────────────────────────────
if (tags.length > 0 && tags.length < MINIMUM_JOURNAL_ENTRIES) {
  fail(
    `Only ${tags.length} migration tag(s) parsed out of ${JOURNAL_PATH} (expected at least ` +
    `${MINIMUM_JOURNAL_ENTRIES}). The parse is broken, not the source.`
  );
}
if (tags.length > 0 && !tags.includes(JOURNAL_SENTINEL)) {
  fail(
    `${JOURNAL_SENTINEL} was not among the parsed journal tags — the gate is reading the wrong ` +
    `array in ${JOURNAL_PATH}.`
  );
}

// ── 1. Every migration declares its side of the deploy ─────────────────────
const { phases, problems: phaseProblems } = readMigrationPhases(tags, DRIZZLE_FOLDER);
for (const problem of phaseProblems) fail(problem);

// ── 2/3. The deploy still applies migrations, on the right side ────────────
const deployWorkflow = read(DEPLOY_WORKFLOW_PATH);
const deployScript = read(DEPLOY_SCRIPT_PATH);

if (!/^\s+RUN_MIGRATIONS:\s*'true'\s*$/m.test(deployWorkflow)) {
  fail(
    `${DEPLOY_WORKFLOW_PATH} no longer sets \`RUN_MIGRATIONS: 'true'\` on the deploy step, so no ` +
    'deploy applies migrations before its rollout. That is exactly the 2026-08-02 outage: the ' +
    'image ships, the column does not, and every read of it 500s until somebody dispatches ' +
    '`Run PostgreSQL migrations` by hand.'
  );
}

if (!deployScript.includes(PRE_PHASE_COMMAND)) {
  fail(
    `${DEPLOY_SCRIPT_PATH} no longer passes ${PRE_PHASE_COMMAND} to the pre-deploy migrator. ` +
    'Without a phase the migrator refuses to run and the deploy fails for a reason nobody can ' +
    'place; with the wrong phase it applies destructive migrations while the previous image is ' +
    'still serving.'
  );
}

// ── 4. The workflow's post-phase grep matches the real marker syntax ───────
if (!deployWorkflow.includes(POST_PHASE_GREP_PATTERN)) {
  fail(
    `${DEPLOY_WORKFLOW_PATH} does not grep for ${POST_PHASE_GREP_PATTERN}, the pattern ` +
    "@oxyhq/db's migrate/phases.ts exports. The workflow decides whether a release needs " +
    'a post-rollout migration task from that grep, so a pattern that no longer matches the marker ' +
    'syntax silently skips the task and the destructive migration is never applied by anything.'
  );
}

if (problems.length > 0) {
  console.error('Migration deploy phases are BROKEN:\n');
  for (const problem of problems) console.error(`- ${problem}`);
  console.error(
    '\nA migration that does not declare its side of the deploy, or a deploy that has stopped' +
    '\napplying migrations, ships an image against a schema that does not match it. Nothing' +
    '\nerrors at deploy time; the API just starts returning 500 on every read of the new column.'
  );
  process.exit(1);
}

const postCount = [...phases.values()].filter((phase) => phase === 'post').length;
console.log(
  `Migration deploy phases are sound: all ${tags.length} migration(s) declare a phase ` +
  `(${tags.length - postCount} pre, ${postCount} post), deploy-aws.yml applies them before its ` +
  'rollout, and its post-rollout grep matches the marker syntax the migrator reads.'
);
