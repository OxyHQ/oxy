import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  compareVersions,
  DEFAULT_GRACE_DAYS,
  inspectRepository,
  isFirstPartyPackage,
  isNativeModulePackage,
  lockfileVersions,
  rangeIncludesVersion,
} from '../src/checks.mjs';

async function repoWith(dependencies) {
  const root = await mkdtemp(join(tmpdir(), 'oxy-doctor-'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies }));
  const lines = Object.entries(dependencies).map(
    ([name, range]) => `"${name}": ["${name}@${range.replace(/^[\^~]/, '')}", ""],`,
  );
  await writeFile(join(root, 'bun.lock'), `{\n"packages": {\n${lines.join('\n')}\n}\n}\n`);
  return root;
}

const release = (version, publishedAt) => async () => ({ version, publishedAt });

describe('Oxy Doctor checks', () => {
  test('recognizes ecosystem package scopes', () => {
    expect(isFirstPartyPackage('@oxy.so/core')).toBe(true);
    expect(isFirstPartyPackage('@clarity.surf/sdk')).toBe(false);
    expect(isFirstPartyPackage('@clarity.surf/sdk')).toBe(false);
    expect(isFirstPartyPackage('@alia.onl/sdk')).toBe(false);
    expect(isFirstPartyPackage('react')).toBe(false);
  });
  test('compares stable semantic versions', () => {
    expect(compareVersions('30.2.5', '31.0.0')).toBe(-1);
    expect(compareVersions('23.3.4', '23.3.4')).toBe(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
  });
  test('understands the range forms used by ecosystem manifests', () => {
    expect(rangeIncludesVersion('^20.1.0 || ^23.0.0', '23.3.4')).toBe(true);
    expect(rangeIncludesVersion('>=0.59.0 <2.0.0', '1.14.3')).toBe(true);
    expect(rangeIncludesVersion('>=0.37.0 <0.41.0', '0.41.0')).toBe(false);
    expect(rangeIncludesVersion('31.0.0', '31.0.3')).toBe(false);
  });
  test('finds top-level and nested Bun lockfile resolutions', () => {
    const lock = `"@oxy.so/services": ["@oxy.so/services@31.0.3", ""],\n"consumer/@oxy.so/services": ["@oxy.so/services@30.2.0", ""]`;
    expect(lockfileVersions(lock, '@oxy.so/services')).toEqual(['31.0.3', '30.2.0']);
  });

  test('a release newer than the range is a warning inside the grace window', async () => {
    const root = await repoWith({ '@oxy.so/services': '^10.0.0' });
    try {
      const report = await inspectRepository(root, release('11.0.0', '2026-09-30T14:07:51.959Z'), {
        now: new Date('2026-10-05T00:00:00Z'),
      });
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]).toMatchObject({
        severity: 'warning',
        code: 'outdated',
        latest: '11.0.0',
      });
      expect(report.findings[0].message).toContain('upgrade by 2026-10-14');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('the same release is an error once the grace window has closed', async () => {
    const root = await repoWith({ '@oxy.so/services': '^10.0.0' });
    try {
      const at = (iso) =>
        inspectRepository(root, release('11.0.0', '2026-09-30T14:07:51.959Z'), {
          now: new Date(iso),
        });
      expect((await at('2026-10-14T14:07:51.958Z')).findings[0].severity).toBe('warning');
      expect((await at('2026-10-14T14:07:51.959Z')).findings[0].severity).toBe('error');
      const custom = await inspectRepository(root, release('11.0.0', '2026-09-30T14:07:51.959Z'), {
        graceDays: 0,
        now: new Date('2026-09-30T14:07:51.959Z'),
      });
      expect(custom.findings[0].severity).toBe('error');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('a range that includes the latest release reports nothing', async () => {
    const root = await repoWith({ '@oxy.so/services': '^11.0.0' });
    try {
      const report = await inspectRepository(root, release('11.0.0', '2026-09-30T14:07:51.959Z'));
      expect(report.findings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('a release without a publish time fails instead of passing silently', async () => {
    const root = await repoWith({ '@oxy.so/services': '^10.0.0' });
    try {
      await expect(inspectRepository(root, release('11.0.0', undefined))).rejects.toThrow(
        'no publish time',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('reads the root, its workspaces and its catalog, never a manifest outside them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oxy-doctor-'));
    const manifest = async (dir, contents) => {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, dir, 'package.json'), JSON.stringify(contents));
    };
    try {
      await manifest('.', {
        name: 'app',
        workspaces: { packages: ['packages/*'], catalog: { '@oxy.so/core': '1.0.0' } },
      });
      await manifest('packages/web', {
        dependencies: { '@oxy.so/core': 'catalog:', '@oxy.so/bloom': '1.0.0' },
      });
      await manifest('docs/audits/inputs', { dependencies: { '@oxy.so/bloom': '0.1.0' } });
      await writeFile(join(root, 'bun.lock'), '{}');
      const report = await inspectRepository(root, release('2.0.0', '2026-09-30T14:07:51.959Z'));
      expect(
        report.findings.map(({ package: name, manifest: path, section }) => [name, path, section]),
      ).toEqual(
        expect.arrayContaining([
          ['@oxy.so/core', 'package.json', 'catalog'],
          ['@oxy.so/bloom', 'packages/web/package.json', 'dependencies'],
        ]),
      );
      expect(report.findings).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  describe('required native peers of @oxy.so/services', () => {
    const SERVICES = {
      name: '@oxy.so/services',
      version: '13.5.0',
      peerDependencies: {
        'expo-crypto': '>=15.0.0 <59.0.0',
        'expo-secure-store': '>=15.0.0 <59.0.0',
        'expo-haptics': '>=15.0.0 <59.0.0',
        zustand: '^5.0.0',
      },
      peerDependenciesMeta: { 'expo-haptics': { optional: true } },
    };
    /** A repo with `frontend` on services and the given packages installed at the root. */
    async function appRepo(frontendDependencies, installed) {
      const root = await mkdtemp(join(tmpdir(), 'oxy-doctor-'));
      const write = async (dir, file, contents) => {
        await mkdir(join(root, dir), { recursive: true });
        await writeFile(join(root, dir, file), contents);
      };
      await write(
        '.',
        'package.json',
        JSON.stringify({ name: 'app', workspaces: { packages: ['packages/*'] } }),
      );
      await write(
        'packages/frontend',
        'package.json',
        JSON.stringify({ dependencies: { expo: '~58.0.14', ...frontendDependencies } }),
      );
      await writeFile(join(root, 'bun.lock'), '{}');
      for (const [name, kind] of Object.entries(installed)) {
        const dir = join('node_modules', name);
        await write(
          dir,
          'package.json',
          JSON.stringify(name === '@oxy.so/services' ? SERVICES : { name }),
        );
        if (kind === 'expo') await write(dir, 'expo-module.config.json', '{}');
        if (kind === 'android') await mkdir(join(root, dir, 'android'), { recursive: true });
      }
      return root;
    }
    const current = release('13.5.0', '2026-10-24T00:00:00.000Z');

    test('a missing required native peer is an error that names the install line', async () => {
      const root = await appRepo(
        { '@oxy.so/services': '^13.5.0', 'expo-secure-store': '~58.0.2' },
        {
          '@oxy.so/services': 'js',
          'expo-crypto': 'expo',
          'expo-secure-store': 'expo',
          'expo-haptics': 'expo',
          zustand: 'js',
        },
      );
      try {
        const report = await inspectRepository(root, current);
        expect(report.findings).toEqual([
          expect.objectContaining({
            severity: 'error',
            code: 'undeclared-native-peer',
            manifest: 'packages/frontend/package.json',
            missing: ['expo-crypto'],
          }),
        ]);
        expect(report.findings[0].message).toContain('npx expo install expo-crypto');
        expect(report.nativePeersUnverified).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test('declared peers, optional ones and JS-only ones report nothing', async () => {
      const root = await appRepo(
        {
          '@oxy.so/services': '^13.5.0',
          'expo-crypto': '~58.0.7',
          'expo-secure-store': '~58.0.2',
        },
        {
          '@oxy.so/services': 'js',
          'expo-crypto': 'android',
          'expo-secure-store': 'expo',
          'expo-haptics': 'expo',
          zustand: 'js',
        },
      );
      try {
        expect((await inspectRepository(root, current)).findings).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test('a required peer that is not installed at all is reported too', async () => {
      const root = await appRepo(
        { '@oxy.so/services': '^13.5.0', 'expo-secure-store': '~58.0.2' },
        { '@oxy.so/services': 'js', 'expo-secure-store': 'expo', zustand: 'js' },
      );
      try {
        const [finding] = (await inspectRepository(root, current)).findings;
        expect(finding.missing).toEqual(['expo-crypto']);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test('without an install the manifest is unverified, not passed', async () => {
      const root = await appRepo({ '@oxy.so/services': '^13.5.0' }, {});
      try {
        const report = await inspectRepository(root, current);
        expect(report.findings).toEqual([]);
        expect(report.nativePeersUnverified).toEqual(['packages/frontend/package.json']);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test('a manifest that is not an Expo or React Native app is not checked', async () => {
      const root = await appRepo({ '@oxy.so/services': '^13.5.0' }, { '@oxy.so/services': 'js' });
      try {
        await writeFile(
          join(root, 'package.json'),
          JSON.stringify({
            name: 'app',
            workspaces: { packages: [] },
            dependencies: { '@oxy.so/services': '^13.5.0' },
          }),
        );
        const report = await inspectRepository(root, current);
        expect(report.findings).toEqual([]);
        expect(report.nativePeersUnverified).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    test('recognises a native module by its autolinking markers', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'oxy-doctor-pkg-'));
      try {
        expect(isNativeModulePackage(dir)).toBe(false);
        await writeFile(join(dir, 'Thing.podspec'), '');
        expect(isNativeModulePackage(dir)).toBe(true);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
  test('the default grace window is fourteen days', () => {
    expect(DEFAULT_GRACE_DAYS).toBe(14);
  });
  test('rejects a bad --grace-days', () => {
    const cli = join(import.meta.dir, '../src/cli.mjs');
    const bad = spawnSync(process.execPath, [cli, '--ci', '--grace-days=-1'], { encoding: 'utf8' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('--grace-days must be a non-negative integer');
  });
});
