import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const packageRoot = new URL('..', import.meta.url);
const temporaryRoot = await mkdtemp(join(tmpdir(), 'oxy-core-package-'));
const scopeDirectory = join(temporaryRoot, 'node_modules', '@oxy.so');

try {
  await mkdir(scopeDirectory, { recursive: true });
  await symlink(packageRoot, join(scopeDirectory, 'core'), 'dir');

  const runner = join(temporaryRoot, 'verify.cjs');
  await writeFile(
    runner,
    [
      "const assert = require('node:assert/strict');",
      "for (const id of ['@oxy.so/core', '@oxy.so/core/logger', '@oxy.so/core/server']) {",
      '  const loaded = require(id);',
      "  assert.equal(typeof loaded, 'object', `${id} must load through require()`);",
      '}',
    ].join('\n'),
  );

  const { spawnSync } = await import('node:child_process');
  const required = spawnSync(process.execPath, [runner], { encoding: 'utf8' });
  assert.equal(required.status, 0, required.stderr || required.stdout);

  const importRunner = join(temporaryRoot, 'verify.mjs');
  await writeFile(
    importRunner,
    [
      "import assert from 'node:assert/strict';",
      "for (const id of ['@oxy.so/core', '@oxy.so/core/logger', '@oxy.so/core/server']) {",
      '  const loaded = await import(id);',
      "  assert.equal(typeof loaded, 'object', `${id} must load through import()`);",
      '}',
    ].join('\n'),
  );
  const imported = spawnSync(process.execPath, [importRunner], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr || imported.stdout);
  // The same import must select a client-only module under bundler conditions.
  // Checking resolution as well as the return value catches runtime guards
  // that still drag node:crypto into a mobile/browser graph.
  const clientRunner = join(temporaryRoot, 'verify-client.mjs');
  await writeFile(clientRunner, [
    "import assert from 'node:assert/strict';",
    "import { canAttestWorkloadIdentity, requestWorkloadServiceToken } from '@oxy.so/core/internal/workload-identity';",
    "assert.match(import.meta.resolve('@oxy.so/core/internal/workload-identity'), /workloadIdentity\\.client\\.js$/);",
    "assert.equal(canAttestWorkloadIdentity(), false);",
    "await assert.rejects(requestWorkloadServiceToken({ baseUrl: 'https://example.test' }), /only available on a Node host/);",
  ].join('\n'));
  for (const condition of ['react-native', 'browser']) {
    const client = spawnSync(process.execPath, [`--conditions=${condition}`, clientRunner], { encoding: 'utf8' });
    assert.equal(client.status, 0, client.stderr || client.stdout);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
