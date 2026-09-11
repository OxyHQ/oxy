import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../.github/workflows/deploy-aws.yml', import.meta.url),
  'utf8',
);
const step = workflow.match(
  /- name: Deploy asset-variant worker before the API([\s\S]*?)(?=\n      - name:)/,
)?.[1];

if (!step) throw new Error('asset-variant worker deployment step is missing');
if (/--desired-count\b/.test(step)) {
  throw new Error('worker deploy must not fight Application Auto Scaling');
}
if (!/\.desiredCount > 0/.test(step)) {
  throw new Error('worker rollout must require positive autoscaled capacity');
}
if (!/\.runningCount == \$service\.desiredCount/.test(step)) {
  throw new Error('worker rollout must verify every desired task is running');
}
if (!/\(\$service\.deployments \| length\) == 1/.test(step)) {
  throw new Error('worker rollout must require one consolidated deployment');
}

console.log('OK: asset worker rollout preserves and verifies autoscaled capacity');
