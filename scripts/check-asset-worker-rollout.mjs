import { readFileSync } from 'node:fs';

// The asset-variant worker's rollout lives in .github/scripts/deploy-asset-variant-worker.sh
// (deploy-aws.yml runs it as oxy-api's PRE_ROLLOUT_SCRIPT, then again with `wait`).
const script = readFileSync(
  new URL('../.github/scripts/deploy-asset-variant-worker.sh', import.meta.url),
  'utf8',
);
const workflow = readFileSync(
  new URL('../.github/workflows/deploy-aws.yml', import.meta.url),
  'utf8',
);

// Comments are prose, not behaviour: a rule stated in one must not satisfy a check.
const code = script
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

if (/--desired-count\b/.test(code)) {
  throw new Error('worker deploy must not fight Application Auto Scaling');
}
if (!/\$service\.desiredCount > 0/.test(code)) {
  throw new Error('worker rollout must require positive autoscaled capacity');
}
if (!/\$service\.runningCount == \$service\.desiredCount/.test(code)) {
  throw new Error('worker rollout must verify every desired task is running');
}
if (!/\(\$service\.deployments \| length\) == 1/.test(code)) {
  throw new Error('worker rollout must require one consolidated deployment');
}
if (!/all\(\$service\.deployments\[\] \| select\(\.status != "PRIMARY"\); \.desiredCount == 0\)/.test(code)) {
  throw new Error('the API may only move once every old worker deployment is scaled to zero');
}
if (!/PRE_ROLLOUT_SCRIPT: \.github\/scripts\/deploy-asset-variant-worker\.sh/.test(workflow) ||
    !/WORKER_ROLLOUT_PHASE: start/.test(workflow)) {
  throw new Error('deploy-aws.yml must start the worker rollout before the API moves');
}
if (!/deploy-asset-variant-worker\.sh wait/.test(workflow)) {
  throw new Error('deploy-aws.yml must confirm the worker reached its exact steady state');
}

console.log('OK: asset worker rollout preserves and verifies autoscaled capacity');
