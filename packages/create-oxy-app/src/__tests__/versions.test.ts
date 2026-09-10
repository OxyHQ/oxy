import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { VERSIONS } from '../versions';

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

  test('Oxy SDK dependencies use publishable semver ranges', () => {
    for (const version of [
      VERSIONS.oxyServices,
      VERSIONS.oxyCore,
      VERSIONS.oxyContracts,
      VERSIONS.oxyAppPreset,
      VERSIONS.oxyDb,
    ]) {
      expect(version).toMatch(/^\^\d+\.\d+\.\d+$/);
    }
  });

  test('oxyBloom matches the workspace catalog', () => {
    expect(VERSIONS.oxyBloom).toBe(readWorkspaceCatalogVersion('@oxy.so/bloom'));
  });

  test('scaffold smoke consumes every generated Oxy workspace package from a HEAD tarball', () => {
    const workflowPath = path.join(__dirname, '..', '..', '..', '..', '.github', 'workflows', 'scaffold-smoke.yml');
    const workflow = readFileSync(workflowPath, 'utf8');

    const tarballPrefixes = {
      contracts: 'oxy\\.so-contracts-',
      core: 'oxy\\.so-core-',
      db: 'oxy\\.so-db-',
      services: 'oxy\\.so-services-',
      'app-preset': 'oxy\\.so-app-preset-',
    } as const;

    for (const [pkg, tarballPrefix] of Object.entries(tarballPrefixes)) {
      expect(workflow).toContain(`packages/${pkg}/**`);
      expect(workflow).toContain(`packages/$package`);
      expect(workflow).toContain(`@oxy.so/${pkg}`);
      expect(workflow).toContain(tarballPrefix);
    }
  });
});
