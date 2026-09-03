#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync('.github/workflows/bootstrap-kaana-catalogue.yml', 'utf8');
const attestor = readFileSync('.github/scripts/attest-kaana-catalogue-rollout.sh', 'utf8');
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const bootstrap = readFileSync('packages/api/scripts/bootstrap-kaana-catalogue.ts', 'utf8');
const rolloutGate = readFileSync(
  'packages/api/src/config/inferencePlatformScopeWriteGate.ts',
  'utf8',
);

function assertPreCommitRolloutFence(source) {
  const transactionStart = source.indexOf('await getDb().transaction(async (tx) => {');
  const lastCatalogueWrite = source.indexOf(
    'const routingProfileIds = await ensureProfiles(tx, revisionId, inserted);',
    transactionStart,
  );
  const preCommitProof = source.indexOf(
    'await rolloutGuard.assertStillComplete();',
    transactionStart,
  );
  const dryRunRollback = source.indexOf(
    'if (!APPLY) throw new DryRunRollback("dry-run rollback");',
    transactionStart,
  );
  const transactionEnd = source.indexOf('\n      });\n    } catch', transactionStart);

  assert.ok(transactionStart >= 0, 'bootstrap must use one PostgreSQL transaction');
  assert.ok(lastCatalogueWrite > transactionStart, 'catalogue writes must remain in the transaction');
  assert.ok(
    preCommitProof > lastCatalogueWrite,
    'the final live rollout proof must follow every catalogue write',
  );
  assert.ok(
    dryRunRollback > preCommitProof && transactionEnd > dryRunRollback,
    'the final live rollout proof must run inside the transaction immediately before commit',
  );
  assert.equal(
    source.match(/await rolloutGuard\.assertStillComplete\(\);/g)?.length,
    1,
    'bootstrap must contain exactly one final live rollout proof',
  );
  assert.match(
    source.slice(preCommitProof, dryRunRollback),
    /^await rolloutGuard\.assertStillComplete\(\);\s+$/,
    'no operation may intervene between the final live rollout proof and transaction return',
  );
  assert.match(
    source,
    /const rolloutGuard = await assertPlatformScopeWriteRolloutComplete\([\s\S]*try \{[\s\S]*finally \{\s+rolloutGuard\.close\(\);\s+\}/,
    'the rollout reader must be closed regardless of bootstrap outcome',
  );
}

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
assert.match(rolloutGate, /new DescribeServicesCommand\(/);
assert.match(rolloutGate, /new ListTasksCommand\(/);
assert.match(rolloutGate, /new DescribeTasksCommand\(/);
assert.doesNotMatch(
  rolloutGate,
  /DescribeTaskDefinition/,
  'the one-shot needs no task-definition read authority',
);

assertPreCommitRolloutFence(bootstrap);
assert.throws(
  () =>
    assertPreCommitRolloutFence(
      bootstrap.replace(
        'await rolloutGuard.assertStillComplete();',
        'await Promise.resolve(); // mutation: final live proof removed',
      ),
    ),
  /final live rollout proof/,
  'the workflow gate must kill a mutation that removes the pre-commit live proof',
);
assert.throws(
  () =>
    assertPreCommitRolloutFence(
      bootstrap
        .replace('await rolloutGuard.assertStillComplete();\n', '')
        .replace(
          'const routingProfileIds = await ensureProfiles(tx, revisionId, inserted);',
          'await rolloutGuard.assertStillComplete();\n        ' +
            'const routingProfileIds = await ensureProfiles(tx, revisionId, inserted);',
        ),
    ),
  /must follow every catalogue write/,
  'the workflow gate must kill a mutation that moves the proof before the final write',
);

process.stdout.write(
  'Kaana catalogue workflow binds live ECS proofs to the dedicated one-shot and its PostgreSQL commit.\n',
);
