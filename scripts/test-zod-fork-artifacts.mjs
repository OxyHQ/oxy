/** Real built artifacts, stock controls and surgical removal of each shipped fix. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { runProbe, UPSTREAM, verifyPackage } from './check-zod-forks.mjs';

// Review a separate implementation tree with: node this-file.mjs --root /tree.
// Canonical node --test execution uses this checkout, without environment overrides.
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--root'));
const root = args.length
  ? resolve(args[1])
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'zod-fork-artifacts-'));
after(() => rmSync(temporary, { recursive: true, force: true }));

for (const [folder, version] of [
  ['zod3', '3.25.76'],
  ['zod4', '4.6.7'],
]) {
  const candidate = join(root, 'packages', folder);
  const stock = join(temporary, folder, 'package');
  test(`${folder}: immutable upstream source archive matches recorded registry integrity`, () => {
    const provenance = JSON.parse(
      readFileSync(join(candidate, 'upstream/provenance.json'), 'utf8'),
    );
    assert.equal(provenance.name, 'zod');
    assert.equal(provenance.version, version);
    assert.equal(provenance.advisory, 'GHSA-mrhx-c7xc-m3w5');
    const archive = join(candidate, 'upstream', `zod-${version}.tgz`);
    const integrity = `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`;
    assert.equal(integrity, provenance.integrity);
    assert.equal(integrity, UPSTREAM[`@oxy.so/${folder}`].integrity);
    mkdirSync(dirname(stock), { recursive: true });
    execFileSync('tar', ['-xzf', archive, '-C', dirname(stock)]);
  });

  test(`${folder}: untouched upstream fails the same source and runtime controls`, () => {
    for (const mode of ['require', 'import', 'source']) {
      const report = runProbe(stock, mode);
      assert.ok(report.failures.length > 0, `${folder}/${mode}: negative control did not fail`);
      assert.ok(
        report.failures.some((result) => result.subpath === './v3' && result.visits > 0),
        `${folder}/${mode}: stock embedded v3 did not reproduce traversal`,
      );
      if (folder === 'zod3') {
        assert.ok(
          report.failures.some((result) => result.subpath === './v4/core' && result.visits > 0),
          `${folder}/${mode}: stock embedded v4 did not reproduce traversal`,
        );
      }
    }
  });

  test(`${folder}: maintained package passes every advertised source and runtime parser`, () => {
    assert.ok(verifyPackage(candidate).every((result) => result.failures.length === 0));
  });

  const files = ['src/v3/types.ts', 'v3/types.cjs', 'v3/types.js'];
  if (folder === 'zod3')
    files.push('src/v4/core/schemas.ts', 'v4/core/schemas.cjs', 'v4/core/schemas.js');
  for (const [index, file] of files.entries()) {
    test(`${folder}: restoring upstream ${file} is detected`, () => {
      const mutated = join(temporary, `${folder}-mutation-${index}`);
      cpSync(candidate, mutated, {
        recursive: true,
        filter: (path) =>
          !path
            .split('/')
            .some((segment) => segment === 'node_modules' || segment.startsWith('.build-')),
      });
      copyFileSync(join(stock, file), join(mutated, file));
      const mode = file.endsWith('.ts') ? 'source' : file.endsWith('.cjs') ? 'require' : 'import';
      const report = runProbe(mutated, mode);
      assert.ok(
        report.failures.some((result) => result.visits > 0),
        `Restoring ${file} must fail on real traversal, not a loader error`,
      );
    });
  }
}
