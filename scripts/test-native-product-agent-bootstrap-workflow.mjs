#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  '.github/workflows/bootstrap-native-product-agents.yml',
  'utf8',
);
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const wrapper = readFileSync(
  'packages/api/scripts/run-native-product-agent-bootstrap.sh',
  'utf8',
);
const bootstrap = readFileSync(
  'packages/api/scripts/bootstrap-native-product-agents.ts',
  'utf8',
);
const failureReporter = readFileSync(
  '.github/scripts/report-native-product-agent-task-failure.sh',
  'utf8',
);

for (const exact of [
  '69b2d3df5d12f58c9800d651',
  '6a50444ce8026582b949089d',
  '01a0646a-078f-7974-9645-a5e8be237f47',
  '6a2f851751b784a86fd0e922',
  '01a0648e-ad3f-7608-aa8b-c07bfef6cf73',
  'oxy_dk_bed4f8941795512ddce5b0662879dccae52d8bd30308d240',
  '01a0646a-078f-7514-9800-9f43ceed7df8',
  '01a0646a-078f-7f53-848d-a0f82d9f7fa6',
  '01a0646a-078f-7120-a993-a03c180c81b0',
  '01a0646a-2382-74a3-a795-788924d55722',
  '01a0646e-2508-7048-8c08-b1f7b3af634f',
  '01a0648b-8d73-70ad-8e67-1c07ddc5eb6e',
  '01a0648b-8d74-7240-adba-80707fdfdf9c',
  'oxy_dk_8c84c74a2656b8f5147d4d0b65fcd0e88c192ce64f465f78',
  '01a0646a-078f-7642-95ef-439952f4f3f9',
  '/oxy/homiio/SINDI_OXY_SERVICE_API_KEY',
  '/oxy/homiio/SINDI_OXY_SERVICE_API_SECRET',
  '/oxy/clarity/OXY_SERVICE_API_KEY',
  '/oxy/clarity/OXY_SERVICE_API_SECRET',
]) {
  assert.ok(workflow.includes(exact), `workflow must pin exact value ${exact}`);
}

for (const binding of [
  'EXPECTED_OXY_ORGANIZATION_ID',
  'EXPECTED_HOMIIO_PROJECT_ID',
  'EXPECTED_HOMIIO_BOT_ID',
  'EXPECTED_HOMIIO_APPLICATION_ID',
  'EXPECTED_HOMIIO_SINDI_CREDENTIAL_ID',
  'EXPECTED_HOMIIO_SINDI_CLIENT_ID',
  'EXPECTED_HOMIIO_SINDI_AGENT_ID',
  'EXPECTED_CLARITY_PROJECT_ID',
  'EXPECTED_CLARITY_BOT_ID',
  'EXPECTED_CLARITY_APPLICATION_ID',
  'EXPECTED_CLARITY_PUBLIC_CREDENTIAL_ID',
  'EXPECTED_CLARITY_BACKEND_APPLICATION_ID',
  'EXPECTED_CLARITY_BACKEND_CREDENTIAL_ID',
  'EXPECTED_CLARITY_BACKEND_CLIENT_ID',
  'EXPECTED_CLARITY_AGENT_ID',
]) {
  assert.ok(workflow.includes(binding), `workflow must provide ${binding}`);
  assert.ok(bootstrap.includes(binding), `bootstrap must verify ${binding}`);
}

assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
assert.match(workflow, /group: native-product-agents-production/);
assert.match(workflow, /cancel-in-progress: false/);
assert.match(workflow, /id-token: write/);
assert.match(workflow, /role-to-assume: arn:aws:iam::237343248947:role\/oxy-github-deploy/);
assert.match(workflow, /CLUSTER: oxy-cluster/);
assert.match(workflow, /SERVICE: oxy-api/);
assert.match(workflow, /CONTAINER: oxy-api/);
assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
assert.match(workflow, /persist-credentials: false/);
assert.match(workflow, /dry-run-bootstrap[\s\S]*dry-run-rollback[\s\S]*rollback/);
assert.match(workflow, /if \[ "\$REQUESTED_MODE" = apply \]; then/);
assert.match(workflow, /put-secure-parameter\.sh "\$key_parameter" create/);
assert.match(workflow, /put-secure-parameter\.sh "\$secret_parameter" create/);
assert.match(workflow, /\.Parameter\.Type[\s\S]*SecureString/);
assert.match(workflow, /\.planSha256 == \$expected/);
assert.match(workflow, /homiio_credential_exists[\s\S]*original SSM pair is absent/);
assert.match(workflow, /clarity_credential_exists[\s\S]*original SSM pair is absent/);
assert.match(workflow, /partial SSM credential pair/);
assert.match(workflow, /HOMIIO_SINDI_SERVICE_SECRET_VALUE/);
assert.match(workflow, /CLARITY_BACKEND_SERVICE_SECRET_VALUE/);
assert.match(workflow, /register-task-definition/);
assert.match(workflow, /deregister-task-definition/);
assert.match(workflow, /EXPECTED_PLAN_SHA256/);
assert.match(workflow, /BOOTSTRAP_ACTOR_INPUT: \$\{\{ github\.actor \}\}/);
assert.match(workflow, /BOOTSTRAP_REASON/);
assert.match(
  workflow,
  /printf '%s' "\$result_line" \|[\s\S]*report-native-product-agent-task-failure\.sh "\$task_label" "\$exit_code"/,
  'a failed task must route only its structured result through the allowlisted reporter',
);
assert.ok(
  workflow.indexOf('log_json=$(aws logs get-log-events') <
    workflow.indexOf('if [ "$exit_code" != 0 ]'),
  'the exact task log must be fetched before a non-zero exit returns',
);
assert.doesNotMatch(
  workflow,
  /scoped CloudWatch log|select\(startswith\("NATIVE_PRODUCT_AGENTS_RESULT="\) \| not\)/,
  'failed tasks must never print free-form CloudWatch messages',
);

