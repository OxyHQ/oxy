import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  installedZodCopies,
  probePackage,
  verifyInstallation,
  verifyPackage,
} from './check-zod-forks.mjs';

const temporary = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'zod-security-inventory-'));
  temporary.push(root);
  return root;
}
function pkg(path, name = 'zod', version = '3.25.76', extra = {}) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version, ...extra }));
  return path;
}
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('inventory finds a stock parser hidden under a differently named nested dependency', () => {
  const root = fixture();
  pkg(join(root, 'node_modules', 'consumer'), 'consumer', '1.0.0');
  const hidden = pkg(join(root, 'node_modules', 'consumer', 'node_modules', 'alias'));
  assert.deepEqual(installedZodCopies([join(root, 'node_modules')]), [hidden]);
});

test('renaming package metadata cannot hide the zod resolution target', () => {
  const root = fixture();
  const renamed = pkg(join(root, 'node_modules', 'zod'), '@vendor/renamed', '1.0.0');
  assert.deepEqual(installedZodCopies([join(root, 'node_modules')]), [renamed]);
  assert.throws(() => verifyPackage(renamed), /Unreviewed Zod distribution/);
});

test('inventory includes every physical Bun and pnpm copy while deduplicating symlink aliases', () => {
  const root = fixture();
  const modules = join(root, 'node_modules');
  const bun = pkg(
    join(modules, '.bun', '@oxy.so+zod3@3.25.77', 'node_modules', '@oxy.so', 'zod3'),
    '@oxy.so/zod3',
    '3.25.77',
  );
  const pnpm = pkg(join(modules, '.pnpm', 'zod@4.6.7', 'node_modules', 'zod'), 'zod', '4.6.7');
  symlinkSync(bun, join(modules, 'zod'));
  assert.deepEqual(installedZodCopies([modules, modules]), [bun, pnpm].sort());
});

test('inventory follows workspace links and handles dependency cycles', () => {
  const root = fixture();
  const workspace = pkg(join(root, 'packages', 'consumer'), 'consumer', '1.0.0');
  const hidden = pkg(join(workspace, 'node_modules', '@oxy.so', 'zod4'), '@oxy.so/zod4', '4.6.8');
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(workspace, join(root, 'node_modules', 'consumer'));
  symlinkSync(workspace, join(workspace, 'node_modules', 'cycle'));
  assert.deepEqual(installedZodCopies([join(root, 'node_modules')]), [hidden]);
});

test('an empty installed inventory cannot produce a successful verdict', () => {
  assert.throws(() => verifyInstallation(fixture()), /No installed Zod inventory/);
});

test('inventory checks staged workspaces even when no consumer creates a dependency link', () => {
  const root = fixture();
  const standalone = pkg(join(root, 'packages', 'zod4'), '@oxy.so/zod4', '4.6.8');
  const hidden = pkg(join(standalone, 'node_modules', 'zod'));
  assert.deepEqual(
    installedZodCopies([join(root, 'node_modules')], [standalone]),
    [standalone, hidden].sort(),
  );
});

test('manifest-only unused workspaces are not installed parsers, but linked targets remain checked', () => {
  const root = fixture();
  const unused = pkg(join(root, 'packages', 'zod3'), '@oxy.so/zod3', '3.25.77');
  assert.deepEqual(installedZodCopies([], [unused]), []);
  mkdirSync(join(root, 'node_modules'));
  symlinkSync(unused, join(root, 'node_modules', 'zod'));
  assert.deepEqual(installedZodCopies([join(root, 'node_modules')], [unused]), [unused]);
  assert.throws(() => verifyPackage(unused), /ENOENT/);
});

test('unlinked source or build artifacts cannot escape the workspace census', () => {
  const root = fixture();
  const unlinked = pkg(join(root, 'packages', 'zod3'), 'zod', '3.25.76');
  writeFileSync(join(unlinked, 'index.cjs'), 'module.exports = {}');
  assert.deepEqual(installedZodCopies([], [unlinked]), [unlinked]);
  assert.throws(() => verifyInstallation(root, ['@oxy.so/zod3']), /Missing installed fork/);
});

test('stock Zod4 is rejected despite its package-level patched version', () => {
  const stock = pkg(fixture(), 'zod', '4.6.7');
  assert.throws(() => verifyPackage(stock), /Unreviewed Zod distribution/);
});

test('a changed maintained version needs deliberate verification updates', () => {
  const changed = pkg(fixture(), '@oxy.so/zod3', '3.25.78');
  assert.throws(() => verifyPackage(changed), /Unreviewed Zod distribution/);
});

test('an advertised export cannot point outside the package under review', async () => {
  const root = fixture();
  writeFileSync(join(root, 'outside.cjs'), 'throw new Error("must never run")');
  const candidate = pkg(join(root, 'candidate'), '@oxy.so/zod3', '3.25.77', {
    exports: { '.': { require: '../outside.cjs' } },
  });
  await assert.rejects(probePackage(candidate, 'require'), /Export escaped package/);
});
