import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateIssuerSource } from '../../.github/scripts/guard-issuer-image-only.mjs';
const manifest = JSON.parse(
  readFileSync('docs/audits/2026-10-03-service-token-issuer-stage/runtime-inputs.json'),
);
const facts = () => ({
  event: 'workflow_dispatch',
  ref: 'refs/heads/main',
  policyStatus: 'ACTIVE',
  manifest,
  paths: Object.keys(manifest.packages),
  committed: (path) => readFileSync(path),
  working: (path) => readFileSync(path),
  ddlPaths: [],
});
validateIssuerSource(facts());
for (const patch of [
  { event: 'push' },
  { ref: 'refs/heads/other' },
  { policyStatus: 'INACTIVE' },
  { manifest: { ...manifest, base: '0'.repeat(40) } },
  { paths: [...Object.keys(manifest.packages), 'packages/api/new-runtime.ts'] },
  { ddlPaths: ['packages/api/drizzle/new.sql'] },
  { working: () => Buffer.from('modified') },
  { committed: () => Buffer.from('modified') },
]) {
  assert.throws(() => validateIssuerSource({ ...facts(), ...patch }));
}
const directory = mkdtempSync(join(tmpdir(), 'oxy1519-image-only-fixture-'));
try {
  mkdirSync(join(directory, '.github/scripts'), { recursive: true });
  mkdirSync(join(directory, 'bin'));
  writeFileSync(
    join(directory, '.github/scripts/deploy-issuer-image-only.sh'),
    readFileSync('.github/scripts/deploy-issuer-image-only.sh'),
  );
  // Observe the actual wrapper environment; guard + existing deployer are separately tested.
  writeFileSync(
    join(directory, 'bin/node'),
    '#!/bin/sh\n[ "$1" = .github/scripts/guard-issuer-image-only.mjs ] || exit 2\nexit "${GUARD_EXIT:-0}"\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(directory, 'bin/bash'),
    '#!/bin/sh\n[ "$1" = .github/scripts/deploy-ecs-image.sh ] || exit 2\n/usr/bin/env > "$OUTPUT"\n',
    { mode: 0o755 },
  );
  const output = join(directory, 'output');
  const poisoned = [
    'INTERNAL_METRICS_PARAMETER',
    'PRE_DEPLOY_TASK_COMMAND_JSON',
    'POST_DEPLOY_TASK_COMMAND_JSON',
    'PRE_ROLLOUT_SCRIPT',
    'TASK_ENV_OVERRIDES_JSON',
    'TASK_SECRET_OVERRIDES_JSON',
    'TASK_REMOVE_NAMES_JSON',
    'TASK_EXTRA_CONTAINERS_JSON',
    'POST_DEPLOY_TASKS_JSON',
  ];
  const env = {
    ...process.env,
    PATH: `${directory}/bin:${process.env.PATH}`,
    OUTPUT: output,
    ...Object.fromEntries(poisoned.map((name) => [name, 'unexpected-inherited-input'])),
    RUN_MIGRATIONS: 'true',
  };
  execFileSync('/bin/bash', ['.github/scripts/deploy-issuer-image-only.sh'], {
    cwd: directory,
    env,
  });
  const result = Object.fromEntries(
    readFileSync(output, 'utf8')
      .trim()
      .split('\n')
      .map((row) => {
        const index = row.indexOf('=');
        return [row.slice(0, index), row.slice(index + 1)];
      }),
  );
  assert.equal(result.RUN_MIGRATIONS, 'false');
  assert.equal(result.INTERNAL_METRICS_PARAMETER, '');
  for (const name of [
    'PRE_DEPLOY_TASK_COMMAND_JSON',
    'POST_DEPLOY_TASK_COMMAND_JSON',
    'PRE_ROLLOUT_SCRIPT',
  ])
    assert.equal(result[name], '');
  for (const name of ['TASK_ENV_OVERRIDES_JSON', 'TASK_SECRET_OVERRIDES_JSON'])
    assert.equal(result[name], '{}');
  for (const name of [
    'TASK_REMOVE_NAMES_JSON',
    'TASK_EXTRA_CONTAINERS_JSON',
    'POST_DEPLOY_TASKS_JSON',
  ])
    assert.equal(result[name], '[]');
  assert.equal(result.POST_DEPLOY_TASKS_CONCURRENT, 'false');
  assert.equal(result.POST_DEPLOY_SMOKE_SCRIPT, '.github/scripts/smoke-oxy-api.sh');
  rmSync(output);
  assert.throws(() =>
    execFileSync('/bin/bash', ['.github/scripts/deploy-issuer-image-only.sh'], {
      cwd: directory,
      env: { ...env, GUARD_EXIT: '1' },
    }),
  );
  assert.throws(() => readFileSync(output));
  console.log(
    'Issuer guard: exact source positive + eight negatives; wrapper clears inherited mutation hooks/overrides and guard failure prevents deploy (AWS/helper mocked).',
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
