import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { integrity } from './release-external-identity-packages.mjs';
import {
  CONSUMER_FLOORS,
  EXPECTED_SMOKE_CASES,
  RELEASES,
  SMOKE_MINIMUM_RELEASE_AGE_SECONDS,
  assertSameArtifacts,
  consumerEnv,
  firstPartyFloor,
  validateFirstPartyDependencies,
} from './release-decisions-packages.mjs';

const script = resolve('.github/scripts/release-decisions-packages.mjs');
const workflow = readFileSync(resolve('.github/workflows/release-decisions-packages.yml'), 'utf8');
const sha = 'a'.repeat(40);

test('release scope is contracts only; published SDK floors cannot be republished', () => {
  assert.deepEqual(RELEASES.map(({ name, version }) => `${name}@${version}`), ['@oxy.so/contracts@4.8.0']);
  assert.deepEqual(CONSUMER_FLOORS, [{ name: '@oxy.so/core', version: '4.1.0' }, { name: '@oxy.so/protocol', version: '1.2.1' }]);
  assert.deepEqual(EXPECTED_SMOKE_CASES, [
    'npm/node/smoke.mjs', 'npm/node/smoke.cjs', 'npm/bun/smoke.mjs', 'npm/bun/smoke.cjs',
    'bun/node/smoke.mjs', 'bun/node/smoke.cjs', 'bun/bun/smoke.mjs', 'bun/bun/smoke.cjs',
  ]);
  assert.ok(SMOKE_MINIMUM_RELEASE_AGE_SECONDS >= 24 * 60 * 60);
});
test('both actual consumer entry points strictly require the contracts release version', () => {
  for (const entry of ['smoke.mjs', 'smoke.cjs']) {
    const source = readFileSync(resolve('.github/scripts/decisions-release-smoke', entry), 'utf8');
    const expected = /fromCore\('@oxy\.so\/contracts\/package\.json'\)\.version !== '([^']+)'/.exec(source)?.[1];
    assert.equal(expected, RELEASES[0].version, entry);
    assert.match(source, /throw new Error\('core resolves another contracts version'\)/);
  }
});
test('source manifests carry exactly the fixed release versions', () => {
  for (const release of RELEASES) {
    const manifest = JSON.parse(readFileSync(resolve('packages', release.directory, 'package.json'), 'utf8'));
    assert.equal(`${manifest.name}@${manifest.version}`, `${release.name}@${release.version}`);
  }
  const core = JSON.parse(readFileSync(resolve('packages/core/package.json'), 'utf8'));
  // `workspace:^` is what bun pm pack rewrites to ^4.8.0; validated again on the artifact.
  assert.equal(core.dependencies['@oxy.so/contracts'], 'workspace:^');
});
test('any future paired artifact must pin released contracts and published first-party floors', () => {
  const published = (name, floor) => `${name}@${floor}` !== '@oxy.so/protocol@9.9.9';
  const core = { name: '@oxy.so/core', dependencies: { '@oxy.so/contracts': '^4.8.0', '@oxy.so/protocol': '^1.2.1', zod: '^3.25.64' } };
  assert.deepEqual(validateFirstPartyDependencies(core, published), ['@oxy.so/protocol@1.2.1']);
  for (const contracts of ['^4.6.0', '4.8.0', '>=4.8.0', 'workspace:^']) {
    assert.throws(() => validateFirstPartyDependencies({ ...core, dependencies: { ...core.dependencies, '@oxy.so/contracts': contracts } }, published), /must depend/);
  }
  assert.throws(() => validateFirstPartyDependencies({ name: '@oxy.so/core', dependencies: { zod: '^3.25.64' } }, published), /must depend/);
  assert.throws(() => validateFirstPartyDependencies({ ...core, dependencies: { ...core.dependencies, '@oxy.so/protocol': '^9.9.9' } }, published), /not published/);
  assert.throws(() => validateFirstPartyDependencies({ ...core, dependencies: { ...core.dependencies, '@oxy.so/protocol': '*' } }, published), /caret range/);
  assert.throws(() => validateFirstPartyDependencies({ ...core, peerDependencies: { '@oxy.so/services': '*' } }, published), /peerDependencies/);
  assert.deepEqual(validateFirstPartyDependencies({ name: '@oxy.so/contracts', dependencies: { zod: '^3.25.64' } }, published), []);
});
test('a consumer sees no runner file commands, tokens, NODE_OPTIONS or npm auth', () => {
  const hostile = {
    PATH: '/usr/bin', GITHUB_ENV: '/runner/env', GITHUB_OUTPUT: '/runner/out', GITHUB_PATH: '/runner/path', GITHUB_STEP_SUMMARY: '/s',
    GITHUB_TOKEN: 'x', ACTIONS_RUNTIME_TOKEN: 'x', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'x', NODE_AUTH_TOKEN: 'x', NPM_TOKEN: 'x',
    NODE_OPTIONS: '--require /evil.js', npm_config__auth: 'x', RUNNER_TEMP: '/runner/temp', HOME: '/home/runner',
  };
  const env = consumerEnv(hostile, '/sandbox');
  assert.deepEqual(Object.keys(env).sort(), ['BUN_INSTALL_CACHE_DIR', 'CI', 'HOME', 'LANG', 'PATH', 'TMPDIR', 'npm_config_cache', 'npm_config_userconfig']);
  assert.equal(env.PATH, '/usr/bin');
  for (const value of Object.values(env).slice(1)) assert.ok(!value.startsWith('/runner') && !value.startsWith('/home/runner'), value);
});
test('rebuilt artifacts must equal the trusted build byte for byte and commit for commit', () => {
  const prepared = { sourceSha: sha, packages: [{ name: 'a', version: '1.0.0', file: 'a.tgz', integrity: 'sha512-a' }] };
  assertSameArtifacts(prepared, structuredClone(prepared));
  assert.throws(() => assertSameArtifacts(prepared, { ...prepared, sourceSha: 'b'.repeat(40) }), /another commit/);
  assert.throws(() => assertSameArtifacts(prepared, { ...prepared, packages: [{ ...prepared.packages[0], integrity: 'sha512-b' }] }), /differ/);
  assert.throws(() => assertSameArtifacts(prepared, { ...prepared, packages: [] }), /differ/);
});
test('workflow: only the apply step holds NPM_TOKEN, dry run never does, permissions stay read-only', () => {
  assert.equal(workflow.match(/secrets\./g)?.length, 1);
  const jobs = workflow.split(/\n  (?=build:|smoke:|publish:)/);
  const job = (name) => jobs.find((text) => text.startsWith(`${name}:`));
  assert.ok(!job('build').includes('secrets.') && !job('smoke').includes('secrets.'));
  assert.match(job('publish'), /- name: Publish only missing exact versions\n {8}if: \$\{\{ inputs\.dry_run == false \}\}\n {8}env:\n {10}NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}\n {8}run: node \.github\/scripts\/release-decisions-packages\.mjs publish\n/);
  assert.match(workflow, /\npermissions:\n {2}contents: read\n\n/);
  assert.equal(workflow.match(/permissions:/g).length, 1);
  assert.doesNotMatch(workflow, /: write|id-token/);
  assert.equal(workflow.match(/actions\/checkout@/g).length, workflow.match(/persist-credentials: false/g).length);
  assert.match(job('smoke'), /needs: build\n/);
  assert.match(job('publish'), /needs: \[build, smoke\]\n/);
  // The smoke runs in its own job and the publish job never reads its output.
  assert.ok(!job('build').includes('mjs smoke') && !job('publish').includes('mjs smoke') && !job('publish').includes('decisions-release-smoke-'));
  assert.match(job('build'), /if: github\.ref == 'refs\/heads\/main' && github\.ref_protected\n/);
});

