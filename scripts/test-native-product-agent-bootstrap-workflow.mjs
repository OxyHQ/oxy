#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  '.github/workflows/bootstrap-native-product-agents.yml',
  'utf8',
);
const wrapper = readFileSync(
  'packages/api/scripts/run-native-product-agent-bootstrap.sh',
  'utf8',
);
const bootstrap = readFileSync(
  'packages/api/scripts/bootstrap-native-product-agents.ts',
  'utf8',
);

for (const exact of [
  '69b2d3df5d12f58c9800d651',
  '6a2f851751b784a86fd0e922',
  '01a0648e-ad3f-7608-aa8b-c07bfef6cf73',
  'oxy_dk_bed4f8941795512ddce5b0662879dccae52d8bd30308d240',
  '01a0646a-078f-7514-9800-9f43ceed7df8',
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
assert.match(workflow, /::group::\$task_label scoped CloudWatch log/);
assert.match(
  workflow,
  /select\(startswith\("NATIVE_PRODUCT_AGENTS_RESULT="\) \| not\)/,
  'failed task logs must be shown without echoing the authenticated result payload',
);
assert.ok(
  workflow.indexOf('log_json=$(aws logs get-log-events') <
    workflow.indexOf('if [ "$exit_code" != 0 ]'),
  'the exact task log must be fetched before a non-zero exit returns',
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
assert.match(bootstrap, /NATIVE_PRODUCT_AGENTS_RESULT=/);

process.stdout.write(
  'Native product-agent workflow pins exact IDs and protects create/reuse/dry-run/rollback secret handling.\n',
);
