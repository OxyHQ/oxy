import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ciVerdict,
  consumerRanges,
  distTagProblem,
  manifestProblems,
  plan,
  publicPackages,
  releaseTag,
  workspaceDependencies,
  workspacePackages,
  workspaceRangeProblems,
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

test('a public package is released, and nothing private is', () => {
  const names = publicPackages(workspacePackages(resolve('.'))).map(
    ({ manifest }) => manifest.name,
  );
  assert.ok(names.includes('@oxy.so/core'));
  assert.ok(!names.includes('@oxy.so/api'));
});

test('a repository whose root is the package, with `packages/*` workspaces, lists both', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-package-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@oxy.so/bloom', workspaces: ['packages/*'] }),
  );
  for (const name of ['bloom-text', 'internal']) {
    mkdirSync(join(root, 'packages', name), { recursive: true });
    writeFileSync(
      join(root, 'packages', name, 'package.json'),
      JSON.stringify({ name: `@oxy.so/${name}`, private: name === 'internal' }),
    );
  }
  assert.deepEqual(
    publicPackages(workspacePackages(root)).map(({ directory }) => directory),
    ['.', 'packages/bloom-text'],
  );
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

test('a release publishes as latest, a prerelease under the name of its line', () => {
  assert.equal(releaseTag('15.9.0'), 'latest');
  assert.equal(releaseTag('4.11.0-oxy-one.0'), 'oxy-one');
  assert.throws(() => releaseTag('2.0.0-0'), /names no prerelease line/);
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

test('a commit releases every unpublished public version, dependencies first', () => {
  const at = (name, version, dependencies, extra = {}) => ({
    directory: `packages/${name}`,
    manifest: { name, version, dependencies, ...extra },
  });
  const workspaces = [
    at('services', '2.0.0', { core: 'workspace:^' }),
    at('core', '1.1.0', { contracts: 'workspace:^', internal: 'workspace:*' }),
    at('internal', '0.0.0', {}, { private: true }),
    at('contracts', '1.0.0', {}),
  ];
  const registry = {
    published: (name) => name === 'contracts',
    latest: () => '1.0.0',
  };
  assert.deepEqual(plan(workspaces, registry), {
    release: [
      { name: 'core', version: '1.1.0', directory: 'packages/core', tag: 'latest' },
      { name: 'services', version: '2.0.0', directory: 'packages/services', tag: 'latest' },
    ],
    build: ['packages/contracts', 'packages/internal', 'packages/core', 'packages/services'],
  });
  assert.throws(
    () => plan(workspaces, { ...registry, latest: () => '3.0.0' }),
    /core@1\.1\.0 cannot be published as "latest": 1\.1\.0 is older than latest 3\.0\.0/,
  );
});

test('a commit is released only once CI passed on it, from push or the merge queue', () => {
  const sha = 'a'.repeat(40);
  const run = (event, status, conclusion) => ({ head_sha: sha, event, status, conclusion });
  assert.equal(ciVerdict([], sha), 'pending');
  assert.equal(ciVerdict([run('merge_group', 'completed', 'success')], sha), 'passed');
  assert.equal(ciVerdict([run('push', 'in_progress', null)], sha), 'pending');
  assert.equal(ciVerdict([run('pull_request', 'completed', 'success')], sha), 'pending');
  assert.equal(
    ciVerdict(
      [run('push', 'completed', 'cancelled'), run('merge_group', 'completed', 'failure')],
      sha,
    ),
    'failed',
  );
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

test('pack writes the package one bun-packed tarball, runs no lifecycle script, and prints only its path', () => {
  const { destination, printed } = packFixture({ prepack: 'exit 1', prepare: 'exit 1' });
  assert.equal(printed, join(destination, 'example-pack-1.0.0.tgz'));
});

test("pack uses the package's own release:pack, given the destination", () => {
  const { destination, printed } = packFixture({
    'release:pack':
      "node -e \"require('node:fs').writeFileSync(process.argv[1] + '/staged-1.0.0.tgz', '')\"",
  });
  assert.equal(printed, join(destination, 'staged-1.0.0.tgz'));
});

test('a workspace: dependency packed at another version than its workspace is refused', () => {
  // bun pm pack writes the version bun.lock records, so a bump without its
  // lockfile line shipped @kaana.ai/sdk 3.1.1 pinned to contracts 6.1.0.
  const workspaces = [
    { directory: 'packages/contracts', manifest: { name: '@oxy.so/contracts', version: '4.17.0' } },
    { directory: 'packages/core', manifest: { name: '@oxy.so/core', version: '4.12.0' } },
    { directory: 'packages/utils', manifest: { name: '@oxy.so/utils', version: '1.2.1' } },
  ];
  const workspaceSource = {
    ...source,
    dependencies: { '@oxy.so/contracts': 'workspace:^', '@oxy.so/utils': 'workspace:1.2.1' },
    peerDependencies: { '@oxy.so/core': 'workspace:*' },
    devDependencies: { '@oxy.so/core': 'workspace:*' },
  };
  const current = {
    ...packed,
    dependencies: { '@oxy.so/contracts': '^4.17.0', '@oxy.so/utils': '1.2.1' },
    peerDependencies: { '@oxy.so/core': '4.12.0' },
  };
  assert.deepEqual(workspaceRangeProblems(current, workspaceSource, workspaces), []);
  const stale = {
    ...current,
    dependencies: { ...current.dependencies, '@oxy.so/contracts': '^4.16.0' },
    peerDependencies: { '@oxy.so/core': '4.11.0' },
  };
  const problems = workspaceRangeProblems(stale, workspaceSource, workspaces);
  assert.equal(problems.length, 2);
  assert.match(
    problems[0],
    /dependencies\.@oxy\.so\/contracts is packed as "\^4\.16\.0".*"\^4\.17\.0".*bun\.lock is stale/,
  );
  assert.match(problems[1], /peerDependencies\.@oxy\.so\/core is packed as "4\.11\.0".*"4\.12\.0"/);
});

test('a dependency that is not a workspace: spec is left to the other checks', () => {
  const workspaces = [
    { directory: '.', manifest: { name: '@oxy.so/contracts', version: '4.17.0' } },
  ];
  const literal = { ...source, dependencies: { '@oxy.so/contracts': '^4.0.0' } };
  assert.deepEqual(
    workspaceRangeProblems(
      { ...packed, dependencies: { '@oxy.so/contracts': '^4.0.0' } },
      literal,
      workspaces,
    ),
    [],
  );
});

/** Run the real tarball inspector with a registry that contains no versions. */
function inspectPlannedPeer(
  t,
  {
    coreVersion = '6.17.0',
    order = ['@oxy.so/core', '@oxy.so/services'],
    dependencies = {},
    peerRange = '^6.16.0',
    registryError = 'E404',
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'release-planned-peer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['packages/core', 'packages/services', 'staging/package', 'bin'])
    mkdirSync(join(root, directory), { recursive: true });
  const json = (path, value) => writeFileSync(join(root, path), JSON.stringify(value));
  json('package.json', {
    private: true,
    workspaces: {
      packages: ['packages/*'],
      catalog: { '@oxy.so/core': '^6.16.0' },
    },
  });
  json('packages/core/package.json', { name: '@oxy.so/core', version: coreVersion });
  const services = {
    name: '@oxy.so/services',
    version: '12.14.0',
    dependencies,
    devDependencies: { '@oxy.so/core': 'workspace:*' },
    peerDependencies: { '@oxy.so/core': 'catalog:' },
  };
  json('packages/services/package.json', services);
  const planned = plan(workspacePackages(root), { published: () => false, latest: () => null });
  assert.deepEqual(
    planned.release.map(({ name }) => name),
    ['@oxy.so/core', '@oxy.so/services'],
  );
  json('staging/package/package.json', {
    ...services,
    devDependencies: { '@oxy.so/core': coreVersion },
    peerDependencies: { '@oxy.so/core': peerRange },
  });
  const tarball = join(root, 'services.tgz');
  execFileSync('tar', ['-czf', tarball, '-C', join(root, 'staging'), 'package']);
  const calls = join(root, 'registry-calls.jsonl');
  writeFileSync(
    join(root, 'bin/npm'),
    `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
console.error(${JSON.stringify(registryError)});
process.exit(1);
`,
    { mode: 0o755 },
  );
  const result = spawnSync('node', [tool, 'inspect', tarball, 'packages/services', ...order], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
  });
  return {
    ...result,
    registryCalls: existsSync(calls)
      ? readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse)
      : [],
  };
}