/** A repo-shaped temp dir with own and trusted artifacts, fake git/npm/bun/node. */
function fixture({ tamperTrusted = false, ownDiffers = false, floorContent } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'decisions-release-'));
  const bin = join(root, 'bin');
  const own = join(root, 'release-artifacts');
  const trusted = join(root, 'trusted-artifacts');
  for (const directory of [bin, own, trusted, join(root, 'runner-temp')]) mkdirSync(directory);
  const packages = RELEASES.map((release, index) => {
    const source = join(root, 'src', release.directory);
    for (const dir of ['dist/cjs', 'dist/esm', 'dist/types']) mkdirSync(join(source, 'package', dir), { recursive: true });
    const manifest = { name: release.name, version: release.version, main: 'dist/cjs/index.js', module: 'dist/esm/index.js', types: 'dist/types/index.d.ts' };
    writeFileSync(join(source, 'package/package.json'), JSON.stringify(manifest));
    for (const file of [manifest.main, manifest.module, manifest.types]) writeFileSync(join(source, 'package', file), 'fixture');
    const file = `oxy.so-${release.directory}-${release.version}.tgz`;
    execFileSync('tar', ['-czf', join(trusted, file), '-C', source, 'package']);
    if (ownDiffers && index === 0) {
      writeFileSync(join(source, 'package', manifest.main), 'rebuilt differently');
      execFileSync('tar', ['-czf', join(own, file), '-C', source, 'package']);
    } else copyFileSync(join(trusted, file), join(own, file));
    return { name: release.name, version: release.version, file, integrity: integrity(readFileSync(join(trusted, file))) };
  });
  const floorBytes = Buffer.from(floorContent ?? 'published floor bytes');
  const dependencyFloors = CONSUMER_FLOORS.map(({ name, version }) => ({ name, version, tarball: `https://registry.npmjs.org/${name}/-/${name.slice('@oxy.so/'.length)}-${version}.tgz`, integrity: integrity(Buffer.from('published floor bytes')) }));
  writeFileSync(join(root, 'floor.tgz'), floorBytes);
  const prepared = JSON.stringify({ sourceSha: sha, packages, dependencyFloors });
  writeFileSync(join(trusted, 'prepared.json'), prepared);
  const ownPackages = packages.map((entry) => ({ ...entry, integrity: integrity(readFileSync(join(own, entry.file))) }));
  writeFileSync(join(own, 'prepared.json'), JSON.stringify({ sourceSha: sha, packages: ownPackages, dependencyFloors }));
  if (tamperTrusted) writeFileSync(join(trusted, packages[0].file), 'replaced after the build');
  writeFileSync(join(root, 'registry.json'), '{}');
  writeFileSync(join(root, 'calls.jsonl'), '');
  const tool = join(bin, 'tool.mjs');
  writeFileSync(tool, `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename } from 'node:path';
const tool=basename(process.argv[1]); const args=process.argv.slice(2);
appendFileSync(${JSON.stringify(join(root, 'calls.jsonl'))},JSON.stringify({tool,args,cwd:process.cwd(),env:Object.keys(process.env)})+'\\n');
if(tool==='git') { if(args[0]==='rev-parse') console.log(process.env.EXPECTED_SOURCE_SHA); if(args[0]==='ls-remote') console.log((process.env.FAKE_REMOTE_MAIN||process.env.EXPECTED_SOURCE_SHA)+'\\trefs/heads/main'); }
if(tool==='npm' && args[0]==='whoami') console.log('fixture-publisher');
if(tool==='npm' && args[0]==='publish') {
 const prepared=JSON.parse(readFileSync('release-artifacts/prepared.json')); const registry=JSON.parse(readFileSync('registry.json'));
 const entry=prepared.packages.find(p=>args[1].endsWith(p.file)); if(!entry) process.exit(1);
 registry[entry.name]=entry.integrity; writeFileSync('registry.json',JSON.stringify(registry));
}
`);
  chmodSync(tool, 0o755);
  for (const name of ['git', 'npm', 'bun', 'node']) execFileSync('ln', ['-s', tool, join(bin, name)]);
  const preload = join(root, 'registry.mjs');
  writeFileSync(preload, `import {readFileSync} from 'node:fs'; globalThis.fetch=async(url)=>{if(String(url).endsWith('.tgz')) return new Response(readFileSync('floor.tgz'),{status:200}); const name=decodeURIComponent(new URL(url).pathname.split('/')[1]); const value=JSON.parse(readFileSync('registry.json'))[name]; return new Response(JSON.stringify({dist:{integrity:value}}),{status:value?200:404});};`);
  const run = (phase, dryRun, extra = {}) => spawnSync(process.execPath, ['--import', preload, script, phase], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_REF: 'refs/heads/main', GITHUB_REF_PROTECTED: 'true', EXPECTED_SOURCE_SHA: sha,
      DRY_RUN: String(dryRun), RUNNER_TEMP: join(root, 'runner-temp'), GITHUB_ENV: join(root, 'github-env'), NODE_OPTIONS: '', ...extra },
  });
  const calls = () => readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const publishes = () => calls().filter((call) => call.tool === 'npm' && call.args[0] === 'publish');
  return { root, packages, run, calls, publishes };
}
const cleanup = (f) => rmSync(f.root, { recursive: true, force: true });
const token = { NODE_AUTH_TOKEN: 'non-secret-test-fixture' };

