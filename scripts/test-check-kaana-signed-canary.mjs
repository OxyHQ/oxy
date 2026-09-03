#!/usr/bin/env node

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const gate = join(repo, 'scripts/check-kaana-signed-canary.mjs');
const files = [
  '.github/workflows/kaana-signed-canary.yml',
  '.github/workflows/kaana-signed-deployment-readback.yml',
  'packages/api/scripts/run-kaana-signed-canary.mjs',
  'packages/contracts/src/inference/errors.ts',
  'packages/contracts/src/inference/identifiers.ts',
  'packages/contracts/src/inference/streamEvents.ts',
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oxy-kaana-canary-gate-'));
  for (const file of files) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repo, file), target);
  }
  return root;
}

function mutate(root, file, from, to) {
  const path = join(root, file);
  const source = readFileSync(path, 'utf8');
  assert.ok(source.includes(from), `${file} fixture no longer contains mutation anchor`);
  writeFileSync(path, source.replace(from, to));
}

function verdict(root, expected) {
  const result = spawnSync(process.execPath, [gate], {
    cwd: repo,
    env: { ...process.env, KAANA_CANARY_GATE_ROOT: root },
    encoding: 'utf8',
  });
  assert.equal(result.status, expected, result.stderr || result.stdout);
}

const roots = [];
try {
  const clean = fixture();
  roots.push(clean);
  verdict(clean, 0);

  const wrongOrigin = fixture();
  roots.push(wrongOrigin);
  mutate(
    wrongOrigin,
    'packages/api/scripts/run-kaana-signed-canary.mjs',
    "const CANONICAL_KAANA_ORIGIN = 'https://kaana.ai';",
    "const CANONICAL_KAANA_ORIGIN = 'https://kaana.oxy.so';",
  );
  verdict(wrongOrigin, 1);

  const enabled = fixture();
  roots.push(enabled);
  mutate(
    enabled,
    'packages/api/scripts/run-kaana-signed-canary.mjs',
    "env.INFERENCE_KAANA_EXECUTION !== 'disabled'",
    "env.INFERENCE_KAANA_EXECUTION !== 'enabled'",
  );
  verdict(enabled, 1);

  const widerProbe = fixture();
  roots.push(widerProbe);
  mutate(
    widerProbe,
    'packages/api/scripts/run-kaana-signed-canary.mjs',
    'maxOutputTokens: 1',
    'maxOutputTokens: 8',
  );
  verdict(widerProbe, 1);

  const databaseAuthority = fixture();
  roots.push(databaseAuthority);
  mutate(
    databaseAuthority,
    '.github/workflows/kaana-signed-canary.yml',
    '{name:"KAANA_EDGE_SIGNING_KEY_ID", value:$key_id}',
    '{name:"KAANA_EDGE_SIGNING_KEY_ID", value:$key_id},\n                    {name:"DATABASE_URL", value:"unsafe"}',
  );
  verdict(databaseAuthority, 1);

  const productionTaskFamily = fixture();
  roots.push(productionTaskFamily);
  mutate(
    productionTaskFamily,
    '.github/workflows/kaana-signed-canary.yml',
    '.family = "oxy-oxy-api-kaana-canary"',
    '.family = "oxy-oxy-api"',
  );
  verdict(productionTaskFamily, 1);

  const weakenedSteadyState = fixture();
  roots.push(weakenedSteadyState);
  mutate(
    weakenedSteadyState,
    '.github/workflows/kaana-signed-canary.yml',
    "[ \"$(jq '.deployments | length' <<<\"$service_json\")\" != 1 ] || \\",
    "[ \"$(jq '.deployments | length' <<<\"$service_json\")\" -lt 1 ] || \\",
  );
  verdict(weakenedSteadyState, 1);

  const staleSnapshotAccepted = fixture();
  roots.push(staleSnapshotAccepted);
  mutate(
    staleSnapshotAccepted,
    'packages/api/scripts/run-kaana-signed-canary.mjs',
    'payload.snapshotId !== config.expectedSnapshotId',
    'false',
  );
  verdict(staleSnapshotAccepted, 1);

  const selectedReadback = fixture();
  roots.push(selectedReadback);
  mutate(
    selectedReadback,
    'packages/api/scripts/run-kaana-signed-canary.mjs',
    "DEPLOYMENTS_PATH,\n    {},\n    'application/json',",
    "DEPLOYMENTS_PATH,\n    { deploymentId: 'dep_first' },\n    'application/json',",
  );
  verdict(selectedReadback, 1);

  const executableReadback = fixture();
  roots.push(executableReadback);
  mutate(
    executableReadback,
    '.github/workflows/kaana-signed-deployment-readback.yml',
    'run-kaana-signed-canary.mjs","readback"',
    'run-kaana-signed-canary.mjs"',
  );
  verdict(executableReadback, 1);

  const readbackDatabaseAuthority = fixture();
  roots.push(readbackDatabaseAuthority);
  mutate(
    readbackDatabaseAuthority,
    '.github/workflows/kaana-signed-deployment-readback.yml',
    '{name:"KAANA_EDGE_SIGNING_KEY_ID", value:$key_id}',
    '{name:"KAANA_EDGE_SIGNING_KEY_ID", value:$key_id},\n                    {name:"DATABASE_URL", value:"unsafe"}',
  );
  verdict(readbackDatabaseAuthority, 1);

  const unpinnedImage = fixture();
  roots.push(unpinnedImage);
  mutate(
    unpinnedImage,
    '.github/workflows/kaana-signed-canary.yml',
    'oxy-api@$EXPECTED_LIVE_IMAGE_DIGEST',
    'oxy-api:latest',
  );
  verdict(unpinnedImage, 1);

  const unboundedFailureEnvelope = fixture();
  roots.push(unboundedFailureEnvelope);
  mutate(
    unboundedFailureEnvelope,
    '.github/workflows/kaana-signed-canary.yml',
    '((keys | sort) == ["code","oxyLedgerWrites","providerRequests","schemaVersion","status"])',
    'true',
  );
  verdict(unboundedFailureEnvelope, 1);

  const leakedFailureRequestId = fixture();
  roots.push(leakedFailureRequestId);
  mutate(
    leakedFailureRequestId,
    '.github/workflows/kaana-signed-canary.yml',
    '{schemaVersion,status,code,inferenceErrorCode,providerRequests,oxyLedgerWrites}',
    '{schemaVersion,status,code,inferenceErrorCode,providerRequests,oxyLedgerWrites,requestId}',
  );
  verdict(leakedFailureRequestId, 1);

  const widenedFailureEnvelope = fixture();
  roots.push(widenedFailureEnvelope);
  mutate(
    widenedFailureEnvelope,
    '.github/workflows/kaana-signed-canary.yml',
    '["code","inferenceErrorCode","oxyLedgerWrites","providerRequests","schemaVersion","status"]',
    '["code","inferenceErrorCode","oxyLedgerWrites","providerDetail","providerRequests","schemaVersion","status"]',
  );
  verdict(widenedFailureEnvelope, 1);

  const weakenedInferenceErrorEnum = fixture();
  roots.push(weakenedInferenceErrorEnum);
  mutate(
    weakenedInferenceErrorEnum,
    '.github/workflows/kaana-signed-canary.yml',
    '$inference_error_codes | index($inference_error_code) != null',
    'true',
  );
  verdict(weakenedInferenceErrorEnum, 1);

  const driftedInferenceErrorEnum = fixture();
  roots.push(driftedInferenceErrorEnum);
  mutate(
    driftedInferenceErrorEnum,
    'packages/api/scripts/run-kaana-signed-canary.mjs',
    "  'provider_billing_refused',",
    "  'provider_billing_refused_typo',",
  );
  verdict(driftedInferenceErrorEnum, 1);

  const weakenedStartEventShape = fixture();
  roots.push(weakenedStartEventShape);
  mutate(
    weakenedStartEventShape,
    'packages/api/scripts/run-kaana-signed-canary.mjs',
    'actualFields.length === expectedFields.length &&',
    'true &&',
  );
  verdict(weakenedStartEventShape, 1);

  const driftedStartEventAllowlist = fixture();
  roots.push(driftedStartEventAllowlist);
  mutate(
    driftedStartEventAllowlist,
    'packages/api/scripts/run-kaana-signed-canary.mjs',
    "  'startedAt',",
    "  'createdAt',",
  );
  verdict(driftedStartEventAllowlist, 1);

  const driftedStartEventOptionality = fixture();
  roots.push(driftedStartEventOptionality);
  mutate(
    driftedStartEventOptionality,
    'packages/contracts/src/inference/streamEvents.ts',
    'generationId: generationIdSchema.optional(),',
    'generationId: generationIdSchema,',
  );
  verdict(driftedStartEventOptionality, 1);

  const driftedGenerationIdContract = fixture();
  roots.push(driftedGenerationIdContract);
  mutate(
    driftedGenerationIdContract,
    'packages/contracts/src/inference/identifiers.ts',
    'export const generationIdSchema = z.string().min(1).max(128);',
    'export const generationIdSchema = z.string().min(1).max(256);',
  );
  verdict(driftedGenerationIdContract, 1);

  const driftedRequestIdContract = fixture();
  roots.push(driftedRequestIdContract);
  mutate(
    driftedRequestIdContract,
    'packages/contracts/src/inference/identifiers.ts',
    'export const requestIdSchema = z.string().min(1).max(128);',
    'export const requestIdSchema = z.string().min(1).max(256);',
  );
  verdict(driftedRequestIdContract, 1);

  const driftedTimestampContract = fixture();
  roots.push(driftedTimestampContract);
  mutate(
    driftedTimestampContract,
    'packages/contracts/src/inference/identifiers.ts',
    'export const inferenceTimestampSchema = z.string().datetime();',
    'export const inferenceTimestampSchema = z.string().datetime({ offset: true });',
  );
  verdict(driftedTimestampContract, 1);

  for (const weakening of [
    {
      name: 'start type',
      from: "start?.type !== 'start'",
      to: 'false',
    },
    {
      name: 'schema version',
      from: 'start.schemaVersion !== 1',
      to: 'false',
    },
    {
      name: 'request identity',
      from: 'start.requestId !== probe.requestId',
      to: 'false',
    },
    {
      name: 'sequence',
      from: '!Number.isSafeInteger(start.sequence) || start.sequence !== 0',
      to: 'false',
    },
    {
      name: 'generation id minimum',
      from: 'start.generationId.length < 1',
      to: 'false',
    },
    {
      name: 'generation id',
      from: 'start.generationId.length > CANARY_START_ID_MAX_LENGTH',
      to: 'false',
    },
    {
      name: 'timestamp type',
      from: "typeof value !== 'string'",
      to: 'false',
    },
    {
      name: 'timestamp use',
      from: '!isContractUtcTimestamp(start.startedAt)',
      to: 'false',
    },
    {
      name: 'timestamp calendar',
      from: 'return day >= 1 && day <= daysInMonth[month - 1];',
      to: 'return true;',
    },
  ]) {
    const weakenedStartValue = fixture();
    roots.push(weakenedStartValue);
    mutate(
      weakenedStartValue,
      'packages/api/scripts/run-kaana-signed-canary.mjs',
      weakening.from,
      weakening.to,
    );
    verdict(weakenedStartValue, 1);
  }

  const widenedTimestampGrammar = fixture();
  roots.push(widenedTimestampGrammar);
  mutate(
    widenedTimestampGrammar,
    'packages/api/scripts/run-kaana-signed-canary.mjs',
    '(?:\\.([0-9]+))?)?Z$/;',
    '(?:\\.([0-9]+))?)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;',
  );
  verdict(widenedTimestampGrammar, 1);

  const freeFormFailureLogs = fixture();
  roots.push(freeFormFailureLogs);
  mutate(
    freeFormFailureLogs,
    '.github/workflows/kaana-signed-canary.yml',
    "echo '::error::canary emitted an unsafe or invalid failure result envelope'",
    "jq -r '.events[].message' <<<\"$log_json\"",
  );
  verdict(freeFormFailureLogs, 1);

  const aggregatePositiveFailure = fixture();
  roots.push(aggregatePositiveFailure);
  mutate(
    aggregatePositiveFailure,
    'packages/api/scripts/run-kaana-signed-canary.mjs',
    '`${label}_start_route_identity_present`',
    '`${label}_did_not_complete_exact_route`',
  );
  verdict(aggregatePositiveFailure, 1);
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

process.stdout.write('Kaana signed-canary gate mutation tests passed.\n');
