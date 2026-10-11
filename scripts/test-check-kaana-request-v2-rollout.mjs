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
  'packages/contracts/src/inference/privateAutoExecution.ts',
  'packages/contracts/src/inference/scopedExecution.ts',
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
  for (const [from, to] of [
    ['admitted.scopedExecution === undefined ? 2 : 3', '2'],
    [
      'admitted.scopedExecution === undefined ? 2 : 3',
      'admitted.scopedExecution === undefined ? 3 : 3',
    ],
    [
      'admitted.scopedExecution === undefined ? 2 : 3',
      'admitted.scopedExecution !== undefined ? 2 : 3',
    ],
    [
      '? inferenceRequestSchema : scopedInferenceRequestSchema',
      '? inferenceRequestSchema : inferenceRequestSchema',
    ],
    ['{ scopedExecution: admitted.scopedExecution }', '{ scopedExecution: undefined }'],
  ]) {
    const unsafeScopedBranch = fixture();
    roots.push(unsafeScopedBranch);
    mutate(unsafeScopedBranch, 'packages/api/src/services/inferenceEdge.service.ts', from, to);
    verdict(unsafeScopedBranch, 1);
  }
  // Every version and authority arm must remain paired, including ordinary v2.
  for (const [file, from, to] of [
    [
      'packages/api/src/services/inferenceEdge.service.ts',
      'admitted.privateAutoExecution !== undefined ? 4 :',
      'admitted.privateAutoExecution !== undefined ? 2 :',
    ],
    [
      'packages/api/src/services/inferenceEdge.service.ts',
      'admitted.privateAutoExecution !== undefined ? privateAutoInferenceRequestSchema :',
      'admitted.privateAutoExecution !== undefined ? inferenceRequestSchema :',
    ],
    [
      'packages/api/src/services/inferenceEdge.service.ts',
      'admitted.privateAutoExecution !== undefined ? privateAutoInferenceRequestSchema :',
      'admitted.privateAutoExecution === undefined ? privateAutoInferenceRequestSchema :',
    ],
    [
      'packages/api/src/services/inferenceEdge.service.ts',
      '{ privateAutoExecution: admitted.privateAutoExecution }',
      '{ privateAutoExecution: undefined }',
    ],
    [
      'packages/api/src/services/inferenceEdge.service.ts',
      "privateAutoExecutionContractVersion: '3.7.0' as const,\n      }),",
      "privateAutoExecutionContractVersion: '3.6.0' as const,\n      }),",
    ],
    [
      'packages/api/src/services/inferenceEdge.service.ts',
      '...(admitted.privateAutoExecution === undefined ? {} : {\n        privateAutoExecutionContractVersion:',
      '...(admitted.privateAutoExecution !== undefined ? {} : {\n        privateAutoExecutionContractVersion:',
    ],
    [
      'packages/contracts/src/inference/privateAutoExecution.ts',
      'PRIVATE_AUTO_REQUEST_ENVELOPE_VERSION = 4',
      'PRIVATE_AUTO_REQUEST_ENVELOPE_VERSION = 3',
    ],
    [
      'packages/contracts/src/inference/privateAutoExecution.ts',
      'PRIVATE_AUTO_EXECUTION_CONTRACT_VERSION = "3.7.0"',
      'PRIVATE_AUTO_EXECUTION_CONTRACT_VERSION = "3.6.0"',
    ],
    [
      'packages/contracts/src/inference/scopedExecution.ts',
      'SCOPED_REQUEST_ENVELOPE_VERSION = 3',
      'SCOPED_REQUEST_ENVELOPE_VERSION = 2',
    ],
    [
      'packages/contracts/src/inference/request.ts',
      '.omit({ scopedExecution: true })',
      '.omit({})',
    ],
    [
      'packages/contracts/src/inference/request.ts',
      'privateAutoExecution: privateAutoExecutionSchema })\n  .strict()',
      'privateAutoExecution: privateAutoExecutionSchema })',
    ],
    [
      'packages/contracts/src/inference/request.ts',
      'schemaVersion: z.literal(SCOPED_REQUEST_ENVELOPE_VERSION)',
      'schemaVersion: z.literal(2)',
    ],
  ]) {
    const unsafePrivateBranch = fixture();
    roots.push(unsafePrivateBranch);
    mutate(unsafePrivateBranch, file, from, to);
    try {
      verdict(unsafePrivateBranch, 1);
    } catch (error) {
      throw new Error(`Mutation escaped: ${file}: ${from}`, { cause: error });
    }
  }
  // Keep both predecessor generations covered, with the same fail-closed guard.
  const v3 = fixture();
  roots.push(v3);
  const edgePath = join(v3, 'packages/api/src/services/inferenceEdge.service.ts');
  const v3Source = readFileSync(edgePath, 'utf8')
    .replace(
      'admitted.privateAutoExecution !== undefined ? privateAutoInferenceRequestSchema : ',
      '',
    )
    .replace('admitted.privateAutoExecution !== undefined ? 4 : ', '')
    .replace(
      '    ...(admitted.privateAutoExecution === undefined ? {} : { privateAutoExecution: admitted.privateAutoExecution }),\n',
      '',
    )
    .replaceAll('privateAutoInferenceRequestSchema', 'removedPrivateSchema');
  writeFileSync(edgePath, v3Source);
  verdict(v3, 0);
  mutate(
    v3,
    'packages/api/src/services/inferenceEdge.service.ts',
    'schemaVersion: admitted.scopedExecution === undefined ? 2 : 3',
    'schemaVersion: 3',
  );
  verdict(v3, 1);

  const v2 = fixture();
  roots.push(v2);
  writeFileSync(
    join(v2, 'packages/api/src/services/inferenceEdge.service.ts'),
    v3Source
      .replace(
        '(admitted.scopedExecution === undefined ? inferenceRequestSchema : scopedInferenceRequestSchema)',
        'inferenceRequestSchema',
      )
      .replace('schemaVersion: admitted.scopedExecution === undefined ? 2 : 3', 'schemaVersion: 2')
      .replace(
        '    ...(admitted.scopedExecution === undefined ? {} : { scopedExecution: admitted.scopedExecution }),\n',
        '',
      )
      .replaceAll('scopedInferenceRequestSchema', 'removedScopedSchema'),
  );
  verdict(v2, 0);
  mutate(
    v2,
    'packages/api/src/services/inferenceEdge.service.ts',
    'schemaVersion: 2',
    'schemaVersion: 1',
  );
  verdict(v2, 1);
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

process.stdout.write('Kaana request-v2 rollout gate mutation tests passed.\n');