test('verify needs no token, calls no npm, and reports the release anonymously', () => {
  const f = fixture();
  try {
    const result = f.run('verify', true, { NODE_AUTH_TOKEN: '' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.calls().filter((call) => call.tool === 'npm').length, 0);
    const report = JSON.parse(readFileSync(join(f.root, 'release-artifacts/release-report.json'), 'utf8'));
    assert.deepEqual(report.packages.map((entry) => entry.state), ['missing']);
  } finally { cleanup(f); }
});
test('publish refuses a dry run even when a token is present', () => {
  const f = fixture();
  try {
    const result = f.run('publish', true, token);
    assert.equal(result.status, 1); assert.match(result.stderr, /dry_run/); assert.equal(f.calls().length, 0);
  } finally { cleanup(f); }
});
test('apply publishes only its own contracts, never core, and a retry is idempotent', () => {
  const f = fixture();
  try {
    let result = f.run('publish', false, token); assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.publishes().map((call) => call.args[1].split('/').slice(-2).join('/')), ['release-artifacts/oxy.so-contracts-4.8.0.tgz']);
    result = f.run('publish', false, token); assert.equal(result.status, 0, result.stderr); assert.equal(f.publishes().length, 1);
  } finally { cleanup(f); }
});
test('a rebuild that differs from the trusted bytes publishes nothing and verifies nothing', () => {
  const f = fixture({ ownDiffers: true });
  try {
    for (const [phase, dry] of [['verify', true], ['publish', false]]) {
      const result = f.run(phase, dry, token); assert.equal(result.status, 1); assert.match(result.stderr, /differ/);
    }
    assert.equal(f.publishes().length, 0);
  } finally { cleanup(f); }
});
test('a different published contracts version blocks overwrite during preflight', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'registry.json'), JSON.stringify({ '@oxy.so/contracts': 'sha512-conflicting' }));
    const result = f.run('publish', false, token); assert.equal(result.status, 1); assert.match(result.stderr, /refusing overwrite/); assert.equal(f.publishes().length, 0);
  } finally { cleanup(f); }
});
test('a branch or unprotected ref, another SHA, an advanced main or a missing token publishes nothing', () => {
  for (const extra of [{ GITHUB_REF: 'refs/heads/feat/jev-decisions-20261001' }, { GITHUB_REF_PROTECTED: 'false' }, { EXPECTED_SOURCE_SHA: 'b'.repeat(40) }, { FAKE_REMOTE_MAIN: 'c'.repeat(40) }, { NODE_AUTH_TOKEN: '' }]) {
    const f = fixture();
    try {
      const result = f.run('publish', false, { ...token, ...extra }); assert.equal(result.status, 1, JSON.stringify(extra)); assert.equal(f.publishes().length, 0);
    } finally { cleanup(f); }
  }
});
test('smoke installs the trusted bytes outside the repo with a clean env, real minimum age and exact cases', () => {
  const f = fixture();
  try {
    const result = f.run('smoke', true, { NODE_OPTIONS: '--no-warnings', NODE_AUTH_TOKEN: 'must-not-leak', GITHUB_OUTPUT: join(f.root, 'out') });
    assert.equal(result.status, 0, result.stderr);
    const consumer = f.calls().filter((call) => call.tool !== 'git');
    assert.equal(consumer.length, 2 + EXPECTED_SMOKE_CASES.length);
    for (const call of consumer) {
      assert.ok(call.cwd.startsWith(join(f.root, 'runner-temp')), call.cwd);
      for (const name of ['GITHUB_ENV', 'GITHUB_OUTPUT', 'NODE_OPTIONS', 'NODE_AUTH_TOKEN', 'EXPECTED_SOURCE_SHA', 'RUNNER_TEMP']) assert.ok(!call.env.includes(name), `${call.tool} saw ${name}`);
    }
    assert.ok(consumer.find((call) => call.tool === 'npm').args.some((arg) => /^--before=\d{4}-/.test(arg)));
    assert.ok(consumer.find((call) => call.tool === 'bun' && call.args[0] === 'install').args.includes(`--minimum-release-age=${SMOKE_MINIMUM_RELEASE_AGE_SECONDS}`));
    const report = JSON.parse(readFileSync(join(f.root, 'release-artifacts/smoke-report.json'), 'utf8'));
    assert.deepEqual(report.cases, EXPECTED_SMOKE_CASES);
    assert.deepEqual(report.pinned, {
      '@oxy.so/contracts': 'file:../oxy.so-contracts-4.8.0.tgz',
      '@oxy.so/core': 'file:../floor-core-4.1.0.tgz',
      '@oxy.so/protocol': 'file:../floor-protocol-1.2.1.tgz',
    });
  } finally { cleanup(f); }
});
test('smoke refuses tampered trusted bytes before installing anything', () => {
  const f = fixture({ tamperTrusted: true });
  try {
    const result = f.run('smoke', true);
    assert.equal(result.status, 1);
    assert.equal(f.calls().filter((call) => call.tool !== 'git').length, 0);
  } finally { cleanup(f); }
});
test('only the fixed phases exist', () => {
  const f = fixture();
  try {
    for (const phase of ['release', 'constructor', '__proto__']) {
      const result = f.run(phase, true); assert.equal(result.status, 1); assert.match(result.stderr, /fixed/);
    }
  } finally { cleanup(f); }
});