test('catalog peer ^6.16.0 accepts core 6.17.0 published earlier in the actual workspace release order', (t) => {
  const result = inspectPlannedPeer(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /every check passed/);
  assert.deepEqual(result.registryCalls, []);
});

test('a same-batch core version outside the peer range still fails an empty registry', (t) => {
  const result = inspectPlannedPeer(t, { coreVersion: '7.0.0' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /@oxy\.so\/core@\^6\.16\.0, which nothing on the registry satisfies/);
  assert.equal(result.registryCalls.length, 1);
});

test('a prerelease does not satisfy a stable peer range merely because it is planned first', (t) => {
  const result = inspectPlannedPeer(t, { coreVersion: '6.17.0-beta.1' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.registryCalls.length, 1);
});

test('a matching candidate planned later is not a published-first dependency', (t) => {
  const result = inspectPlannedPeer(t, { order: ['@oxy.so/services', '@oxy.so/core'] });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.registryCalls.length, 1);
});

test('an inspected package absent from the ordered plan cannot exempt same-name candidates', (t) => {
  const result = inspectPlannedPeer(t, { order: ['@oxy.so/core'] });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.registryCalls.length, 1);
});

test('unrelated missing external dependencies are still refused', (t) => {
  const result = inspectPlannedPeer(t, { dependencies: { 'missing-external': '^1.0.0' } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /missing-external@\^1\.0\.0, which nothing on the registry satisfies/,
  );
  assert.equal(result.registryCalls.length, 1);
});

test('matching peer range does not exempt an incompatible dependency range of the same name', (t) => {
  const result = inspectPlannedPeer(t, { dependencies: { '@oxy.so/core': '^7.0.0' } });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /@oxy\.so\/core@\^7\.0\.0, which nothing on the registry satisfies/);
  assert.equal(result.registryCalls.length, 1);
});

