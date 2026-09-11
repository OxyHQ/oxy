import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('..', import.meta.url);
const check = readFileSync(new URL('check-asset-worker-rollout.mjs', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/deploy-aws.yml', import.meta.url), 'utf8');

function run(mutator) {
  const fixture = mkdtempSync(join(tmpdir(), 'asset-worker-rollout-'));
  mkdirSync(join(fixture, 'scripts'));
  mkdirSync(join(fixture, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(fixture, 'scripts', 'check-asset-worker-rollout.mjs'), check);
  writeFileSync(join(fixture, '.github', 'workflows', 'deploy-aws.yml'), mutator(workflow));
  return spawnSync(process.execPath, ['scripts/check-asset-worker-rollout.mjs'], {
    cwd: fixture,
    encoding: 'utf8',
  });
}

assert.equal(run((value) => value).status, 0);
assert.notEqual(
  run((value) => value.replace('--task-definition "$new_task_definition" \\', '--task-definition "$new_task_definition" \\\n+            --desired-count 1 \\')).status,
  0,
);
assert.notEqual(run((value) => value.replace('.desiredCount > 0', '.desiredCount == 1')).status, 0);
assert.notEqual(
  run((value) => value.replace('.runningCount == $service.desiredCount', '.runningCount == 1')).status,
  0,
);

console.log('OK: asset worker rollout gate rejects fixed-capacity regressions');
