#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.KAANA_CANARY_GATE_ROOT ?? process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const workflow = read('.github/workflows/kaana-signed-canary.yml');
const readbackWorkflow = read('.github/workflows/kaana-signed-deployment-readback.yml');
const canary = read('packages/api/scripts/run-kaana-signed-canary.mjs');

const failures = [];
const requireMatch = (source, pattern, message) => {
  if (!pattern.test(source)) failures.push(message);
};
const forbid = (source, pattern, message) => {
  if (pattern.test(source)) failures.push(message);
};

requireMatch(
  workflow,
  /workflow_dispatch:[\s\S]*?confirm_two_provider_requests:[\s\S]*?required: true[\s\S]*?type: boolean/,
  'the production canary must require explicit confirmation of its two provider requests',
);
requireMatch(
  workflow,
  /expected_snapshot_id:[\s\S]*?required: true[\s\S]*?deployment_id:[\s\S]*?required: true/,
  'the canary must require the exact signed readback snapshot and deployment id',
);
forbid(
  workflow,
  /model_reference:|CANARY_MODEL_REFERENCE/,
  'modelReference must come from the live signed descriptor, never an operator input',
);
requireMatch(
  workflow,
  /if: github\.ref == 'refs\/heads\/main'/,
  'the production canary workflow must run only from main',
);
requireMatch(
  workflow,
  /\.snapshotId == \$snapshot[\s\S]*?\.deploymentId == \$deployment/,
  'the canary result must bind the exact expected snapshot before deployment execution evidence',
);
requireMatch(
  workflow,
  /live_task_definition" != "\$EXPECTED_LIVE_TASK_DEFINITION_ARN"/,
  'the workflow must bind to the exact reviewed live task definition',
);
requireMatch(
  workflow,
  /\[ "\$\(jq '\.deployments \| length' <<<"\$service_json"\)" != 1 \] \|\|[\s\S]*?\.desiredCount > 0[\s\S]*?\.runningCount == \.desiredCount/,
  'the workflow must require exactly one non-empty steady service deployment',
);
requireMatch(
  workflow,
  /live_image" != "237343248947\.dkr\.ecr\.us-west-2\.amazonaws\.com\/oxy\/oxy-api@\$EXPECTED_LIVE_IMAGE_DIGEST"/,
  'the workflow must bind to the exact immutable live image digest',
);
requireMatch(
  workflow,
  /execution" != disabled[\s\S]*?kaana_origin" != 'https:\/\/kaana\.ai'/,
  'ambient execution must remain disabled and the signed origin must be exactly kaana.ai',
);
requireMatch(
  workflow,
  /\.environment = \[[\s\S]*?INFERENCE_KAANA_EXECUTION[\s\S]*?KAANA_BASE_URL[\s\S]*?KAANA_EDGE_SIGNING_KEY_ID[\s\S]*?\.secrets = \[\$signing_secret\]/,
  'the throwaway task must retain only the three non-secret bindings and one ECS-injected signing secret',
);
requireMatch(
  workflow,
  /\.family = "oxy-oxy-api-kaana-canary"/,
  'the throwaway task must use an isolated task-definition family',
);
requireMatch(
  workflow,
  /command:\["node","packages\/api\/scripts\/run-kaana-signed-canary\.mjs"\]/,
  'the ECS task must execute the reviewed canary from the live image',
);

const failureBranch = workflow.slice(
  workflow.indexOf('if [ "$exit_code" != 0 ]'),
  workflow.indexOf('\n\n          jq -e \\\n            --arg snapshot'),
);
requireMatch(
  failureBranch,
  /\(\(keys \| sort\) == \["code","oxyLedgerWrites","providerRequests","schemaVersion","status"\]\)[\s\S]*?\.schemaVersion == 1[\s\S]*?\.status == "failed"/,
  'the failure path must reject every field outside the exact operator-safe envelope',
);
requireMatch(
  failureBranch,
  /\.code \| type == "string" and test\("\^\[a-z0-9\]\[a-z0-9_-\]\{0,127\}\$"\)[\s\S]*?\.providerRequests == 0[\s\S]*?\.providerRequests == "at_most_2"[\s\S]*?\.oxyLedgerWrites == 0/,
  'the failure path must validate the diagnostic code and bounded write counters before display',
);
requireMatch(
  failureBranch,
  /jq -c '\{schemaVersion,status,code,providerRequests,oxyLedgerWrites\}' <<<"\$result"/,
  'the failure path must display only the five allowlisted diagnostic fields',
);
forbid(
  failureBranch,
  /jq -r '\.events\[\]\.message|\{schemaVersion,status,code,providerRequests,oxyLedgerWrites,[^}]*\}|requestId|request_id|content|secret/i,
  'the failure path must not dump free-form logs, request ids, content, secrets or extra result fields',
);

const minimizedTask = workflow.slice(
  workflow.indexOf('canary_task_json=$(jq'),
  workflow.indexOf("canary_task_definition=''"),
);
forbid(
  minimizedTask,
  /DATABASE_URL|REDIS_URL|OXY_PRIVATE_KEY|CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY/,
  'the minimized canary task must not receive database, Redis, Oxy or credential-control authority',
);

requireMatch(
  readbackWorkflow,
  /workflow_dispatch:[\s\S]*?expected_live_task_definition_arn:[\s\S]*?required: true[\s\S]*?expected_live_image_digest:[\s\S]*?required: true/,
  'signed readback must be a manually bounded exact-live workflow',
);
forbid(
  readbackWorkflow,
  /\n\s+default:/,
  'signed readback inputs must carry no operational defaults',
);
requireMatch(
  readbackWorkflow,
  /if: github\.ref == 'refs\/heads\/main'/,
  'signed readback must run only from main',
);
requireMatch(
  readbackWorkflow,
  /live_task_definition" != "\$EXPECTED_LIVE_TASK_DEFINITION_ARN"/,
  'signed readback must bind the exact reviewed live task definition',
);
requireMatch(
  readbackWorkflow,
  /\[ "\$\(jq '\.deployments \| length' <<<"\$service_json"\)" != 1 \] \|\|[\s\S]*?\.desiredCount > 0[\s\S]*?\.runningCount == \.desiredCount/,
  'signed readback must require exactly one non-empty steady service deployment',
);
requireMatch(
  readbackWorkflow,
  /\.family = "oxy-oxy-api-kaana-readback"/,
  'signed readback must use an isolated task-definition family',
);
requireMatch(
  readbackWorkflow,
  /execution" != disabled[\s\S]*?kaana_origin" != 'https:\/\/kaana\.ai'/,
  'signed readback must preserve disabled execution and the canonical origin',
);
requireMatch(
  readbackWorkflow,
  /live_image" != "237343248947\.dkr\.ecr\.us-west-2\.amazonaws\.com\/oxy\/oxy-api@\$EXPECTED_LIVE_IMAGE_DIGEST"/,
  'signed readback must bind the exact immutable live image digest',
);
requireMatch(
  readbackWorkflow,
  /command:\["node","packages\/api\/scripts\/run-kaana-signed-canary\.mjs","readback"\]/,
  'the readback task must invoke only the fixed signed readback operation',
);
requireMatch(
  readbackWorkflow,
  /\.environment = \[[\s\S]*?INFERENCE_KAANA_EXECUTION[\s\S]*?KAANA_BASE_URL[\s\S]*?KAANA_EDGE_SIGNING_KEY_ID[\s\S]*?\.secrets = \[\$signing_secret\]/,
  'signed readback must retain only the three non-secret bindings and one ECS-injected signing secret',
);
const minimizedReadbackTask = readbackWorkflow.slice(
  readbackWorkflow.indexOf('readback_task_json=$(jq'),
  readbackWorkflow.indexOf("readback_task_definition=''")
);
forbid(
  minimizedReadbackTask,
  /DATABASE_URL|REDIS_URL|OXY_PRIVATE_KEY|CREDENTIAL_CONTROL_SIGNING_PRIVATE_KEY/,
  'the minimized readback task must not receive database, Redis, Oxy or credential-control authority',
);

requireMatch(
  canary,
  /const CANONICAL_KAANA_ORIGIN = 'https:\/\/kaana\.ai';/,
  'the script must use only the canonical Kaana origin',
);
requireMatch(
  canary,
  /payload\.snapshotId !== config\.expectedSnapshotId[\s\S]*?fail\('snapshot_id_mismatch'\)/,
  'the signed exact-id lookup must fail if the serving snapshot changed after readback',
);
requireMatch(
  canary,
  /readKaanaLiveDeployments[\s\S]*?DEPLOYMENTS_PATH,[\s\S]*?\{\},[\s\S]*?'application\/json'/,
  'readback must sign the explicit empty-object deployment projection query',
);
requireMatch(
  canary,
  /KAANA_SIGNED_DEPLOYMENT_READBACK_RESULT=[\s\S]*?providerRequests: 0,[\s\S]*?oxyLedgerWrites: 0/,
  'signed readback must account for zero provider and Oxy ledger writes',
);
forbid(
  canary,
  /CANARY_MODEL_REFERENCE/,
  'the script must derive modelReference exclusively from the signed descriptor',
);
requireMatch(
  canary,
  /env\.INFERENCE_KAANA_EXECUTION !== 'disabled'/,
  'the script must independently refuse ambient execution that is not disabled',
);
requireMatch(
  canary,
  /maxOutputTokens: 1/,
  'each positive provider probe must stay capped at one output token',
);
requireMatch(
  canary,
  /cases\.push\(await expectSlugRefusal[\s\S]*?cases\.push\(await expectRouteRefusal[\s\S]*?cases\.push\(await expectSuccess/,
  'all slug and exact-route refusals must run before either provider probe',
);
requireMatch(
  canary,
  /providerRequests: 2,[\s\S]*?oxyLedgerWrites: 0/,
  'the result must account for exactly two provider probes and zero Oxy ledger writes',
);
forbid(
  canary,
  /api\.oxy\.so|RELAY_|ALIA_API_KEY|from ['"][^'"]*(?:db|ledger)[^'"]*['"]/i,
  'the direct canary must not call Oxy, retain Relay authority or import a database/ledger path',
);

if (failures.length > 0) {
  process.stderr.write(`Kaana signed-canary gate failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

process.stdout.write(
  'Kaana signed readback and canary stay live-snapshot-bound, exact-ID, secret-minimized and ambient-disabled.\n',
);