test('smoke refuses first-party floor bytes that differ from the trusted record', () => {
  const f = fixture({ floorContent: 'substituted floor' });
  try {
    const result = f.run('smoke', true);
    assert.equal(result.status, 1); assert.match(result.stderr, /differ from the trusted build's record/);
    assert.equal(f.calls().filter((call) => call.tool !== 'git').length, 0);
  } finally { cleanup(f); }
});
test('a first-party floor is pinned only to a registry tarball and sha512 integrity', () => {
  const document = { name: '@oxy.so/protocol', version: '1.2.1', dist: { tarball: 'https://registry.npmjs.org/@oxy.so/protocol/-/protocol-1.2.1.tgz', integrity: 'sha512-x' } };
  assert.deepEqual(firstPartyFloor('@oxy.so/protocol@1.2.1', document), { name: '@oxy.so/protocol', version: '1.2.1', tarball: document.dist.tarball, integrity: 'sha512-x' });
  for (const bad of [
    { ...document, dist: { ...document.dist, tarball: 'https://evil.example/@oxy.so/protocol/-/protocol-1.2.1.tgz' } },
    { ...document, dist: { ...document.dist, tarball: 'https://registry.npmjs.org/@oxy.so/other/-/other-1.2.1.tgz' } },
    { ...document, dist: { ...document.dist, integrity: 'sha1-x' } },
    { ...document, version: '1.2.2' },
    { ...document, name: '@oxy.so/other' },
    null,
  ]) assert.throws(() => firstPartyFloor('@oxy.so/protocol@1.2.1', bad), /no registry tarball/);
  assert.throws(() => firstPartyFloor('zod@3.25.64', { ...document, name: 'zod', version: '3.25.64' }), /no registry tarball/);
});
test('floors are part of the trusted-build comparison', () => {
  const prepared = { sourceSha: sha, packages: [], dependencyFloors: [{ name: 'a', version: '1.0.0', tarball: 't', integrity: 'sha512-a' }] };
  assertSameArtifacts(prepared, structuredClone(prepared));
  assert.throws(() => assertSameArtifacts(prepared, { ...prepared, dependencyFloors: [] }), /floors differ/);
});

test('smoke refuses missing or changed published SDK floors before any consumer runs', () => {
  for (const mode of ['missing', 'wrong-version', 'duplicate']) {
    const f = fixture();
    try {
      const path = join(f.root, 'trusted-artifacts/prepared.json');
      const prepared = JSON.parse(readFileSync(path, 'utf8'));
      if (mode === 'missing') prepared.dependencyFloors = prepared.dependencyFloors.filter((floor) => floor.name !== '@oxy.so/core');
      if (mode === 'wrong-version') prepared.dependencyFloors[0].version = '4.2.0';
      if (mode === 'duplicate') prepared.dependencyFloors.push({ ...prepared.dependencyFloors[0] });
      writeFileSync(path, JSON.stringify(prepared));
      const result = f.run('smoke', true);
      assert.equal(result.status, 1); assert.match(result.stderr, /must pin exactly/);
      assert.equal(f.calls().filter((call) => call.tool !== 'git').length, 0);
    } finally { cleanup(f); }
  }
});
