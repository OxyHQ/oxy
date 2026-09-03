#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.KAANA_CANARY_GATE_ROOT ?? process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');
const workflow = read('.github/workflows/kaana-signed-canary.yml');
const readbackWorkflow = read('.github/workflows/kaana-signed-deployment-readback.yml');
const canary = read('packages/api/scripts/run-kaana-signed-canary.mjs');
const inferenceErrorsContract = read('packages/contracts/src/inference/errors.ts');
const identifiersContract = read('packages/contracts/src/inference/identifiers.ts');
const streamEventsContract = read('packages/contracts/src/inference/streamEvents.ts');

const failures = [];
const requireMatch = (source, pattern, message) => {
  if (!pattern.test(source)) failures.push(message);
};
const forbid = (source, pattern, message) => {
  if (pattern.test(source)) failures.push(message);
};
const quotedArray = (source, name) => {
  const match = source.match(new RegExp(
    `(?:export\\s+)?const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\](?:\\s+as const)?;`,
  ));
  return match === null ? undefined : [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
};
const schemaFields = (source, name) => {
  const match = source.match(new RegExp(
    `export const ${name} = z\\.object\\(\\{([\\s\\S]*?)\\n\\}\\);`,
  ));
  return match === null
    ? undefined
    : [...match[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):/gm)].map((entry) => entry[1]);
};
const schemaRules = (source, name) => {
  const match = source.match(new RegExp(
    `export const ${name} = z\\.object\\(\\{([\\s\\S]*?)\\n\\}\\);`,
  ));
  return match === null
    ? undefined
    : [...match[1].matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):\s*([^,\n]+),/gm)]
      .map((entry) => [entry[1], entry[2].trim()]);
};
const requireExactList = (actual, expected, message) => {
  if (actual === undefined || expected === undefined ||
      actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    failures.push(message);
  }
};
const requireExactEntries = (actual, expected, message) => {
  if (actual === undefined || JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(message);
  }
};

