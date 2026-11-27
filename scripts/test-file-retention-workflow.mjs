#!/usr/bin/env node

/**
 * `.github/workflows/file-retention.yml` runs the file retention pass against
 * PRODUCTION with the live API task's secrets, and its apply deletes rows.
 * What must stay true of it, each with a mutation control:
 *
 *  1. only protected main reaches the production task, at the dispatching sha;
 *  2. `report` is the default, and only `mode=apply` passes `--apply`, always
 *     with the confirmation the operator typed;
 *  3. the input guard refuses an apply without the confirmation phrase, and a
 *     malformed step list, cursor or bound, BEFORE any credential is assumed —
 *     exercised by running its own shell;
 *  4. every flag the workflow passes is one the script accepts (the script
 *     refuses an unknown one, so a rename would fail the production task);
 *  5. a non-zero exit or a missing summary fails the run.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const WORKFLOW = '.github/workflows/file-retention.yml';
const SCRIPT = 'packages/api/scripts/file-retention.ts';
const GUARD = 'Reject a malformed mode, confirmation, step list, cursor or bound';
const workflow = readFileSync(WORKFLOW, 'utf8');
const script = readFileSync(SCRIPT, 'utf8');

/** The `run: |` body of the step named `name`, dedented. */
function stepRun(source, name) {
  const start = source.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `workflow must have the step "${name}"`);
  const rest = source.slice(start);
  const next = rest.indexOf('\n      - name:', 1);
  const step = next < 0 ? rest : rest.slice(0, next);
  const body = step.split('run: |\n')[1];
  assert.ok(body, `step "${name}" must have a run block`);
  return body
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
}

function assertWorkflow(source, scriptSource) {
  assert.match(
    source,
    /\n {2}retention:\n(?: {4}#[^\n]*\n)* {4}if: github\.ref == 'refs\/heads\/main'\n/,
    'the job must run only from protected main',
  );
  assert.match(source, /ref: \$\{\{ github\.sha \}\}/, 'checkout must pin the dispatching sha');
  assert.match(
    source,
    /\n {6}mode:\n[\s\S]*?type: choice\n\s+options: \[report, apply\]\n\s+default: report\n/,
    'mode must be a report|apply choice defaulting to report',
  );
  assert.match(
    source,
    /\(if \$mode == "apply" then \["--apply","--confirm=" \+ \$confirm\] else \[\] end\)/,
    'only mode=apply may pass --apply, with its confirmation',
  );
  assert.equal(
    source.match(/"--apply"/g)?.length,
    1,
    '--apply must appear exactly once, under the apply condition',
  );
  assert.match(source, /SCRIPT: packages\/api\/scripts\/file-retention\.ts\n/);
  assert.ok(existsSync(SCRIPT), 'the script the workflow runs must exist');

  const passed = [...source.matchAll(/"(--[a-z-]+)(?:=[^"]*)?"/g)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(passed)].sort(),
    [
      '--after',
      '--apply',
      '--cache-ttl-days',
      '--confirm',
      '--max-batches',
      '--sample',
      '--scan-window',
      '--steps',
      '--unused-days',
    ],
    'the workflow passes exactly these flags',
  );
  const known = scriptSource.match(/const KNOWN_ARGUMENT =\s*\/(.+)\/;/)?.[1];
  assert.ok(known, 'the script must declare the arguments it accepts');
  const accepts = new RegExp(known);
  for (const name of passed) {
    const sample = name === '--apply' ? name : `${name}=1`;
    assert.ok(accepts.test(sample), `the script must accept ${name}, which the workflow passes`);
  }

  assert.match(
    source,
    /if \[ "\$EXIT_CODE" != "0" \]; then\n\s+echo "::error::Retention task exited with \$EXIT_CODE"\n\s+exit 1/,
    'a non-zero task exit must fail the run',
  );
  assert.match(
    source,
    /if \[ -z "\$SUMMARY" \]; then\n\s+echo "::error::The task exited 0 but printed no summary\."\n\s+exit 1/,
    'a run with no summary must fail',
  );
}