test('external registry errors fail closed rather than being accepted as a planned match', (t) => {
  const result = inspectPlannedPeer(t, {
    dependencies: { 'missing-external': '^1.0.0' },
    registryError: 'E503',
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /npm view missing-external@\^1\.0\.0 version failed: E503/);
});

for (const peerRange of ['latest', 'bad range', 'npm:other@^1', 'file:../x']) {
  test(`planned version cannot exempt non-semver spec ${peerRange} from registry validation`, (t) => {
    const result = inspectPlannedPeer(t, { peerRange });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.registryCalls.length, 1);
  });
}

test('plan and published remain usable from a sparse helper checkout without inspector dependencies', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'release-no-runtime-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sparseTool = join(root, 'release-package.mjs');
  writeFileSync(sparseTool, readFileSync(tool));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }));
  mkdirSync(join(root, 'bin'));
  writeFileSync(
    join(root, 'bin/npm'),
    '#!/usr/bin/env node\nconsole.log(JSON.stringify("1.0.0"));\n',
    { mode: 0o755 },
  );
  const options = {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
  };
  assert.deepEqual(JSON.parse(execFileSync('node', [sparseTool, 'plan'], options)), {
    release: [],
    build: [],
  });
  assert.equal(
    spawnSync('node', [sparseTool, 'published', '@example/package', '1.0.0'], options).status,
    0,
  );
});

