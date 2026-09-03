#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.KAANA_CANARY_GATE_ROOT ?? process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const workflow = read('.github/workflows/kaana-signed-canary.yml');
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
  /if: github\.ref == 'refs\/heads\/main'/,
  'the production canary workflow must run only from main',
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
  canary,
  /const CANONICAL_KAANA_ORIGIN = 'https:\/\/kaana\.ai';/,
  'the script must use only the canonical Kaana origin',
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
  'Kaana signed canary stays exact-image, exact-ID, secret-minimized, two-request bounded and ambient-disabled.\n',
);
