import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { integrity } from './release-external-identity-packages.mjs';
import { RELEASES, validateFirstPartyDependencies } from './release-decisions-packages.mjs';

const script = resolve('.github/scripts/release-decisions-packages.mjs');
const sha = 'a'.repeat(40);

test('release scope is the dependency-ordered decisions pair at unpublished versions', () => {
  assert.deepEqual(RELEASES.map(({ name, version }) => `${name}@${version}`), ['@oxy.so/contracts@4.7.0', '@oxy.so/core@4.1.0']);
});
test('source manifests carry exactly the fixed release versions', () => {
  for (const release of RELEASES) {
    const manifest = JSON.parse(readFileSync(resolve('packages', release.directory, 'package.json'), 'utf8'));
    assert.equal(`${manifest.name}@${manifest.version}`, `${release.name}@${release.version}`);
  }
  const core = JSON.parse(readFileSync(resolve('packages/core/package.json'), 'utf8'));
  // `workspace:^` is what bun pm pack rewrites to ^4.7.0; validated again on the artifact.
  assert.equal(core.dependencies['@oxy.so/contracts'], 'workspace:^');
});
test('core must pin exactly the paired contracts and only published first-party floors', () => {
  const published = (name, floor) => `${name}@${floor}` !== '@oxy.so/protocol@9.9.9';
  const core = { name: '@oxy.so/core', dependencies: { '@oxy.so/contracts': '^4.7.0', '@oxy.so/protocol': '^1.2.1', zod: '^3.25.64' } };
  assert.deepEqual(validateFirstPartyDependencies(core, published), ['@oxy.so/protocol@1.2.1']);
  for (const contracts of ['^4.6.0', '4.7.0', '>=4.7.0', 'workspace:^']) {
    assert.throws(() => validateFirstPartyDependencies({ ...core, dependencies: { ...core.dependencies, '@oxy.so/contracts': contracts } }, published), /must depend/);
  }
  assert.throws(() => validateFirstPartyDependencies({ name: '@oxy.so/core', dependencies: { zod: '^3.25.64' } }, published), /must depend/);
  assert.throws(() => validateFirstPartyDependencies({ ...core, dependencies: { ...core.dependencies, '@oxy.so/protocol': '^9.9.9' } }, published), /not published/);
  assert.throws(() => validateFirstPartyDependencies({ ...core, dependencies: { ...core.dependencies, '@oxy.so/protocol': '*' } }, published), /caret range/);
  assert.deepEqual(validateFirstPartyDependencies({ name: '@oxy.so/contracts', dependencies: { zod: '^3.25.64' } }, published), []);
});

