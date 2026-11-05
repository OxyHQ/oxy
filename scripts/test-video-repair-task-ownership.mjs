import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = readFileSync('.github/workflows/run-video-rendition-repair.yml', 'utf8');
const shell = workflow
  .split('\n')
  .map((line) => line.replace(/^ {10}/, ''))
  .join('\n');
const guard = shell.slice(shell.indexOf('if [[ "$CLUSTER"'), shell.indexOf('CONTAINER=$(jq'));
assert.ok(guard.includes('TASK_TAGS='));
assert.ok(shell.indexOf(guard) < shell.indexOf('aws ecs register-task-definition'));
assert.match(shell, /--tags "\$TASK_TAGS"/);
const cleanup = shell.slice(
  shell.indexOf('stop_owned_task() {'),
  shell.indexOf('echo "task: $TASK_ARN"'),
);
assert.match(cleanup, /trap finish_repair EXIT/);
assert.match(cleanup, /trap 'exit 130' INT TERM/);

const cwd = mkdtempSync(join(tmpdir(), 'video-repair-ownership-'));
const definition = {
  family: 'oxy-oxy-api',
  taskRoleArn: 'arn:aws:iam::237343248947:role/oxy-oxy-api-task',
  executionRoleArn: 'arn:aws:iam::237343248947:role/oxy-ecs-execution',
};
const env = { ...process.env, CLUSTER: 'oxy-cluster', SERVICE: 'oxy-api', GITHUB_RUN_ID: '12345' };
let checks = 0;
try {
  const runGuard = (task = definition, changes = {}) => {
    writeFileSync(join(cwd, 'live-taskdef.json'), JSON.stringify(task));
    return spawnSync('bash', ['-c', `set -euo pipefail\n${guard}\nprintf '%s' "$TASK_TAGS"`], {
      cwd,
      env: { ...env, ...changes },
      encoding: 'utf8',
    });
  };
  const valid = runGuard();
  assert.equal(valid.status, 0, valid.stderr);
  assert.deepEqual(JSON.parse(valid.stdout), [
    { key: 'OxyOperation', value: 'VideoRenditionRepair' },
    { key: 'OxyTaskFamily', value: 'oxy-oxy-api' },
    { key: 'OxyRunId', value: '12345' },
  ]);
  checks++;
  for (const field of ['family', 'taskRoleArn', 'executionRoleArn']) {
    assert.equal(runGuard({ ...definition, [field]: 'unexpected' }).status, 1);
    checks++;
  }
  for (const changes of [
    { CLUSTER: 'other' },
    { SERVICE: 'other' },
    { GITHUB_RUN_ID: '' },
    { GITHUB_RUN_ID: '1;exit 0' },
  ]) {
    assert.equal(runGuard(definition, changes).status, 1);
    checks++;
  }
  for (const [workStatus, stopStatus, expected] of [
    [0, 0, 0],
    [75, 0, 75],
    [130, 0, 130],
    [0, 1, 1],
    [75, 1, 75],
  ]) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
aws() { if [[ "$1 $2" == 'ecs stop-task' ]]; then return ${stopStatus}; fi; }
TASK_ARN=owned-task LOG_GROUP=logs LOG_PREFIX=repair CONTAINER=api TASK_ID=task
${cleanup}
exit ${workStatus}`,
      ],
      { cwd, env, encoding: 'utf8' },
    );
    assert.equal(result.status, expected, result.stderr);
    if (stopStatus) assert.match(result.stdout, /operator cleanup required/);
    checks++;
  }
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
console.log(`Video repair task ownership: ${checks} shell cases passed`);
