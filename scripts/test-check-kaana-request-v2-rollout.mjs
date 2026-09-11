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

  const permanentExecutionFlag = fixture();
  roots.push(permanentExecutionFlag);
  mutate(
    permanentExecutionFlag,
    '.github/workflows/deploy-aws.yml',
    '"INFERENCE_ROUTING_SCORE_MIN_VALIDITY_SECONDS":"3600",',
    '"INFERENCE_ROUTING_SCORE_MIN_VALIDITY_SECONDS":"3600","INFERENCE_KAANA_EXECUTION":"enabled",',
  );
  verdict(permanentExecutionFlag, 1);

  const spacedPermanentExecutionFlag = fixture();
  roots.push(spacedPermanentExecutionFlag);
  mutate(
    spacedPermanentExecutionFlag,
    '.github/workflows/deploy-aws.yml',
    '"INFERENCE_ROUTING_SCORE_MIN_VALIDITY_SECONDS":"3600",',
    '"INFERENCE_ROUTING_SCORE_MIN_VALIDITY_SECONDS":"3600","INFERENCE_KAANA_EXECUTION" : "enabled",',
  );
  verdict(spacedPermanentExecutionFlag, 1);

  const missingRollbackRemoval = fixture();
  roots.push(missingRollbackRemoval);
  mutate(
    missingRollbackRemoval,
    '.github/workflows/deploy-aws.yml',
    ',"INFERENCE_KAANA_EXECUTION"]',
    ']',
  );
  verdict(missingRollbackRemoval, 1);

  const duplicateRollbackRemoval = fixture();
  roots.push(duplicateRollbackRemoval);
  mutate(
    duplicateRollbackRemoval,
    '.github/workflows/deploy-aws.yml',
    '"INFERENCE_KAANA_EXECUTION"]',
    '"INFERENCE_KAANA_EXECUTION","INFERENCE_KAANA_EXECUTION"]',
  );
  verdict(duplicateRollbackRemoval, 1);

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
