import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const check = readFileSync(new URL('check-asset-worker-rollout.mjs', import.meta.url), 'utf8');
const script = readFileSync(
  new URL('../.github/scripts/deploy-asset-variant-worker.sh', import.meta.url),
  'utf8',
);
const workflow = readFileSync(
  new URL('../.github/workflows/deploy-aws.yml', import.meta.url),
  'utf8',
);

function run({ mutateScript = (value) => value, mutateWorkflow = (value) => value } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'asset-worker-rollout-'));
  mkdirSync(join(fixture, 'scripts'));
  mkdirSync(join(fixture, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(fixture, '.github', 'scripts'), { recursive: true });
  writeFileSync(join(fixture, 'scripts', 'check-asset-worker-rollout.mjs'), check);
  writeFileSync(
    join(fixture, '.github', 'scripts', 'deploy-asset-variant-worker.sh'),
    mutateScript(script),
  );
  writeFileSync(join(fixture, '.github', 'workflows', 'deploy-aws.yml'), mutateWorkflow(workflow));
  return spawnSync(process.execPath, ['scripts/check-asset-worker-rollout.mjs'], {
    cwd: fixture,
    encoding: 'utf8',
  });
}

assert.equal(run().status, 0);
assert.notEqual(
  run({
    mutateScript: (value) =>
      value.replace(
        '--task-definition "$new_task_definition" \\',
        '--task-definition "$new_task_definition" \\\n    --desired-count 1 \\',
      ),
  }).status,
  0,
);
assert.notEqual(
  run({
    mutateScript: (value) =>
      value.replace('$service.desiredCount > 0', '$service.desiredCount == 1'),
  }).status,
  0,
);
assert.notEqual(
  run({
    mutateScript: (value) =>
      value.replace('$service.runningCount == $service.desiredCount', '$service.runningCount == 1'),
  }).status,
  0,
);
assert.notEqual(
  run({ mutateScript: (value) => value.replace('; .desiredCount == 0)', '; .desiredCount >= 0)') })
    .status,
  0,
);
assert.notEqual(
  run({ mutateWorkflow: (value) => value.replace('WORKER_ROLLOUT_PHASE: start', '') }).status,
  0,
);
assert.notEqual(
  run({ mutateWorkflow: (value) => value.replace('deploy-asset-variant-worker.sh wait', 'true') })
    .status,
  0,
);

console.log('OK: asset worker rollout gate rejects fixed-capacity and ordering regressions');
