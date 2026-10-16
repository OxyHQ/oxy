import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  consumerRanges,
  distTagProblem,
  manifestProblems,
  resolveWorkspace,
  workspaceDependencies,
  workspacePackages,
} from './release-package.mjs';

const source = { name: '@oxy.so/example', version: '1.2.0' };
const packed = {
  ...source,
  main: './dist/cjs/index.js',
  types: './dist/types/index.d.ts',
  exports: {
    '.': { import: './dist/esm/index.js', require: './dist/cjs/index.js' },
    './assets/*': './assets/*',
  },
  dependencies: { '@oxy.so/contracts': '^4.16.0', zod: '^4.0.0' },
  peerDependencies: { '@oxy.so/core': '4.11.0' },
};
const entries = [
  'package/package.json',
  'package/dist/cjs/index.js',
  'package/dist/esm/index.js',
  'package/dist/types/index.d.ts',
];

test('a well-packed tarball has no problems', () => {
  assert.deepEqual(manifestProblems(packed, source, entries), []);
});

test('a tarball that is not the workspace version is refused', () => {
  const [problem] = manifestProblems({ ...packed, version: '1.1.0' }, source, entries);
  assert.match(problem, /packed @oxy\.so\/example@1\.1\.0/);
});

test('a workspace: or catalog: range left in the manifest is refused', () => {
  const problems = manifestProblems(
    {
      ...packed,
      dependencies: { '@oxy.so/contracts': 'workspace:^' },
      peerDependencies: { '@oxy.so/core': 'catalog:' },
    },
    source,
    entries,
  );
  assert.equal(problems.length, 2);
  assert.ok(problems.every((problem) => /pack with bun/.test(problem)));
});

test('a declared entry point missing from the tarball is refused', () => {
  const problems = manifestProblems(packed, source, entries.slice(0, 2));
  assert.deepEqual(problems, [
    'declares ./dist/types/index.d.ts, which is not in the tarball',
    'declares ./dist/esm/index.js, which is not in the tarball',
  ]);
});

test('a TypeScript build-info file in the tarball is refused', () => {
  const problems = manifestProblems(packed, source, [...entries, 'package/dist/cjs/.tsbuildinfo']);
  assert.deepEqual(problems, [
    'ships the TypeScript build-info file dist/cjs/.tsbuildinfo: exclude it in "files"',
  ]);
});

test('every range a consumer installs is checked on the registry, devDependencies excluded', () => {
  assert.deepEqual(consumerRanges({ ...packed, devDependencies: { '@oxy.so/db': '1.0.0' } }), [
    '@oxy.so/contracts@^4.16.0',
    'zod@^4.0.0',
    '@oxy.so/core@4.11.0',
  ]);
});

test('every public workspace package is releasable, and nothing private is', () => {
  const workspaces = workspacePackages(resolve('.'));
  assert.equal(resolveWorkspace('@oxy.so/core', workspaces), 'packages/core');
  assert.throws(
    () => resolveWorkspace('@oxy.so/api', workspaces),
    /not a public package of this repository/,
  );
});

test('every public package of this repository states its pre-flight in prepublishOnly', () => {
  const workspaces = workspacePackages(resolve('.'));
  for (const { manifest } of workspaces.filter(
    (w) => w.manifest.name && w.manifest.private !== true,
  ))
    assert.doesNotThrow(() => resolveWorkspace(manifest.name, workspaces), manifest.name);
});

