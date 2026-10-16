import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  firstPartyRanges,
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

test('only the first-party ranges a consumer installs are checked on the registry', () => {
  assert.deepEqual(firstPartyRanges({ ...packed, devDependencies: { '@oxy.so/db': '1.0.0' } }), [
    '@oxy.so/contracts@^4.16.0',
    '@oxy.so/core@4.11.0',
  ]);
});

test('every public workspace package is releasable, and nothing private is', () => {
  const workspaces = workspacePackages(resolve('.'));
  assert.equal(resolveWorkspace('@oxy.so/core', workspaces), 'packages/core');
  assert.throws(
    () => resolveWorkspace('@oxy.so/api', workspaces),
    /not a public workspace package/,
  );
});

const workspace = (name, dependencies = {}, devDependencies = {}) => ({
  directory: name,
  manifest: { name, dependencies, devDependencies },
});

test('the workspace packages to build come dependencies first, registry ranges excluded', () => {
  const workspaces = [
    workspace('services', { core: '4.10.0', contracts: 'workspace:*' }),
    workspace('core', { contracts: 'workspace:4.16.0', protocol: 'workspace:^' }),
    workspace('protocol', { contracts: 'workspace:^' }),
    workspace('contracts', {}, { zod: '^4.0.0' }),
  ];
  assert.deepEqual(workspaceDependencies('core', workspaces), ['contracts', 'protocol']);
  assert.deepEqual(workspaceDependencies('services', workspaces), ['contracts']);
  assert.deepEqual(workspaceDependencies('contracts', workspaces), []);
});

test('a workspace cycle is refused', () => {
  const workspaces = [
    workspace('a', { b: 'workspace:*' }),
    workspace('b', {}, { a: 'workspace:*' }),
  ];
  assert.throws(() => workspaceDependencies('a', workspaces), /workspace cycle: a -> b -> a/);
});
