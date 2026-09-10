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
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