for (const scenario of [
  'identical',
  'absent',
  'different',
  'missing-integrity',
  'wrong-version',
  'forbidden',
  'unavailable',
]) {
  test(`publish-time registry recheck fails closed: ${scenario}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'release-recheck-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'bin'));
    const bytes = Buffer.from('trusted artifact bytes');
    const tarball = join(root, 'package.tgz');
    writeFileSync(tarball, bytes);
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const metadata = {
      name: '@example/package',
      version: scenario === 'wrong-version' ? '2.0.0' : '1.0.0',
      dist:
        scenario === 'missing-integrity'
          ? {}
          : { integrity: scenario === 'different' ? 'sha512-other' : integrity },
    };
    const error = { absent: 'E404', forbidden: 'E403', unavailable: 'E503' }[scenario];
    const calls = join(root, 'calls.json');
    writeFileSync(
      join(root, 'bin/npm'),
      `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));
${error ? `console.error(${JSON.stringify(error)}); process.exit(1);` : `console.log(${JSON.stringify(JSON.stringify(metadata))});`}
`,
      { mode: 0o755 },
    );
    // Sparse helper checkout has no inspector dependencies or repository hooks.
    const sparseTool = join(root, 'release-package.mjs');
    writeFileSync(sparseTool, readFileSync(tool));
    const result = spawnSync(
      'node',
      [sparseTool, 'publish-status', '@example/package', '1.0.0', tarball],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH}` },
      },
    );
    assert.equal(
      result.status,
      scenario === 'identical' ? 0 : scenario === 'absent' ? 1 : 2,
      result.stderr,
    );
    assert.deepEqual(JSON.parse(readFileSync(calls, 'utf8')), [
      'view',
      '@example/package@1.0.0',
      '--json',
      '--prefer-online',
      '--userconfig',
      '/dev/null',
    ]);
  });
}

for (const scenario of ['identical', 'absent', 'different', 'forbidden', 'publish-forbidden']) {
  test(`actual publish workflow shell handles ${scenario} without hiding failures`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'release-shell-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'bin'));
    const workflow = readFileSync(new URL('../workflows/npm-release.yml', import.meta.url), 'utf8');
    const block = workflow
      .split('      - name: publish the trusted tarballs, dependencies first\n')[1]
      .split('        run: |\n')[1]
      .split('\n      # Also when')[0];
    const shell = block
      .split('\n')
      .map((line) => line.replace(/^ {10}/, ''))
      .join('\n');
    const bytes = Buffer.from('trusted artifact bytes');
    writeFileSync(join(root, 'package.tgz'), bytes);
    const packageLine = JSON.stringify({
      name: '@example/package',
      version: '1.0.0',
      tag: 'latest',
      tarball: 'package.tgz',
    });
    writeFileSync(join(root, 'release.jsonl'), `${packageLine}\n`);
    writeFileSync(
      join(root, 'SHA512SUMS'),
      ['package.tgz', 'release.jsonl']
        .map(
          (file) =>
            `${createHash('sha512')
              .update(readFileSync(join(root, file)))
              .digest('hex')}  ${file}\n`,
        )
        .join(''),
    );
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
    const metadata = {
      name: '@example/package',
      version: '1.0.0',
      dist: { integrity: scenario === 'different' ? 'sha512-other' : integrity },
    };
    const calls = join(root, 'calls.jsonl');
    writeFileSync(
      join(root, 'bin/npm'),
      `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+'\\n');
if(process.argv[2]==='publish') { ${scenario === 'publish-forbidden' ? "console.error('E403');process.exit(1);" : 'process.exit(0);'} }
${scenario === 'forbidden' ? "console.error('E403');process.exit(1);" : scenario === 'absent' || scenario === 'publish-forbidden' ? "console.error('E404');process.exit(1);" : `console.log(${JSON.stringify(JSON.stringify(metadata))});`}
`,
      { mode: 0o755 },
    );
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', shell], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        RUNNER_TEMP: root,
        RELEASE_PACKAGE: tool,
      },
    });
    assert.equal(
      result.status,
      scenario === 'identical' || scenario === 'absent' ? 0 : 1,
      result.stderr,
    );
    const commands = readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(
      commands.filter((args) => args[0] === 'publish').length,
      scenario === 'absent' || scenario === 'publish-forbidden' ? 1 : 0,
    );
    assert.equal(existsSync(join(root, 'published.jsonl')), scenario === 'absent');
  });
}
