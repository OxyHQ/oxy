import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  duplicateFindings,
  inspectRepository,
  installedDuplicateFindings,
  mustBeSingle,
  parseBunLock,
} from '../src/checks.mjs';

/** A bun.lock text: workspaces and `key: [ident, meta]` packages, with Bun's trailing commas. */
function lockText({ workspaces = { '': { name: 'app' } }, packages = {}, overrides, catalog }) {
  const body = {
    lockfileVersion: 1,
    workspaces,
    ...(overrides ? { overrides } : {}),
    ...(catalog ? { catalog } : {}),
    packages: Object.fromEntries(
      Object.entries(packages).map(([key, [ident, meta = {}]]) => [
        key,
        [ident, '', meta, 'sha512-x'],
      ]),
    ),
  };
  return JSON.stringify(body, null, 2).replace(/(["\]}])\n(\s*[}\]])/g, '$1,\n$2');
}
const findingsFor = (spec) => duplicateFindings(parseBunLock(lockText(spec)));

/** Dropsea #34: protocol kept contracts 6.8.0 nested after core and services moved to 6.9.0. */
const staleContracts = {
  workspaces: {
    '': { name: 'dropsea' },
    'ws/frontend': {
      name: '@dropsea/frontend',
      dependencies: { '@oxy.so/core': '7.23.0', '@oxy.so/services': '14.3.8' },
    },
  },
  packages: {
    '@dropsea/frontend': ['@dropsea/frontend@workspace:ws/frontend'],
    '@oxy.so/core': [
      '@oxy.so/core@7.23.0',
      { dependencies: { '@oxy.so/contracts': '^6.9.0', '@oxy.so/protocol': '^1.6.1' } },
    ],
    '@oxy.so/services': [
      '@oxy.so/services@14.3.8',
      { dependencies: { '@oxy.so/contracts': '^6.9.0' } },
    ],
    '@oxy.so/protocol': [
      '@oxy.so/protocol@1.6.1',
      { dependencies: { '@oxy.so/contracts': '^6.5.0' } },
    ],
    '@oxy.so/contracts': ['@oxy.so/contracts@6.9.0', { dependencies: { zod: '^4.6.7' } }],
    '@oxy.so/protocol/@oxy.so/contracts': [
      '@oxy.so/contracts@6.8.0',
      { dependencies: { zod: '^4.6.7' } },
    ],
    zod: ['zod@4.6.7'],
  },
};

describe('duplicate copies in bun.lock', () => {
  test('parses Bun lockfiles, trailing commas included, without touching strings', () => {
    const lock = parseBunLock('{\n  "a": ["x, ]", { "b": "}," },],\n  "c": "\\",]",\n}\n');
    expect(lock).toEqual({ a: ['x, ]', { b: '},' }], c: '",]' });
  });

  test('a copy installed under an alias is its own, not a second copy of the package', () => {
    const aliased = {
      workspaces: {
        '': {
          name: 'website',
          dependencies: { '@oxy.so/bloom': '17.9.0' },
          devDependencies: { '@fairwallet/bloom': 'npm:@oxy.so/bloom@1.3.0' },
        },
      },
      packages: {
        '@oxy.so/bloom': ['@oxy.so/bloom@17.9.0'],
        '@fairwallet/bloom': ['@oxy.so/bloom@1.3.0'],
      },
    };
    expect(findingsFor(aliased)).toEqual([]);
    aliased.packages['some-lib'] = [
      'some-lib@1.0.0',
      { dependencies: { '@oxy.so/bloom': '^1.3.0' } },
    ];
    aliased.packages['some-lib/@oxy.so/bloom'] = ['@oxy.so/bloom@1.3.0'];
    expect(findingsFor(aliased)).toEqual([
      expect.objectContaining({ code: 'duplicate-conflict', package: '@oxy.so/bloom' }),
    ]);
  });

  test('a stale nested copy is an error naming both versions, who pulls each, and the fix', () => {
    const [finding, ...rest] = findingsFor(staleContracts);
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      severity: 'error',
      code: 'duplicate-copy',
      package: '@oxy.so/contracts',
      installed: ['6.9.0', '6.8.0'],
      target: '6.9.0',
    });
    expect(finding.message).toContain('6.8.0 (pulled by @oxy.so/protocol@1.6.1 (^6.5.0))');
    expect(finding.message).toContain(
      '6.9.0 (pulled by @oxy.so/core@7.23.0 (^6.9.0), @oxy.so/services@14.3.8 (^6.9.0))',
    );
    expect(finding.message).toContain('`bun update -r @oxy.so/contracts`');
  });

  test('one locked copy reports nothing', () => {
    const packages = { ...staleContracts.packages };
    delete packages['@oxy.so/protocol/@oxy.so/contracts'];
    expect(findingsFor({ ...staleContracts, packages })).toEqual([]);
  });

  test('any package, not only a single-copy one, fails when the newest copy serves every range', () => {
    const [finding] = findingsFor({
      workspaces: { '': { name: 'app', dependencies: { a: '1.0.0', b: '1.0.0' } } },
      packages: {
        a: ['a@1.0.0', { dependencies: { '@expo/env': '~2.5.3' } }],
        b: ['b@1.0.0', { dependencies: { '@expo/env': '^2.5.4' } }],
        '@expo/env': ['@expo/env@2.5.3'],
        'b/@expo/env': ['@expo/env@2.5.4'],
      },
    });
    expect(finding).toMatchObject({ severity: 'error', code: 'duplicate-copy', target: '2.5.4' });
  });

  test('copies forced by incompatible ranges of an ordinary package are normal', () => {
    expect(
      findingsFor({
        workspaces: { '': { name: 'app', dependencies: { a: '1.0.0', b: '1.0.0' } } },
        packages: {
          a: ['a@1.0.0', { dependencies: { esbuild: '^0.25.0' } }],
          b: ['b@1.0.0', { dependencies: { esbuild: '^0.27.0' } }],
          esbuild: ['esbuild@0.27.1'],
          'a/esbuild': ['esbuild@0.25.9'],
        },
      }),
    ).toEqual([]);
  });

  test('a single-copy package forced by incompatible ranges is a conflict that needs a release', () => {
    const [finding] = findingsFor({
      workspaces: { '': { name: 'app', dependencies: { react: '19.3.1', legacy: '1.0.0' } } },
      packages: {
        react: ['react@19.3.1'],
        legacy: ['legacy@1.0.0', { dependencies: { react: '^18.2.0' } }],
        'legacy/react': ['react@18.3.1'],
      },
    });
    expect(finding).toMatchObject({
      severity: 'error',
      code: 'duplicate-conflict',
      package: 'react',
      blockers: [{ by: 'legacy@1.0.0', range: '^18.2.0' }],
    });
    expect(finding.message).toContain('legacy@1.0.0 needs a release whose range accepts 19.3.1');
    expect(finding.message).not.toContain('bun update react');
  });

  test("a workspace's own narrow range is named as the manifest to widen", () => {
    const [finding] = findingsFor({
      workspaces: {
        '': { name: 'app', dependencies: { '@oxy.so/core': '7.23.0' } },
        'ws/api': { name: '@app/api', dependencies: { 'socket.io-client': '~4.7.0' } },
      },
      packages: {
        '@app/api': ['@app/api@workspace:ws/api'],
        '@oxy.so/core': ['@oxy.so/core@7.23.0', { dependencies: { 'socket.io-client': '^4.8.4' } }],
        'socket.io-client': ['socket.io-client@4.8.4'],
        '@app/api/socket.io-client': ['socket.io-client@4.7.5'],
      },
    });
    expect(finding.code).toBe('duplicate-conflict');
    expect(finding.message).toContain('widen the range in ws/api/package.json to accept 4.8.4');
  });

  test('ranges that meet only below the newest copy are pinned: an error for a single-copy package', () => {
    const spec = (name) => ({
      workspaces: { '': { name: 'app', dependencies: { wide: '1.0.0', pinner: '1.0.0' } } },
      packages: {
        wide: ['wide@1.0.0', { dependencies: { [name]: '^0.3.1' } }],
        pinner: ['pinner@1.0.0', { dependencies: { [name]: '0.3.1' } }],
        [name]: [`${name}@0.3.2`],
        [`pinner/${name}`]: [`${name}@0.3.1`],
      },
    });
    const [ordinary] = findingsFor(spec('bplist-parser'));
    expect(ordinary).toMatchObject({
      severity: 'warning',
      code: 'duplicate-pinned',
      target: '0.3.1',
    });
    const [single] = findingsFor(spec('react-native-screens'));
    expect(single).toMatchObject({ severity: 'error', code: 'duplicate-pinned', newest: '0.3.2' });
    expect(single.message).toContain('pinner@1.0.0 needs a release whose range accepts 0.3.2');
    expect(single.message).toContain('"overrides": { "react-native-screens": "0.3.1" }');
  });

  test('zod is single only among the copies Oxy packages use', () => {
    const base = {
      workspaces: {
        '': { name: 'app', dependencies: { '@oxy.so/contracts': '6.9.0', tool: '1.0.0' } },
      },
      packages: {
        '@oxy.so/contracts': ['@oxy.so/contracts@6.9.0', { dependencies: { zod: '^4.6.7' } }],
        tool: ['tool@1.0.0', { dependencies: { zod: '^3.24.1' } }],
        zod: ['zod@4.6.7'],
        'tool/zod': ['zod@3.25.76'],
      },
    };
    expect(findingsFor(base)).toEqual([]);
    const shared = structuredClone(base);
    shared.workspaces['ws/contracts'] = {
      name: '@oxy.so/app-contracts',
      dependencies: { zod: '^3.24.1' },
    };
    shared.packages['@oxy.so/app-contracts'] = ['@oxy.so/app-contracts@workspace:ws/contracts'];
    shared.packages['@oxy.so/app-contracts/zod'] = ['zod@3.25.76'];
    const [finding] = findingsFor(shared);
    expect(finding).toMatchObject({ code: 'duplicate-conflict', package: 'zod' });
    expect(finding.message).toContain(
      'widen the range in ws/contracts/package.json to accept 4.6.7',
    );
  });

  test('Oxy packages on one zod, each nested under a hoisted zod 3, are a hoisting error', () => {
    const [finding, ...rest] = findingsFor({
      workspaces: {
        '': { name: 'app', dependencies: { '@oxy.so/core': '7.23.0' } },
        'ws/api': { name: '@app/api', dependencies: { zod: '^3.25.76' } },
      },
      packages: {
        '@app/api': ['@app/api@workspace:ws/api'],
        '@oxy.so/core': [
          '@oxy.so/core@7.23.0',
          { dependencies: { '@oxy.so/contracts': '^6.9.0', zod: '^4.6.7' } },
        ],
        '@oxy.so/contracts': ['@oxy.so/contracts@6.9.0', { dependencies: { zod: '^4.6.7' } }],
        zod: ['zod@3.25.76'],
        '@oxy.so/core/zod': ['zod@4.6.7'],
        '@oxy.so/contracts/zod': ['zod@4.6.7'],
      },
    });
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      severity: 'error',
      code: 'duplicate-hoisted',
      package: 'zod',
      target: '4.6.7',
      hoisted: {
        version: '3.25.76',
        pulledBy: [{ by: 'ws/api/package.json', range: '^3.25.76' }],
      },
    });
    expect(finding.message).toContain('declare `"zod": "^4.6.7"` in the root package.json');
  });

  test("a bundled copy is its dependent's own, unless the package must be single", () => {
    const spec = (name) => ({
      workspaces: { '': { name: 'app', dependencies: { [name]: '^2.8.0', wasm: '1.0.0' } } },
      packages: {
        [name]: [`${name}@2.8.1`],
        wasm: ['wasm@1.0.0', { dependencies: { [name]: '^2.4.0' } }],
        [`wasm/${name}`]: [`${name}@2.8.1`, { bundled: true }],
      },
    });
    expect(findingsFor(spec('tslib'))).toEqual([]);
    const [finding] = findingsFor(spec('@oxy.so/bloom'));
    expect(finding.code).toBe('duplicate-conflict');
    expect(finding.message).toContain('wasm@1.0.0 bundles a private copy');
  });

  test('reads catalog ranges and workspace-nested keys', () => {
    const [finding] = findingsFor({
      catalog: { react: '19.3.1' },
      workspaces: {
        '': { name: 'app', dependencies: { react: 'catalog:' } },
        'ws/web': { name: '@app/web', dependencies: { react: 'catalog:' } },
      },
      packages: {
        '@app/web': ['@app/web@workspace:ws/web'],
        react: ['react@19.3.1'],
        '@app/web/react': ['react@19.3.0'],
      },
    });
    expect(finding).toMatchObject({ code: 'duplicate-copy', severity: 'error', package: 'react' });
    expect(finding.message).toContain('19.3.0 (pulled by ws/web/package.json (19.3.1))');
  });

  test('names the single-copy packages', () => {
    for (const name of [
      '@oxy.so/bloom',
      '@oxy.so/contracts',
      'react',
      'react-dom',
      'expo',
      'socket.io-client',
    ])
      expect(mustBeSingle(name)).toBe(true);
    expect(mustBeSingle('tslib')).toBe(false);
    expect(mustBeSingle('zod')).toBe(false);
  });
});