/** Runs the input guard with these inputs; true when it accepts them. */
function guardAccepts(source, inputs) {
  const body = stepRun(source, GUARD);
  try {
    execFileSync('bash', ['-c', body], {
      env: {
        PATH: process.env.PATH,
        MODE: 'report',
        CONFIRM: '',
        STEPS: '',
        UNUSED_DAYS: '30',
        CACHE_TTL_DAYS: '90',
        AFTER: '',
        MAX_BATCHES: '',
        SCAN_WINDOW: '2000',
        ...inputs,
      },
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function assertGuard(source) {
  const accepted = [
    {},
    { MODE: 'apply', CONFIRM: 'delete-file-retention-rows' },
    { STEPS: 'tombstoneRenditions' },
    { STEPS: 'federationCacheExpiry,tombstoneRenditions' },
    { UNUSED_DAYS: '90' },
    { CACHE_TTL_DAYS: '30' },
    { AFTER: '0199c3a1-2b3c-7d4e-8f90-123456789abc' },
    { AFTER: '5f1e2d3c4b5a697887766554' },
    { MAX_BATCHES: '1' },
    { SCAN_WINDOW: '100' },
    { SCAN_WINDOW: '10000' },
  ];
  for (const inputs of accepted) {
    assert.ok(guardAccepts(source, inputs), `guard must accept ${JSON.stringify(inputs)}`);
  }
  const refused = [
    { MODE: 'dry-run' },
    { MODE: 'apply' },
    { MODE: 'apply', CONFIRM: 'yes' },
    { STEPS: 'everything' },
    { STEPS: 'tombstoneRenditions --apply' },
    { UNUSED_DAYS: '1' },
    { UNUSED_DAYS: '30 --apply' },
    { CACHE_TTL_DAYS: '7' },
    { AFTER: "x' or 1=1 --" },
    { MAX_BATCHES: '0' },
    { SCAN_WINDOW: '99' },
    { SCAN_WINDOW: '10001' },
    { SCAN_WINDOW: '' },
  ];
  for (const inputs of refused) {
    assert.ok(!guardAccepts(source, inputs), `guard must refuse ${JSON.stringify(inputs)}`);
  }
}

assertWorkflow(workflow, script);
assertGuard(workflow);

// Mutation controls: each property above must be able to fail.
const mutations = [
  [
    workflow.replace("if: github.ref == 'refs/heads/main'", "if: github.ref != ''"),
    /protected main/,
  ],
  [workflow.replace('default: report', 'default: apply'), /defaulting to report/],
  [
    workflow.replace(
      '(if $mode == "apply" then ["--apply","--confirm=" + $confirm] else [] end)',
      '(if $mode != "" then ["--apply","--confirm=" + $confirm] else [] end)',
    ),
    /only mode=apply/,
  ],
  [workflow.replace('"--sample=200"', '"--sample=200","--quiet"'), /exactly these flags/],
  [
    workflow.replace(
      'exit 1\n          fi\n          if [ -z "$SUMMARY" ]',
      'true\n          fi\n          if [ -z "$SUMMARY" ]',
    ),
    /non-zero task exit/,
  ],
];
for (const [mutated, message] of mutations) {
  assert.notEqual(mutated, workflow, `mutation for ${message} must change the workflow`);
  assert.throws(() => assertWorkflow(mutated, script), message);
}
const unconfirmed = workflow.replace(
  'if [ "$MODE" = "apply" ] && [ "$CONFIRM" != "delete-file-retention-rows" ]; then',
  'if false; then',
);
assert.notEqual(unconfirmed, workflow, 'mutation control: the confirmation check must exist');
assert.throws(() => assertGuard(unconfirmed), /must refuse/, 'an unconfirmed apply must fail');
assert.throws(
  () => assertWorkflow(workflow, script.replace('max-batches|', '')),
  /must accept --max-batches/,
  'mutation control: a flag the script stopped accepting must fail',
);
