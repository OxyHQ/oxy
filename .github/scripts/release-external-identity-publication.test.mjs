import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RELEASES, integrity } from './release-external-identity-packages.mjs';

const script = resolve('.github/scripts/release-external-identity-packages.mjs');
const sha = 'a'.repeat(40);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'identity-publication-'));
  const bin = join(root, 'bin');
  const artifacts = join(root, 'release-artifacts');
  mkdirSync(bin); mkdirSync(artifacts);
  const packages = RELEASES.map(release => {
    const source = join(root, release.directory);
    for (const target of ['dist/cjs', 'dist/esm', 'dist/types']) mkdirSync(join(source, 'package', target), { recursive: true });
    const manifest = { name: release.name, version: release.version, main: 'dist/cjs/index.js', module: 'dist/esm/index.js', types: 'dist/types/index.d.ts' };
    writeFileSync(join(source, 'package/package.json'), JSON.stringify(manifest));
    for (const target of [manifest.main, manifest.module, manifest.types]) writeFileSync(join(source, 'package', target), 'fixture');
    const file = `oxy.so-${release.directory}-${release.version}.tgz`;
    execFileSync('tar', ['-czf', join(artifacts, file), '-C', source, 'package']);
    return { name: release.name, version: release.version, file, integrity: integrity(readFileSync(join(artifacts, file))) };
  });
  writeFileSync(join(artifacts, 'prepared.json'), JSON.stringify({ sourceSha: sha, packages }));
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
  const run = dryRun => spawnSync(process.execPath, ['--import', preload, script, 'publish'], { cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true', EXPECTED_SOURCE_SHA: sha, DRY_RUN: String(dryRun), NODE_AUTH_TOKEN: 'non-secret-test-fixture' }, encoding: 'utf8' });
  const publishes = () => readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(call => call.tool === 'npm' && call.args[0] === 'publish');
  return { root, packages, run, publishes };
}

test('dry-run does not publish; apply publishes exact pair in order and retry is idempotent', () => {
  const f = fixture();
  try {
    let result=f.run(true); assert.equal(result.status,0,result.stderr); assert.equal(f.publishes().length,0);
    result=f.run(false); assert.equal(result.status,0,result.stderr);
    assert.deepEqual(f.publishes().map(call => call.args[1].split('/').pop()), f.packages.map(p=>p.file));
    result=f.run(false); assert.equal(result.status,0,result.stderr); assert.equal(f.publishes().length,2);
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});
test('a conflicting second version blocks both publications during preflight', () => {
  const f=fixture();
  try {
    writeFileSync(join(f.root,'registry.json'),JSON.stringify({[f.packages[1].name]:'sha512-conflicting'}));
    const result=f.run(false); assert.equal(result.status,1); assert.match(result.stderr,/refusing overwrite/); assert.equal(f.publishes().length,0);
  } finally { rmSync(f.root,{recursive:true,force:true}); }
});