async function writePackage(directory, name, version) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version }));
}

describe('duplicate copies in the installed tree', () => {
  test('without node_modules nothing is checked, and nothing is claimed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oxy-doctor-tree-'));
    try {
      expect(installedDuplicateFindings(root, [])).toEqual({ checked: false, findings: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a stale nested copy is found; a symlinked one is the same copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oxy-doctor-tree-'));
    try {
      await writePackage(join(root, 'node_modules/@oxy.so/bloom'), '@oxy.so/bloom', '17.9.0');
      await writePackage(
        join(root, 'node_modules/@oxy.so/services/node_modules/@oxy.so/bloom'),
        '@oxy.so/bloom',
        '17.8.1',
      );
      await writePackage(join(root, 'node_modules/@oxy.so/services'), '@oxy.so/services', '14.3.8');
      await writePackage(join(root, 'node_modules/tslib'), 'tslib', '2.8.1');
      await writePackage(join(root, 'node_modules/a/node_modules/tslib'), 'tslib', '2.9.1');
      await mkdir(join(root, 'ws/web/node_modules'), { recursive: true });
      await symlink(
        join(root, 'node_modules/@oxy.so/services'),
        join(root, 'ws/web/node_modules/services'),
      );
      const { checked, findings } = installedDuplicateFindings(root, [join(root, 'ws/web')]);
      expect(checked).toBe(true);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({
        code: 'installed-duplicate',
        package: '@oxy.so/bloom',
        installed: ['17.9.0', '17.8.1'],
      });
      expect(installedDuplicateFindings(root, [], new Set(['@oxy.so/bloom'])).findings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a package installed under an alias is not a second copy of the package it names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oxy-doctor-tree-'));
    try {
      await writePackage(join(root, 'node_modules/@oxy.so/bloom'), '@oxy.so/bloom', '17.9.0');
      await writePackage(join(root, 'node_modules/@fairwallet/bloom'), '@oxy.so/bloom', '1.3.0');
      expect(installedDuplicateFindings(root, []).findings).toEqual([]);
      await writePackage(
        join(root, 'node_modules/@fairwallet/bloom/node_modules/@oxy.so/bloom'),
        '@oxy.so/bloom',
        '1.2.0',
      );
      expect(installedDuplicateFindings(root, []).findings).toEqual([
        expect.objectContaining({ package: '@oxy.so/bloom', installed: ['1.2.0', '17.9.0'] }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Bun's isolated store: two store entries of one package are two copies", async () => {
    const root = await mkdtemp(join(tmpdir(), 'oxy-doctor-tree-'));
    try {
      const store = join(root, 'node_modules/.bun');
      await writePackage(join(store, 'react@19.3.1/node_modules/react'), 'react', '19.3.1');
      await writePackage(join(store, 'react@19.3.0/node_modules/react'), 'react', '19.3.0');
      await symlink(
        join(store, 'react@19.3.1/node_modules/react'),
        join(root, 'node_modules/react'),
      );
      const { findings } = installedDuplicateFindings(root, []);
      expect(findings.map((finding) => [finding.package, finding.paths.length])).toEqual([
        ['react', 2],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('inspectRepository reports lockfile and installed duplicates once each', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oxy-doctor-tree-'));
    try {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'app', workspaces: ['ws/*'] }),
      );
      await mkdir(join(root, 'ws/frontend'), { recursive: true });
      await writeFile(
        join(root, 'ws/frontend/package.json'),
        JSON.stringify({
          name: '@dropsea/frontend',
          dependencies: { '@oxy.so/core': '7.23.0', '@oxy.so/services': '14.3.8' },
        }),
      );
      await writeFile(join(root, 'bun.lock'), lockText(staleContracts));
      await writePackage(
        join(root, 'node_modules/@oxy.so/contracts'),
        '@oxy.so/contracts',
        '6.9.0',
      );
      await writePackage(
        join(root, 'node_modules/@oxy.so/protocol/node_modules/@oxy.so/contracts'),
        '@oxy.so/contracts',
        '6.8.0',
      );
      await writePackage(join(root, 'node_modules/react'), 'react', '19.3.1');
      await writePackage(join(root, 'node_modules/x/node_modules/react'), 'react', '19.3.1');
      const fetchLatest = async (name) => ({
        version: name === '@oxy.so/core' ? '7.23.0' : '14.3.8',
        publishedAt: '2026-11-01T00:00:00.000Z',
      });
      const report = await inspectRepository(root, fetchLatest, {
        now: new Date('2026-11-05T00:00:00Z'),
      });
      expect(report.installedTreeChecked).toBe(true);
      expect(report.findings.map((finding) => [finding.code, finding.package])).toEqual([
        ['duplicate-copy', '@oxy.so/contracts'],
        ['installed-duplicate', 'react'],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
