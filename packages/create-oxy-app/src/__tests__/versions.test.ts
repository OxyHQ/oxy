import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { VERSIONS } from '../versions';

function readWorkspaceVersion(pkg: string): string {
  const manifestPath = path.join(__dirname, '..', '..', '..', pkg, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string };
  return manifest.version;
}

function readWorkspaceCatalogVersion(pkg: string): string {
  const manifestPath = path.join(__dirname, '..', '..', '..', '..', 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    workspaces: { catalog: Record<string, string> };
  };
  return manifest.workspaces.catalog[pkg];
}

describe('VERSIONS drift guard', () => {
  test('the published CLI has no workspace runtime dependencies', () => {
    const manifestPath = path.join(__dirname, '..', '..', 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(Object.values(manifest.dependencies ?? {}).filter((range) => range.startsWith('workspace:'))).toEqual([]);
  });

  test('oxyServices matches packages/services major', () => {
    const workspaceVersion = readWorkspaceVersion('services');
    const major = workspaceVersion.split('.')[0];
    expect(VERSIONS.oxyServices).toBe(`^${major}.0.0`);
  });

  test('oxyCore matches packages/core major', () => {
    const workspaceVersion = readWorkspaceVersion('core');
    const major = workspaceVersion.split('.')[0];
    expect(VERSIONS.oxyCore).toBe(`^${major}.0.0`);
  });

  test('oxyBloom matches the workspace catalog', () => {
    expect(VERSIONS.oxyBloom).toBe(readWorkspaceCatalogVersion('@oxyhq/bloom'));
  });

  test('oxyContracts matches packages/contracts major.minor', () => {
    const workspaceVersion = readWorkspaceVersion('contracts');
    const [major, minor] = workspaceVersion.split('.');
    expect(VERSIONS.oxyContracts).toBe(`^${major}.${minor}.0`);
  });
});
