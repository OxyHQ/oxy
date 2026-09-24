import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  // `#workload-identity` (package.json `imports`) must select the client-only
  // module under bundler conditions and the signer under plain Node. It is a
  // package-private specifier, so the probe has to live inside the package;
  // it is written next to the mixin that performs the import and removed.
  // Checking resolution as well as the return value catches runtime guards
  // that still drag node:crypto into a mobile/browser graph.
  const clientRunner = new URL('../dist/esm/.verify-workload-identity.mjs', import.meta.url);
  await writeFile(clientRunner, [
    "import assert from 'node:assert/strict';",
    "const [expected] = process.argv.slice(2);",
    "assert.match(import.meta.resolve('#workload-identity'), new RegExp(`/dist/esm/server/${expected}$`));",
    "if (expected === 'workloadIdentity.client.js') {",
    "  const { canAttestWorkloadIdentity, requestWorkloadServiceToken } = await import('#workload-identity');",
    "  assert.equal(canAttestWorkloadIdentity(), false);",
    "  await assert.rejects(requestWorkloadServiceToken({ baseUrl: 'https://example.test' }), /only available on a Node host/);",
    "}",
  ].join('\n'));
  try {
    const cases = [
      [['--conditions=react-native'], 'workloadIdentity.client.js'],
      [['--conditions=browser'], 'workloadIdentity.client.js'],
      [[], 'workloadIdentity.js'],
    ];
    for (const [flags, expected] of cases) {
      const probe = spawnSync(process.execPath, [...flags, fileURLToPath(clientRunner), expected], { encoding: 'utf8' });
      assert.equal(probe.status, 0, probe.stderr || probe.stdout);
    }
  } finally {
    await rm(clientRunner, { force: true });
  }
  // The CommonJS half resolves the same specifier against dist/cjs's scope.
  const requireRunner = new URL('../dist/cjs/.verify-workload-identity.cjs', import.meta.url);
  await writeFile(requireRunner, [
    "const assert = require('node:assert/strict');",
    "assert.match(require.resolve('#workload-identity'), /[\\/]dist[\\/]cjs[\\/]server[\\/]workloadIdentity\\.js$/);",
  ].join('\n'));
  try {
    const probe = spawnSync(process.execPath, [fileURLToPath(requireRunner)], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  } finally {
    await rm(requireRunner, { force: true });
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
