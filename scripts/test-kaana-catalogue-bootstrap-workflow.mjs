#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/bootstrap-kaana-catalogue.yml', 'utf8');
const attestor = readFileSync('.github/scripts/attest-kaana-catalogue-rollout.sh', 'utf8');
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');

assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
assert.match(workflow, /environment: production/);
assert.match(workflow, /group: deploy-oxy-api/);
assert.match(workflow, /cancel-in-progress: false/);
assert.match(workflow, /CLUSTER: oxy-cluster/);
assert.match(workflow, /SERVICE: oxy-api/);
assert.match(workflow, /NETWORK_SERVICE: kaana-publisher/);
assert.match(workflow, /role\/oxy-github-kaana-catalogue-bootstrap/);
assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
assert.match(workflow, /persist-credentials: false/);
assert.match(workflow, /expected_live_task_definition_arn/);
assert.match(workflow, /expected_bootstrap_task_definition_arn/);
assert.match(workflow, /expected_image/);
assert.match(workflow, /--task-definition "\$EXPECTED_BOOTSTRAP_TASK_DEFINITION_ARN"/);
assert.match(workflow, /verify exact RunTask and iam:PassRole authority/);
assert.equal(
  workflow.match(/\.github\/scripts\/attest-kaana-catalogue-rollout\.sh/g)?.length,
  2,
  'workflow must attest before and after the one-shot',
);
assert.doesNotMatch(
  workflow,
  /EXPECTED_LIVE_TASK_DEFINITION_ARN"\s*=\s*"\$EXPECTED_BOOTSTRAP_TASK_DEFINITION_ARN/,
  'the live service and dedicated one-shot must never be required to share a task-definition ARN',
);

assert.match(attestor, /capture_snapshot before[\s\S]*capture_snapshot after/);
assert.match(attestor, /still has old deployment tasks/);
assert.match(attestor, /primary rollout is not uniquely COMPLETED/);
assert.match(attestor, /described task identities differ from the RUNNING task list/);
assert.match(attestor, /does not use the attested immutable image/);
assert.match(attestor, /role\/oxy-kaana-catalogue-bootstrap/);
assert.match(attestor, /role\/oxy-ecs-execution/);
assert.match(attestor, /secrets\[\]\?\.name[\s\S]*DATABASE_URL/);
assert.match(attestor, /AWS_ACCESS_KEY_ID/);

assert.match(ci, /bash \.github\/scripts\/test-attest-kaana-catalogue-rollout\.sh/);
assert.match(ci, /node scripts\/test-kaana-catalogue-bootstrap-workflow\.mjs/);

process.stdout.write(
  'Kaana catalogue workflow serializes deploys and binds a double rollout attestation to the dedicated immutable one-shot.\n',
);
