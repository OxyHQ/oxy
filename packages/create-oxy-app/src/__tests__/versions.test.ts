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

  test('oxyServices matches the current workspace release', () => {
    expect(VERSIONS.oxyServices).toBe(`^${readWorkspaceVersion('services')}`);
  });

  test('oxyCore matches the current workspace release', () => {
    expect(VERSIONS.oxyCore).toBe(`^${readWorkspaceVersion('core')}`);
  });

  test('oxyContracts matches the current workspace release', () => {
    expect(VERSIONS.oxyContracts).toBe(`^${readWorkspaceVersion('contracts')}`);
  });

  test('oxyBloom matches the workspace catalog', () => {
    expect(VERSIONS.oxyBloom).toBe(readWorkspaceCatalogVersion('@oxyhq/bloom'));
  });

  test('oxyAppPreset matches the current workspace release', () => {
    expect(VERSIONS.oxyAppPreset).toBe(`^${readWorkspaceVersion('app-preset')}`);
  });

  test('scaffold smoke consumes every generated Oxy workspace package from a HEAD tarball', () => {
    const workflowPath = path.join(__dirname, '..', '..', '..', '..', '.github', 'workflows', 'scaffold-smoke.yml');
    const workflow = readFileSync(workflowPath, 'utf8');

    for (const pkg of ['contracts', 'core', 'services', 'app-preset']) {
      expect(workflow).toContain(`packages/${pkg}/**`);
      expect(workflow).toContain(`packages/$package`);
      expect(workflow).toContain(`@oxyhq/${pkg}`);
      expect(workflow).toContain(`oxyhq-${pkg}-`);
    }
  });
});
