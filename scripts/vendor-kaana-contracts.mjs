#!/usr/bin/env node
/**
 * Vendor `@kaana.ai/contracts` from an exact Kaana commit, or check the copy.
 *
 * Kaana ADR 0002 moves the inference contract to Kaana as `@kaana.ai/contracts`
 * (`packages/contracts` in OxyHQ/Kaana). Until it is on npm, Oxy builds the
 * grant and settlement API (phase 2) against a copy of its SOURCE, pinned to
 * one commit and checked byte for byte, so no shape here can drift from the
 * one Kaana parses. When the package is published, the workspace dependency
 * becomes the npm version and `vendor/kaana-contracts` is deleted.
 *
 *   node scripts/vendor-kaana-contracts.mjs --from <kaana checkout> --ref <commit>
 *   node scripts/vendor-kaana-contracts.mjs --check
 *
 * What is copied: the package's `src/` without its tests, its tsconfigs,
 * LICENSE, NOTICE and `openapi.json`. One transform, recorded in
 * `provenance.json`: the package's `test` and `typecheck` scripts are removed,
 * because they run `bun test` and Bun's types, which this monorepo's
 * workspace runners would otherwise invoke on a copy that carries no tests.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = join(ROOT, 'vendor', 'kaana-contracts');
const PROVENANCE = join(TARGET, 'provenance.json');
const PACKAGE_DIR = 'packages/contracts';
const REMOVED_SCRIPTS = ['test', 'typecheck'];

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function vendoredFiles(dir = TARGET) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === 'node_modules' || entry === 'dist') continue;
    if (statSync(path).isDirectory()) files.push(...vendoredFiles(path));
    else if (path !== PROVENANCE) files.push(relative(TARGET, path).split('\\').join('/'));
  }
  return files.sort();
}

function check() {
  const provenance = JSON.parse(readFileSync(PROVENANCE, 'utf8'));
  const expected = Object.keys(provenance.files).sort();
  const actual = vendoredFiles();
  const problems = [];
  for (const file of actual) {
    if (!(file in provenance.files)) problems.push(`not in provenance: ${file}`);
  }
  for (const file of expected) {
    if (!actual.includes(file)) {
      problems.push(`missing: ${file}`);
      continue;
    }
    const digest = sha256(readFileSync(join(TARGET, file)));
    if (digest !== provenance.files[file]) problems.push(`edited: ${file}`);
  }
  if (problems.length > 0) {
    console.error(
      `vendor/kaana-contracts does not match Kaana ${provenance.commit}:\n  ${problems.join('\n  ')}`,
    );
    console.error('Re-vendor with scripts/vendor-kaana-contracts.mjs; never edit the copy.');
    process.exit(1);
  }
  console.log(`vendor/kaana-contracts matches Kaana ${provenance.commit} (${actual.length} files)`);
}

function vendor(from, ref) {
  const git = (...args) => execFileSync('git', ['-C', from, ...args], { encoding: 'buffer' });
  const commit = git('rev-parse', `${ref}^{commit}`).toString('utf8').trim();
  const listed = git('ls-tree', '-r', '--name-only', commit, PACKAGE_DIR)
    .toString('utf8')
    .split('\n')
    .filter((path) => path.length > 0 && !path.includes('/__tests__/'));

  rmSync(TARGET, { recursive: true, force: true });
  const files = {};
  for (const path of listed) {
    const relativePath = path.slice(PACKAGE_DIR.length + 1);
    let bytes = git('show', `${commit}:${path}`);
    if (relativePath === 'package.json') {
      const manifest = JSON.parse(bytes.toString('utf8'));
      for (const script of REMOVED_SCRIPTS) delete manifest.scripts[script];
      bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    }
    const destination = join(TARGET, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
    files[relativePath] = sha256(bytes);
  }
  const manifest = JSON.parse(readFileSync(join(TARGET, 'package.json'), 'utf8'));
  const provenance = {
    package: manifest.name,
    version: manifest.version,
    repository: 'https://github.com/OxyHQ/Kaana',
    directory: PACKAGE_DIR,
    commit,
    transforms: [`package.json: scripts ${REMOVED_SCRIPTS.join(', ')} removed`],
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  writeFileSync(PROVENANCE, `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`vendored ${manifest.name}@${manifest.version} from Kaana ${commit}`);
}

const args = process.argv.slice(2);
if (args.includes('--check')) {
  check();
} else {
  const from = args[args.indexOf('--from') + 1];
  const ref = args[args.indexOf('--ref') + 1];
  if (!args.includes('--from') || !args.includes('--ref') || !from || !ref) {
    console.error('usage: vendor-kaana-contracts.mjs --from <kaana checkout> --ref <commit> | --check');
    process.exit(2);
  }
  vendor(from, ref);
}
