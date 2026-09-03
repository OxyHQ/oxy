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
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

process.stdout.write('Kaana signed-canary gate mutation tests passed.\n');
