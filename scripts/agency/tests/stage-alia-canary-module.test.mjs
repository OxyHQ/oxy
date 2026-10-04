import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync,
  lstatSync, chmodSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { stageAliaCanaryModule, CANARY_MODULE_FILENAME, CANARY_MODULE_SHA256 } from '../stage-alia-canary-module.mjs';
const source = readFileSync(new URL('../artifacts/alia-revocation-canary.cjs', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'i03-stage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'dist/services'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{}');
  const original = join(root, 'dist/services/aliaRevocationCanary.service.js');
  writeFileSync(original, 'original-image-module');
  return { root, apiPackage: join(root, 'package.json'), original,
    target: join(root, 'dist/services', CANARY_MODULE_FILENAME) };
}
test('stages only the compiled hash, preserves original, cleans own file idempotently', t => {
  const f = fixture(t); const staged = stageAliaCanaryModule({ apiPackage: f.apiPackage, source });
  assert.equal(staged.canaryModulePath, f.target);
  assert.equal(createHash('sha256').update(readFileSync(f.target)).digest('hex'), CANARY_MODULE_SHA256);
  assert.equal(lstatSync(f.target).mode & 0o777, 0o400);
  assert.equal(readFileSync(f.original, 'utf8'), 'original-image-module');
  staged.cleanup(); staged.cleanup(); assert.equal(existsSync(f.target), false);
  assert.equal(readFileSync(f.original, 'utf8'), 'original-image-module');
});
test('modified bytes and non-Buffer input never create a file', t => {
  const f = fixture(t);
  for (const invalid of [Buffer.concat([source, Buffer.from('x')]), source.toString()]) {
    assert.throws(() => stageAliaCanaryModule({ apiPackage: f.apiPackage, source: invalid }));
    assert.equal(existsSync(f.target), false);
  }
});
test('existing regular file or symlink is refused without replacing its bytes', t => {
  const f = fixture(t); writeFileSync(f.target, 'previous');
  assert.throws(() => stageAliaCanaryModule({ apiPackage: f.apiPackage, source }));
  assert.equal(readFileSync(f.target, 'utf8'), 'previous'); unlinkSync(f.target);
  symlinkSync(f.original, f.target);
  assert.throws(() => stageAliaCanaryModule({ apiPackage: f.apiPackage, source }));
  assert.equal(lstatSync(f.target).isSymbolicLink(), true);
  assert.equal(readFileSync(f.original, 'utf8'), 'original-image-module');
});
test('symlinked service directory is refused before any write', t => {
  const f = fixture(t); rmSync(join(f.root, 'dist/services'), { recursive: true });
  mkdirSync(join(f.root, 'other')); symlinkSync(join(f.root, 'other'), join(f.root, 'dist/services'));
  assert.throws(() => stageAliaCanaryModule({ apiPackage: f.apiPackage, source }));
  assert.equal(existsSync(f.target), false);
});
test('cleanup refuses changed bytes, permissions, or replacement inode', t => {
  const f = fixture(t); const staged = stageAliaCanaryModule({ apiPackage: f.apiPackage, source });
  chmodSync(f.target, 0o600); assert.throws(() => staged.cleanup());
  writeFileSync(f.target, 'changed'); chmodSync(f.target, 0o400); assert.throws(() => staged.cleanup());
  assert.equal(readFileSync(f.target, 'utf8'), 'changed');
  unlinkSync(f.target); writeFileSync(f.target, source, { mode: 0o400 });
  assert.throws(() => staged.cleanup()); assert.equal(existsSync(f.target), true);
});
test('real compiled canonical module resolves unchanged sibling dependencies', t => {
  const apiPackage = resolve('packages/api/package.json');
  const original = readFileSync(resolve('packages/api/dist/services/aliaRevocationCanary.service.js'));
  const staged = stageAliaCanaryModule({ apiPackage, source }); t.after(() => staged.cleanup());
  const require = createRequire(apiPackage); const module = require(staged.canaryModulePath);
  assert.equal(module.I03_CANARY_OWNER_ID, '01a0369b-1222-712f-8df6-f8ffeb78ccc2');
  for (const name of ['prepareAliaRevocationCanary', 'issueAliaRevocationCanary', 'revokeAliaRevocationCanary',
    'inspectAliaRevocationCanary', 'verifyAliaCanaryAuthorityUnchanged', 'retireAliaCanaryAfterTaskFailure']) assert.equal(typeof module[name], 'function');
  assert.deepEqual(readFileSync(resolve('packages/api/dist/services/aliaRevocationCanary.service.js')), original);
});
