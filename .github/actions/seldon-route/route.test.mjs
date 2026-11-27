// node --test .github/actions/seldon-route/route.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { families, main, outcome } from './route.mjs';

const needs = (pairs) =>
  Object.fromEntries(Object.entries(pairs).map(([id, result]) => [id, { result, outputs: {} }]));

test('a job that passed, on Seldon or hosted, passes with its rescue skipped', () => {
  const v = families(needs({ build: 'success', 'build-rescue': 'skipped' }));
  assert.deepEqual(v, { build: 'passed' });
  assert.equal(outcome(v), 'success');
});

test('a Seldon failure is excused by its rescue passing', () => {
  const v = families(needs({ tests: 'failure', 'tests-rescue': 'success' }));
  assert.deepEqual(v, { tests: 'rescued' });
  assert.equal(outcome(v), 'success');
});

test('a rescue that fails again, or is cancelled, fails', () => {
  for (const rescue of ['failure', 'cancelled']) {
    assert.deepEqual(families(needs({ tests: 'failure', 'tests-rescue': rescue })), {
      tests: 'failed',
    });
  }
});

test('a failure with no rescue fails, and a cancelled job fails', () => {
  assert.deepEqual(families(needs({ tests: 'failure', 'tests-rescue': 'skipped' })), {
    tests: 'failed',
  });
  assert.deepEqual(families(needs({ tests: 'cancelled', 'tests-rescue': 'skipped' })), {
    tests: 'failed',
  });
});

test('a rescue that ran over a job that did not fail is inconsistent: failed', () => {
  assert.deepEqual(families(needs({ tests: 'success', 'tests-rescue': 'success' })), {
    tests: 'failed',
  });
});

test('a skipped job with a skipped rescue is left to the gate', () => {
  const v = families(needs({ tests: 'skipped', 'tests-rescue': 'skipped' }));
  assert.deepEqual(v, { tests: 'skipped' });
  assert.equal(outcome(v), 'success');
});

test('jobs without a rescue are not judged, and one failed family fails the outcome', () => {
  const v = families(
    needs({
      lint: 'failure',
      build: 'success',
      'build-rescue': 'skipped',
      tests: 'failure',
      'tests-rescue': 'failure',
    }),
  );
  assert.deepEqual(v, { build: 'passed', tests: 'failed' });
  assert.equal(outcome(v), 'failure');
});

test('main writes outcome and families to GITHUB_OUTPUT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seldon-route-'));
  const out = join(dir, 'output');
  main({
    INPUT_NEEDS: JSON.stringify(needs({ tests: 'failure', 'tests-rescue': 'success' })),
    GITHUB_OUTPUT: out,
  });
  assert.equal(readFileSync(out, 'utf8'), 'outcome=success\nfamilies={"tests":"rescued"}\n');
  assert.throws(() => main({ INPUT_NEEDS: 'nope', GITHUB_OUTPUT: out }), /not JSON/);
});