function fixture({ smoked = 8 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'decisions-publication-'));
  const bin = join(root, 'bin');
  const artifacts = join(root, 'release-artifacts');
  mkdirSync(bin); mkdirSync(artifacts);
  const packages = RELEASES.map(release => {
    const source = join(root, release.directory);
    for (const dir of ['dist/cjs', 'dist/esm', 'dist/types']) mkdirSync(join(source, 'package', dir), { recursive: true });
    const manifest = { name: release.name, version: release.version, main: 'dist/cjs/index.js', module: 'dist/esm/index.js', types: 'dist/types/index.d.ts' };
    writeFileSync(join(source, 'package/package.json'), JSON.stringify(manifest));
    for (const file of [manifest.main, manifest.module, manifest.types]) writeFileSync(join(source, 'package', file), 'fixture');
    const file = `oxy.so-${release.directory}-${release.version}.tgz`;
    execFileSync('tar', ['-czf', join(artifacts, file), '-C', source, 'package']);
    return { name: release.name, version: release.version, file, integrity: integrity(readFileSync(join(artifacts, file))) };
  });
  writeFileSync(join(artifacts, 'prepared.json'), JSON.stringify({ sourceSha: sha, packages, smoked: Array.from({ length: smoked }, (_, i) => `run-${i}`) }));
  writeFileSync(join(root, 'registry.json'), '{}');
  writeFileSync(join(root, 'calls.jsonl'), '');
  const tool = join(bin, 'tool.mjs');
  writeFileSync(tool, `#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename } from 'node:path';
const tool=basename(process.argv[1]); const args=process.argv.slice(2);
appendFileSync('calls.jsonl',JSON.stringify({tool,args})+'\\n');
if(tool==='git') { if(args[0]==='rev-parse') console.log(process.env.EXPECTED_SOURCE_SHA); if(args[0]==='ls-remote') console.log(process.env.EXPECTED_SOURCE_SHA+'\\trefs/heads/main'); }
if(tool==='npm' && args[0]==='whoami') console.log('fixture-publisher');
if(tool==='npm' && args[0]==='publish') {
 const prepared=JSON.parse(readFileSync('release-artifacts/prepared.json')); const registry=JSON.parse(readFileSync('registry.json'));
 const entry=prepared.packages.find(p=>args[1].endsWith(p.file)); if(!entry) process.exit(1);
 registry[entry.name]=entry.integrity; writeFileSync('registry.json',JSON.stringify(registry));
}
`);
  chmodSync(tool, 0o755);
  symlinkSync(tool, join(bin, 'git')); symlinkSync(tool, join(bin, 'npm'));
  const preload = join(root, 'registry.mjs');
  writeFileSync(preload, `import {readFileSync} from 'node:fs'; globalThis.fetch=async(url)=>{const name=decodeURIComponent(new URL(url).pathname.split('/')[1]); const value=JSON.parse(readFileSync('registry.json'))[name]; return new Response(JSON.stringify({dist:{integrity:value}}),{status:value?200:404});};`);
  const run = (dryRun, extra = {}) => spawnSync(process.execPath, ['--import', preload, script, 'publish'], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true', EXPECTED_SOURCE_SHA: sha, DRY_RUN: String(dryRun), NODE_AUTH_TOKEN: 'non-secret-test-fixture', ...extra }, encoding: 'utf8' });
  const publishes = () => readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(call => call.tool === 'npm' && call.args[0] === 'publish');
  return { root, packages, run, publishes };
}
const cleanup = f => rmSync(f.root, { recursive: true, force: true });

test('dry run never publishes; apply publishes contracts before core and a retry is idempotent', () => {
  const f = fixture();
  try {
    let result = f.run(true); assert.equal(result.status, 0, result.stderr); assert.equal(f.publishes().length, 0);
    result = f.run(false); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.publishes().map(call => call.args[1].split('/').pop()), ['oxy.so-contracts-4.7.0.tgz', 'oxy.so-core-4.1.0.tgz']);
    result = f.run(false); assert.equal(result.status, 0, result.stderr); assert.equal(f.publishes().length, 2);
  } finally { cleanup(f); }
});
test('a different published core blocks contracts too, during preflight', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'registry.json'), JSON.stringify({ '@oxy.so/core': 'sha512-conflicting' }));
    const result = f.run(false); assert.equal(result.status, 1); assert.match(result.stderr, /refusing overwrite/); assert.equal(f.publishes().length, 0);
  } finally { cleanup(f); }
});
test('artifacts that were not smoke-installed are never published', () => {
  const f = fixture({ smoked: 0 });
  try {
    const result = f.run(false); assert.equal(result.status, 1); assert.match(result.stderr, /smoke/); assert.equal(f.publishes().length, 0);
  } finally { cleanup(f); }
});
test('a branch or unprotected ref, a stale SHA or a missing token publishes nothing', () => {
  for (const extra of [{ GITHUB_REF: 'refs/heads/feat/jev-decisions-20261001' }, { GITHUB_REF_PROTECTED: 'false' }, { EXPECTED_SOURCE_SHA: 'b'.repeat(40), DRY_RUN: 'false' }, { NODE_AUTH_TOKEN: '' }]) {
    const f = fixture();
    try {
      if (extra.EXPECTED_SOURCE_SHA) {
        // The fake git answers HEAD with the expected SHA; make the remote disagree.
        writeFileSync(join(f.root, 'bin', 'tool.mjs'), readFileSync(join(f.root, 'bin', 'tool.mjs'), 'utf8').replace("args[0]==='ls-remote') console.log(process.env.EXPECTED_SOURCE_SHA", "args[0]==='ls-remote') console.log('c'.repeat(40)"));
      }
      const result = f.run(false, extra); assert.equal(result.status, 1, JSON.stringify(extra)); assert.equal(f.publishes().length, 0);
    } finally { cleanup(f); }
  }
});