test('a repository whose root is the package, with `packages/*` workspaces, resolves both', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-package-'));
  const scripts = { prepublishOnly: 'bun run build' };
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@oxy.so/bloom', scripts, workspaces: ['packages/*'] }),
  );
  for (const name of ['bloom-text', 'internal']) {
    mkdirSync(join(root, 'packages', name), { recursive: true });
    writeFileSync(
      join(root, 'packages', name, 'package.json'),
      JSON.stringify({ name: `@oxy.so/${name}`, scripts, private: name === 'internal' }),
    );
  }
  const workspaces = workspacePackages(root);
  assert.equal(resolveWorkspace('@oxy.so/bloom', workspaces), '.');
  assert.equal(resolveWorkspace('@oxy.so/bloom-text', workspaces), 'packages/bloom-text');
  assert.throws(() => resolveWorkspace('@oxy.so/internal', workspaces), /not a public package/);
});

test('a public package without prepublishOnly is refused', () => {
  const workspaces = [{ directory: 'packages/sdk', manifest: { name: '@example/sdk' } }];
  assert.throws(() => resolveWorkspace('@example/sdk', workspaces), /declares no prepublishOnly/);
});

test('a workspace pattern other than `dir/*` or a literal directory is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-package-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/**'] }));
  assert.throws(() => workspacePackages(root), /unsupported workspace pattern "packages\/\*\*"/);
});

test('latest never goes backwards and never names a prerelease', () => {
  assert.equal(distTagProblem('15.9.0', 'latest', '15.8.0'), null);
  assert.equal(distTagProblem('1.0.0', 'latest', null), null);
  assert.match(distTagProblem('15.9.0', 'latest', '18.1.0'), /older than latest 18\.1\.0/);
  assert.match(distTagProblem('2.0.0-next.1', 'latest', '1.0.0'), /is a prerelease/);
  assert.equal(distTagProblem('15.9.0', 'legacy', '18.1.0'), null);
  assert.equal(distTagProblem('2.0.0-next.1', 'next', '1.0.0'), null);
});

const workspace = (name, dependencies = {}, devDependencies = {}) => ({
  directory: `packages/${name}`,
  manifest: { name, dependencies, devDependencies },
});

test('the workspace packages to build come dependencies first, registry ranges excluded', () => {
  const workspaces = [
    workspace('services', { core: '4.10.0', contracts: 'workspace:*' }),
    workspace('core', { contracts: 'workspace:4.16.0', protocol: 'workspace:^' }),
    workspace('protocol', { contracts: 'workspace:^' }),
    workspace('contracts', {}, { zod: '^4.0.0' }),
  ];
  assert.deepEqual(workspaceDependencies('core', workspaces), [
    'packages/contracts',
    'packages/protocol',
  ]);
  assert.deepEqual(workspaceDependencies('services', workspaces), ['packages/contracts']);
  assert.deepEqual(workspaceDependencies('contracts', workspaces), []);
});

test('a workspace cycle is refused', () => {
  const workspaces = [
    workspace('a', { b: 'workspace:*' }),
    workspace('b', {}, { a: 'workspace:*' }),
  ];
  assert.throws(() => workspaceDependencies('a', workspaces), /workspace cycle: a -> b -> a/);
});

const tool = new URL('./release-package.mjs', import.meta.url).pathname;

function packFixture(scripts) {
  const directory = mkdtempSync(join(tmpdir(), 'release-pack-'));
  const destination = join(directory, 'out');
  mkdirSync(destination);
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: '@example/pack', version: '1.0.0', files: ['index.js'], scripts }),
  );
  writeFileSync(join(directory, 'index.js'), 'export {};\n');
  const printed = execFileSync('node', [tool, 'pack', directory, destination], {
    encoding: 'utf8',
  });
  return { destination, printed: printed.trim() };
}

test('pack writes the package one bun-packed tarball and prints only its path', () => {
  const { destination, printed } = packFixture({});
  assert.equal(printed, join(destination, 'example-pack-1.0.0.tgz'));
});

test("pack uses the package's own release:pack, given the destination", () => {
  const { destination, printed } = packFixture({
    'release:pack':
      "node -e \"require('node:fs').writeFileSync(process.argv[1] + '/staged-1.0.0.tgz', '')\"",
  });
  assert.equal(printed, join(destination, 'staged-1.0.0.tgz'));
});
