import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
// The same classification `oxy-doctor` applies to a generated app.
import { isNativeModulePackage } from '../../../doctor/src/checks.mjs';

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const SERVICES_ROOT = path.join(REPO_ROOT, 'packages', 'services');
const TEMPLATE = path.join(
  __dirname,
  '..',
  '..',
  'templates',
  'base',
  'packages',
  'frontend',
  'package.json.tpl',
);

interface Manifest {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function installedDir(name: string, from: string): string | null {
  let dir = from;
  while (true) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

describe('the generated frontend', () => {
  test('declares every required native peer of @oxy.so/services', () => {
    // Expo's autolinking skips optional peers, and a native module the app does
    // not declare is installed at whatever version the package manager picks:
    // Allo shipped an Android release without expo-crypto and lost the CSPRNG.
    const services = JSON.parse(
      readFileSync(path.join(SERVICES_ROOT, 'package.json'), 'utf8'),
    ) as Manifest;
    const template = JSON.parse(readFileSync(TEMPLATE, 'utf8')) as Manifest;
    const declared = new Set(Object.keys(template.dependencies ?? {}));
    const requiredNative = Object.keys(services.peerDependencies ?? {})
      .filter((name) => services.peerDependenciesMeta?.[name]?.optional !== true)
      .filter((name) => {
        const dir = installedDir(name, SERVICES_ROOT);
        return dir !== null && isNativeModulePackage(dir);
      });

    expect(requiredNative).toEqual(expect.arrayContaining(['expo-crypto', 'expo-secure-store']));
    expect(requiredNative.filter((name) => !declared.has(name))).toEqual([]);
  });
});