const contractInferenceErrorCodes = quotedArray(inferenceErrorsContract, 'INFERENCE_ERROR_CODES');
const canaryInferenceErrorCodes = quotedArray(canary, 'CANARY_INFERENCE_ERROR_CODES');
const workflowInferenceErrorCodesMatch = workflow.match(/inference_error_codes_json='(\[[^\n]+\])'/);
let workflowInferenceErrorCodes;
try {
  workflowInferenceErrorCodes = workflowInferenceErrorCodesMatch === null
    ? undefined
    : JSON.parse(workflowInferenceErrorCodesMatch[1]);
} catch {
  workflowInferenceErrorCodes = undefined;
}
requireExactList(
  canaryInferenceErrorCodes,
  contractInferenceErrorCodes,
  'the canary inference-error allowlist must exactly match the published contract enum',
);
requireExactList(
  workflowInferenceErrorCodes,
  contractInferenceErrorCodes,
  'the workflow inference-error allowlist must exactly match the published contract enum',
);
requireExactList(
  quotedArray(canary, 'CANARY_START_EVENT_FIELDS'),
  schemaFields(streamEventsContract, 'inferenceStreamStartEventSchema'),
  'the canary start-event field allowlist must exactly match the published contract shape',
);
requireExactEntries(
  schemaRules(streamEventsContract, 'inferenceStreamStartEventSchema'),
  [
    ['schemaVersion', 'z.literal(1)'],
    ['type', "z.literal('start')"],
    ['requestId', 'requestIdSchema'],
    ['sequence', 'z.number().int().nonnegative().safe()'],
    ['generationId', 'generationIdSchema.optional()'],
    ['resolvedModelReference', 'modelReferenceSchema'],
    ['servingProvider', 'inferenceProviderSlugSchema'],
    ['startedAt', 'inferenceTimestampSchema'],
  ],
  'the start-event field schemas and optionality must remain exactly pinned',
);
requireMatch(
  identifiersContract,
  /export const requestIdSchema = z\.string\(\)\.min\(1\)\.max\(128\);/,
  'the canary request-id assumptions must remain pinned to the contract',
);
requireMatch(
  identifiersContract,
  /export const generationIdSchema = z\.string\(\)\.min\(1\)\.max\(128\);/,
  'the canary generation-id assumptions must remain pinned to the contract',
);
requireMatch(
  identifiersContract,
  /export const inferenceTimestampSchema = z\.string\(\)\.datetime\(\);/,
  'the canary timestamp assumptions must remain pinned to the UTC datetime contract',
);
requireMatch(
  canary,
  /const CANARY_START_ID_MAX_LENGTH = 128;/,
  'the local start-event identifier bound must remain equal to the contract',
);
const canaryTimestampPattern = canary.match(
  /const CANARY_UTC_DATETIME_PATTERN =\s*\/([^\n]+)\/;/,
)?.[1];
if (canaryTimestampPattern !==
    '^([0-9]{4})-([0-9]{2})-([0-9]{2})T([01][0-9]|2[0-3]):([0-5][0-9])(?::([0-5][0-9])(?:\\.([0-9]+))?)?Z$') {
  failures.push('the local start timestamp grammar must remain the exact UTC contract grammar');
}

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
  /\(\(keys \| sort\) == \["code","oxyLedgerWrites","providerRequests","schemaVersion","status"\]\) or[\s\S]*?\(\(keys \| sort\) == \["code","inferenceErrorCode","oxyLedgerWrites","providerRequests","schemaVersion","status"\]\)[\s\S]*?\.code \| endswith\("_execution_error_event_present"\)[\s\S]*?\$inference_error_codes \| index\(\$inference_error_code\) != null/,
  'the failure path must allow only the base envelope or a closed error-code extension for execution error events',
);
requireMatch(
  failureBranch,
  /\.code \| type == "string" and test\("\^\[a-z0-9\]\[a-z0-9_-\]\{0,127\}\$"\)[\s\S]*?\.providerRequests == 0[\s\S]*?\.providerRequests == "at_most_2"[\s\S]*?\.oxyLedgerWrites == 0/,
  'the failure path must validate the diagnostic code and bounded write counters before display',
);
requireMatch(
  failureBranch,
  /jq -c 'if has\("inferenceErrorCode"\) then[\s\S]*?\{schemaVersion,status,code,inferenceErrorCode,providerRequests,oxyLedgerWrites\}[\s\S]*?else[\s\S]*?\{schemaVersion,status,code,providerRequests,oxyLedgerWrites\}[\s\S]*?end' <<<"\$result"/,
  'the failure path must display only the exact base or closed-code diagnostic projection',
);
forbid(
  failureBranch,
  /jq -r '\.events\[\]\.message|\{schemaVersion,status,code,providerRequests,oxyLedgerWrites,[^}]*\}|requestId|request_id|secret/i,
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
requireMatch(
  streamEventsContract,
  /generationId: generationIdSchema\.optional\(\)/,
  'the start-event compatibility rule must remain explicitly limited to optional generationId',
);
requireMatch(
  canary,
  /function hasExactStartEventFields\(event\)[\s\S]*?Object\.keys\(event\)[\s\S]*?actualFields\.length === expectedFields\.length[\s\S]*?expectedFields\.every\(\(field\) => Object\.prototype\.hasOwnProperty\.call\(event, field\)\)[\s\S]*?if \(!hasExactStartEventFields\(start\)\)[\s\S]*?start_route_identity_present/,
  'the canary must reject every start event outside the exact contract field sets',
);
requireMatch(
  canary,
  /if \(start\?\.type !== 'start'\) fail\(`\$\{label\}_start_event_not_first`\)/,
  'the first stream event must be the contract start type',
);
requireMatch(
  canary,
  /if \(start\.schemaVersion !== 1\) fail\(`\$\{label\}_start_schema_mismatch`\)/,
  'the canary must require start schemaVersion 1',
);
requireMatch(
  canary,
  /if \(start\.requestId !== probe\.requestId\) fail\(`\$\{label\}_start_request_mismatch`\)/,
  'the canary must bind the start event to the exact probe request id',
);
requireMatch(
  canary,
  /!Number\.isSafeInteger\(start\.sequence\) \|\| start\.sequence !== 0[\s\S]*?start_sequence_mismatch/,
  'the first start event must carry the safe integer sequence zero',
);
requireMatch(
  canary,
  /hasOwnProperty\.call\(start, 'generationId'\)[\s\S]*?typeof start\.generationId !== 'string'[\s\S]*?start\.generationId\.length < 1[\s\S]*?start\.generationId\.length > CANARY_START_ID_MAX_LENGTH[\s\S]*?start_generation_mismatch/,
  'the optional generation id must match the contract string bounds',
);
requireMatch(
  canary,
  /function isContractUtcTimestamp\(value\)[\s\S]*?typeof value !== 'string'[\s\S]*?CANARY_UTC_DATETIME_PATTERN\.exec\(value\)[\s\S]*?month < 1 \|\| month > 12[\s\S]*?leapYear[\s\S]*?daysInMonth[\s\S]*?return day >= 1 && day <= daysInMonth\[month - 1\][\s\S]*?if \(!isContractUtcTimestamp\(start\.startedAt\)\)[\s\S]*?start_timestamp_mismatch/,
  'the start timestamp must match the contract UTC datetime grammar and calendar',
);
requireMatch(
  canary,
  /function safeInferenceErrorCode\(event\)[\s\S]*?event\?\.error\?\.code[\s\S]*?CANARY_INFERENCE_ERROR_CODE_SET\.has\(code\)/,
  'the canary may project only event.error.code from the closed contract enum',
);
requireMatch(
  canary,
  /code\.endsWith\('_execution_error_event_present'\)[\s\S]*?result\.inferenceErrorCode = error\.inferenceErrorCode/,
  'the failure envelope may add inferenceErrorCode only for execution error events',
);
for (const diagnostic of [
  'execution_error_event_present',
  'start_event_count_mismatch',
  'start_event_not_first',
  'start_route_identity_present',
  'start_schema_mismatch',
  'start_request_mismatch',
  'start_sequence_mismatch',
  'start_generation_mismatch',
  'start_timestamp_mismatch',
  'start_model_mismatch',
  'start_provider_mismatch',
  'done_event_count_mismatch',
  'done_event_not_terminal',
  'terminal_receipt_present',
  'usage_report_count_mismatch',
  'usage_schema_mismatch',
  'usage_request_mismatch',
  'usage_outcome_mismatch',
  'usage_deployment_mismatch',
  'usage_model_mismatch',
  'usage_provider_mismatch',
  'usage_units_missing',
]) {
  if (!canary.includes('`${label}_' + diagnostic + '`')) {
    failures.push(`the positive canary must preserve the safe ${diagnostic} diagnostic`);
  }
}
forbid(
  canary,
  /start_deployment_mismatch/,
  'the start event must never be required to expose a deployment id',
);
forbid(
  canary,
  /did_not_complete_exact_route/,
  'the positive canary must not collapse distinct response failures into one aggregate code',
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