assert.match(failureReporter, /\(keys \| sort\) == \["code","status"\]/);
assert.match(failureReporter, /\(keys \| sort\) == \["code","planSha256","status"\]/);
assert.match(
  failureReporter,
  /\(keys \| sort\) == \["code","field","status","target"\]/,
);
assert.match(failureReporter, /\{code,target,field\}/);
assert.match(
  failureReporter,
  /\(keys \| sort\) == \["boundApplication","code","expectedAccountId","holder","status"\]/,
);
assert.match(
  failureReporter,
  /\(keys \| sort\) == \[\s*"accountStatus",\s*"id",\s*"kind",\s*"parentAccountId",\s*"privacyIsPrivateAccount",\s*"rootAccountId",\s*"type"\s*\]/,
);
assert.match(
  failureReporter,
  /\(keys \| sort\) == \[\s*"createdByUserId",\s*"id",\s*"isInternal",\s*"isOfficial",\s*"ownerAccountId",\s*"status",\s*"type"\s*\]/,
);
assert.match(
  failureReporter,
  /\(keys \| sort\) == \["direction","mode","planSha256","serviceCredentialState"\]/,
);
assert.match(failureReporter, /\{code,planSha256\}/);
assert.doesNotMatch(
  failureReporter,
  /\.events|CloudWatch|\{actor|\{reason|\{name|\{secret/,
  'the reporter must not consume logs or project personal, selector or secret fields',
);
assert.match(
  ci,
  /bash \.github\/scripts\/test-report-native-product-agent-task-failure\.sh/,
  'CI must execute the dynamic failure-envelope allowlist and mutation tests',
);

assert.doesNotMatch(workflow, /\$GITHUB_OUTPUT|--value\b|\$\{\{\s*secrets\./);
assert.doesNotMatch(
  workflow,
  /(?:OPENAI|ANTHROPIC|GROQ|CEREBRAS|XAI|OPENROUTER)_(?:API_)?KEY/i,
  'native agent bootstrap must never handle provider keys',
);

const overrideBlock = workflow.slice(
  workflow.indexOf('build_overrides()'),
  workflow.indexOf('log_group=$(jq'),
);
assert.doesNotMatch(
  overrideBlock,
  /HOMIIO_SINDI_SERVICE_SECRET_VALUE|CLARITY_BACKEND_SERVICE_SECRET_VALUE/,
  'plaintext secrets must enter through ECS secret refs, never run-task overrides',
);

assert.match(wrapper, /umask 077/);
assert.match(wrapper, /chmod 0600 "\$homiio_secret_file" "\$clarity_secret_file"/);
assert.match(wrapper, /unset HOMIIO_SINDI_SERVICE_SECRET_VALUE CLARITY_BACKEND_SERVICE_SECRET_VALUE/);
assert.match(wrapper, /trap cleanup EXIT HUP INT TERM/);
assert.doesNotMatch(wrapper, /set -x|echo .*SERVICE_SECRET_VALUE/);
assert.match(wrapper, />"\$bootstrap_output_file" 2>\/dev\/null/);
assert.match(wrapper, /grep -a '\^NATIVE_PRODUCT_AGENTS_RESULT='/);
assert.match(wrapper, /"code":"bootstrap_process_failed"/);
assert.match(wrapper, /fail_pre_entrypoint/);
assert.doesNotMatch(wrapper, /cat "\$bootstrap_output_file"/);
assert.match(wrapper, /result_count/);
assert.match(wrapper, /output_bytes/);
assert.match(wrapper, /is_valid_success_result/);
assert.doesNotMatch(
  wrapper,
  /\$\{(?:HOMIIO_SINDI_SERVICE_SECRET_VALUE|CLARITY_BACKEND_SERVICE_SECRET_VALUE):\?/,
  'missing protected inputs must not trigger free-form shell diagnostics',
);
assert.match(bootstrap, /NATIVE_PRODUCT_AGENTS_RESULT=/);
assert.doesNotMatch(bootstrap, /JSON\.stringify\(report, null, 2\)/);
assert.match(bootstrap, /nativeProductAgentBootstrapFailureResult\(error\)/);
assert.doesNotMatch(
  bootstrap,
  /process\.stderr\.write|error\.message|String\(error\)/,
  'bootstrap exceptions must cross only the structured result boundary',
);

const usernameHolderStart = bootstrap.indexOf('const usernameHolders = await tx');
const usernameHolderEnd = bootstrap.indexOf(
  'const usernameHolder = usernameHolders[0];',
  usernameHolderStart,
);
assert.notEqual(usernameHolderStart, -1, 'username collision query anchor must exist');
assert.notEqual(usernameHolderEnd, -1, 'username collision query end anchor must exist');
const usernameHolderQuery = bootstrap.slice(usernameHolderStart, usernameHolderEnd);
for (const projectedField of [
  'id',
  'kind',
  'type',
  'parentAccountId',
  'rootAccountId',
  'accountStatus',
  'privacyIsPrivateAccount',
]) {
  assert.match(
    usernameHolderQuery,
    new RegExp(`${projectedField}: users\\.${projectedField}`),
    `username collision query must project ${projectedField}`,
  );
}
assert.match(
  usernameHolderQuery,
  /lower\(btrim\(\$\{users\.username\}\)\) = lower\(btrim\(\$\{spec\.username\}\)\)/,
  'username collision lookup must use the exact unique-index expression',
);
assert.match(usernameHolderQuery, /usernameHolders\.length > 1/);
assert.doesNotMatch(
  usernameHolderQuery,
  /email|nameDisplay|secret|hash|token|\.limit\(|\.insert\(|\.update\(|\.delete\(|\.set\(/i,
  'the unique-username selector may only diagnose the collision with the reviewed holder fields',
);

const collisionEnd = bootstrap.indexOf('if (!row)', usernameHolderEnd);
assert.notEqual(collisionEnd, -1, 'username collision block end anchor must exist');
const collisionBlock = bootstrap.slice(usernameHolderEnd, collisionEnd);
assert.match(
  collisionBlock,
  /new NativeProductAgentUsernameCollisionError\(\s*spec\.id,\s*usernameHolder,\s*boundApplication,\s*\)/,
);
for (const projectedField of [
  'id',
  'ownerAccountId',
  'type',
  'status',
  'isOfficial',
  'isInternal',
  'createdByUserId',
]) {
  assert.match(
    collisionBlock,
    new RegExp(`${projectedField}: applications\\.${projectedField}`),
    `bound application query must project ${projectedField}`,
  );
}
assert.match(
  collisionBlock,
  /\.where\(eq\(applications\.id, boundApplicationId\)\)/,
  'bound application diagnostic must use its exact ID',
);
assert.doesNotMatch(
  collisionBlock,
  /email|nameDisplay|secret|hash|token|\.insert\(|\.update\(|\.delete\(|\.set\(/i,
  'the collision diagnostic may only read the reviewed application fields',
);

process.stdout.write(
  'Native product-agent workflow pins exact IDs and protects create/reuse/dry-run/rollback secret handling.\n',
);
