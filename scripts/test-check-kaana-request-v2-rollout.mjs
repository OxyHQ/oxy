#!/usr/bin/env node

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = process.cwd();
const gate = join(repo, 'scripts/check-kaana-request-v2-rollout.mjs');
const files = [
  'packages/contracts/src/inference/request.ts',
  'packages/contracts/src/inference/routingPolicy.ts',
  'packages/api/src/services/inferenceEdge.service.ts',
  'packages/api/src/config/rolloutFlags.ts',
  '.github/workflows/deploy-aws.yml',
  'docs/release-evidence/kaana-request-v2-cutover-2026-09-09.md',
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'oxy-kaana-v2-gate-'));
  for (const file of files) {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repo, file), target, { recursive: false });
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
    env: { ...process.env, KAANA_V2_GATE_ROOT: root },
    encoding: 'utf8',
  });
  assert.equal(result.status, expected, result.stderr || result.stdout);
}

const roots = [];
try {
  const clean = fixture();
  roots.push(clean);
  verdict(clean, 0);

  const enabledExecution = fixture();
  roots.push(enabledExecution);
  mutate(
    enabledExecution,
    '.github/workflows/deploy-aws.yml',
    '"INFERENCE_KAANA_EXECUTION":"disabled"',
    '"INFERENCE_KAANA_EXECUTION":"enabled"',
  );
  verdict(enabledExecution, 1);

  const missingExecutionSwitch = fixture();
  roots.push(missingExecutionSwitch);
  mutate(
    missingExecutionSwitch,
    '.github/workflows/deploy-aws.yml',
    ',"INFERENCE_KAANA_EXECUTION":"disabled"',
    '',
  );
  verdict(missingExecutionSwitch, 1);

  const duplicateExecutionSwitch = fixture();
  roots.push(duplicateExecutionSwitch);
  mutate(
    duplicateExecutionSwitch,
    '.github/workflows/deploy-aws.yml',
    '"INFERENCE_KAANA_EXECUTION":"disabled"',
    '"INFERENCE_KAANA_EXECUTION":"disabled","INFERENCE_KAANA_EXECUTION":"disabled"',
  );
  verdict(duplicateExecutionSwitch, 1);

  const missingTaskEnvironmentBlock = fixture();
  roots.push(missingTaskEnvironmentBlock);
  mutate(
    missingTaskEnvironmentBlock,
    '.github/workflows/deploy-aws.yml',
    'TASK_ENV_OVERRIDES_JSON: >-',
    'TASK_ENVIRONMENT_OVERRIDES_JSON: >-',
  );
  verdict(missingTaskEnvironmentBlock, 1);

  const commentOnlyExecutionSwitch = fixture();
  roots.push(commentOnlyExecutionSwitch);
  mutate(
    commentOnlyExecutionSwitch,
    '.github/workflows/deploy-aws.yml',
    ',"INFERENCE_KAANA_EXECUTION":"disabled","OTEL_SERVICE_NAME"',
    ',"OTEL_SERVICE_NAME"',
  );
  mutate(
    commentOnlyExecutionSwitch,
    '.github/workflows/deploy-aws.yml',
    '"OTEL_RESOURCE_ATTRIBUTES":"deployment.environment.name=production,service.namespace=oxy"}\n          # Re-assert',
    '"OTEL_RESOURCE_ATTRIBUTES":"deployment.environment.name=production,service.namespace=oxy"}\n          # "INFERENCE_KAANA_EXECUTION":"disabled"\n          # Re-assert',
  );
  verdict(commentOnlyExecutionSwitch, 1);

  const staleCanaryEvidence = fixture();
  roots.push(staleCanaryEvidence);
  mutate(
    staleCanaryEvidence,
    'docs/release-evidence/kaana-request-v2-cutover-2026-09-09.md',
    'canary run: 34302325992',
    'canary run: 0',
  );
  verdict(staleCanaryEvidence, 1);

  const slugEnvelope = fixture();
  roots.push(slugEnvelope);
  mutate(
    slugEnvelope,
    'packages/contracts/src/inference/routingPolicy.ts',
    'kind: z.literal("routing_profile_id")',
    'kind: z.literal("routing_profile")',
  );
  verdict(slugEnvelope, 1);

  const oldRequest = fixture();
  roots.push(oldRequest);
  mutate(
    oldRequest,
    'packages/contracts/src/inference/request.ts',
    'schemaVersion: z.literal(2)',
    'schemaVersion: z.literal(1)',
  );
  verdict(oldRequest, 1);
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

process.stdout.write('Kaana request-v2 rollout gate mutation tests passed.\n');
