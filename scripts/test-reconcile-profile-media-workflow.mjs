#!/usr/bin/env node

/**
 * `.github/workflows/reconcile-profile-media-references.yml` runs the
 * profile-avatar back-fill against PRODUCTION with the live API task's secrets.
 * What must stay true of it, each with a mutation control:
 *
 *  1. only protected main reaches the production task, at the dispatching sha;
 *  2. `report` is the default, and only `mode=apply` passes `--apply`;
 *  3. the input guard refuses a malformed cursor, bound or batch size BEFORE
 *     any credential is assumed — exercised by running its own shell;
 *  4. every flag the workflow passes is one the script accepts (the script
 *     refuses an unknown one, so a rename would fail the production task);
 *  5. the wait is not `aws ecs wait tasks-stopped` (it gives up after 10
 *     minutes), the log is paged to its last line, and a non-zero exit or a
 *     missing summary fails the run.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const WORKFLOW = '.github/workflows/reconcile-profile-media-references.yml';
const SCRIPT = 'packages/api/scripts/reconcile-profile-media-references.ts';
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
    /\n {2}reconcile:\n(?: {4}#[^\n]*\n)* {4}if: github\.ref == 'refs\/heads\/main'\n/,
    'the job must run only from protected main',
  );
  assert.match(source, /ref: \$\{\{ github\.sha \}\}/, 'checkout must pin the dispatching sha');
  assert.match(
    source,
    /role-to-assume: arn:aws:iam::237343248947:role\/oxy-github-deploy/,
    'credentials must come from the OIDC deploy role',
  );
  assert.match(
    source,
    /\n {6}mode:\n[\s\S]*?type: choice\n\s+options: \[report, apply\]\n\s+default: report\n/,
    'mode must be a report|apply choice defaulting to report',
  );
  assert.match(
    source,
    /\(if \$mode == "apply" then \["--apply"\] else \[\] end\)/,
    'only mode=apply may pass --apply',
  );
  assert.equal(
    source.match(/"--apply"/g)?.length,
    1,
    '--apply must appear exactly once, under the apply condition',
  );
  assert.match(source, /SCRIPT: packages\/api\/scripts\/reconcile-profile-media-references\.ts\n/);
  assert.match(source, /\["bun","run",\$script,/, 'the task must run the script with bun');
  assert.ok(existsSync(SCRIPT), 'the script the workflow runs must exist');

  const passed = [...source.matchAll(/"(--[a-z-]+)(?:=[^"]*)?"/g)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(passed)].sort(),
    ['--after', '--apply', '--batch-size', '--max-batches', '--sample'],
    'the workflow passes exactly these flags',
  );
  const known = scriptSource.match(/const KNOWN_ARGUMENT = \/(.+)\/;/)?.[1];
  assert.ok(known, 'the script must declare the arguments it accepts');
  const accepts = new RegExp(known);
  for (const name of passed) {
    const sample = name === '--apply' ? name : `${name}=1`;
    assert.ok(accepts.test(sample), `the script must accept ${name}, which the workflow passes`);
  }

  assert.doesNotMatch(
    source,
    /^\s+aws ecs wait tasks-stopped/m,
    'the 10-minute waiter must not be used',
  );
  assert.match(source, /nextForwardToken/, 'the log must be paged to its end');
  assert.match(
    source,
    /if \[ "\$EXIT_CODE" != "0" \]; then\n\s+echo "::error::Reconcile task exited with \$EXIT_CODE"\n\s+exit 1/,
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
  const body = stepRun(source, 'Reject a malformed mode, cursor, bound or batch size');
  try {
    execFileSync('bash', ['-c', body], {
      env: {
        PATH: process.env.PATH,
        MODE: 'report',
        AFTER: '',
        MAX_BATCHES: '',
        BATCH_SIZE: '500',
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
    { MODE: 'apply' },
    { AFTER: '0199c3a1-2b3c-7d4e-8f90-123456789abc' },
    { AFTER: '5f1e2d3c4b5a697887766554' },
    { MAX_BATCHES: '1' },
    { BATCH_SIZE: '1000' },
    { BATCH_SIZE: '1' },
  ];
  for (const inputs of accepted) {
    assert.ok(guardAccepts(source, inputs), `guard must accept ${JSON.stringify(inputs)}`);
  }
  const refused = [
    { MODE: 'dry-run' },
    { AFTER: 'not-a-user' },
    { AFTER: "x' or 1=1 --" },
    { AFTER: '0199C3A1-2B3C-7D4E-8F90-123456789ABC' },
    { MAX_BATCHES: '0' },
    { MAX_BATCHES: '-1' },
    { MAX_BATCHES: '2 --apply' },
    { BATCH_SIZE: '1001' },
    { BATCH_SIZE: '0' },
    { BATCH_SIZE: '' },
    { BATCH_SIZE: '50 --apply' },
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
      '(if $mode == "apply" then ["--apply"] else [] end)',
      '(if $mode != "" then ["--apply"] else [] end)',
    ),
    /only mode=apply/,
  ],
  [workflow.replace('"--sample=200"', '"--sample=200","--quiet"'), /exactly these flags/],
  [
    workflow.replace(
      'echo "Waiting for the task to stop…"',
      'aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"',
    ),
    /10-minute waiter/,
  ],
  [workflow.replace(/nextForwardToken/g, 'nextToken'), /paged to its end/],
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
assert.throws(
  () => assertWorkflow(workflow, script.replace('max-batches|', '')),
  /must accept --max-batches/,
  'mutation control: a flag the script stopped accepting must fail',
);
const looseGuard = workflow.replace('[ "$BATCH_SIZE" -gt 1000 ]', '[ "$BATCH_SIZE" -gt 9999 ]');
assert.notEqual(looseGuard, workflow);
assert.throws(() => assertGuard(looseGuard), /must refuse \{"BATCH_SIZE":"1001"\}/);

console.log(
  'reconcile-profile-media-references workflow: all assertions and mutation controls hold',
);
