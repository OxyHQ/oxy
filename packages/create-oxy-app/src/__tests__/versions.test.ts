import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { VERSIONS } from '../versions';

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..');
const SMOKE_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'scaffold-smoke.yml');

/** The version each pinned Oxy package carries in THIS workspace. */
function readWorkspacePackageVersion(dir: string): string {
  const manifest = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'packages', dir, 'package.json'), 'utf8'),
  ) as {
    version: string;
  };
  return manifest.version;
}

/** `[major, minor, patch]` of a caret range's floor — `^1.7.1` → `[1, 7, 1]` —
 * and whether it is a prerelease (`11.2.0-oxy-one.0` is a workspace candidate). */
function floorOf(range: string): { core: [number, number, number]; prerelease: boolean } {
  const match = /^[\^~]?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(range);
  if (!match) throw new Error(`not a plain semver range: ${range}`);
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] !== undefined,
  };
}

/** Negative when `a` sorts below `b`; a prerelease sorts below its release. */
function compareVersions(a: string, b: string): number {
  const [x, y] = [floorOf(a), floorOf(b)];
  return (
    x.core[0] - y.core[0] ||
    x.core[1] - y.core[1] ||
    x.core[2] - y.core[2] ||
    Number(y.prerelease) - Number(x.prerelease)
  );
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

    expect(
      Object.values(manifest.dependencies ?? {}).filter((range) => range.startsWith('workspace:')),
    ).toEqual([]);
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

  // A pin names a version that has been PUBLISHED, and a package cannot publish a
  // version this repo has never reached — so a pin above its workspace version is
  // unresolvable no matter what the registry says, and provably so offline. This
  // is what catches a pin left on a pre-rename number: `@oxy.so/core` was
  // `@oxyhq/core` through 23.x and reset to 1.x at the rename, so `^23.3.0` was
  // E404 for every app generated since. A pin BELOW its workspace version is
  // fine and deliberate — that is the normal publish lag, and `oxyServices` sat a
  // major behind on purpose while services 3 was unpublished.
  test('no Oxy pin names a version above what this workspace has reached', () => {
    const pinned: Array<[string, string, string]> = [
      ['oxyServices', VERSIONS.oxyServices, 'services'],
      ['oxyCore', VERSIONS.oxyCore, 'core'],
      ['oxyContracts', VERSIONS.oxyContracts, 'contracts'],
      ['oxyAppPreset', VERSIONS.oxyAppPreset, 'app-preset'],
      ['oxyDb', VERSIONS.oxyDb, 'db'],
    ];

    for (const [alias, range, dir] of pinned) {
      const workspaceVersion = readWorkspacePackageVersion(dir);
      const verdict = `${alias} ${range} vs packages/${dir}@${workspaceVersion}`;
      expect({ verdict, ahead: compareVersions(range, workspaceVersion) > 0 }).toEqual({
        verdict,
        ahead: false,
      });
    }
  });

  test('scaffold smoke resolves the generated ranges against the public registry', () => {
    // The nightly smoke overrides every Oxy dependency with a HEAD tarball, so
    // only this check sees the ranges a real `bun create oxy-app` resolves — and
    // only if it runs BEFORE the overrides.
    const workflow = readFileSync(SMOKE_WORKFLOW, 'utf8');
    const script = 'packages/create-oxy-app/scripts/assert-oxy-ranges-resolve.mjs';

    expect(readFileSync(path.join(REPO_ROOT, script), 'utf8')).toContain('npm');
    expect(workflow).toContain(script);
    expect(workflow.indexOf(script)).toBeLessThan(
      workflow.indexOf('Install the generated app with packed Oxy HEAD dependencies'),
    );
  });

  test('published Bloom pin is not ahead of the workspace; its Services peer is checked against npm', () => {
    expect(
      compareVersions(VERSIONS.oxyBloom, readWorkspaceCatalogVersion('@oxy.so/bloom')),
    ).toBeLessThanOrEqual(0);
    const script = readFileSync(
      path.join(REPO_ROOT, 'packages/create-oxy-app/scripts/assert-oxy-ranges-resolve.mjs'),
      'utf8',
    );
    expect(script).toContain('await assertPublishedBloomPair(resolved');
  });

  test('HEAD smoke pairs packed Services with the workspace Bloom catalog, not the published snapshot', () => {
    const workflow = readFileSync(SMOKE_WORKFLOW, 'utf8');
    expect(workflow).toContain('workspace.workspaces.catalog["@oxy.so/bloom"]');
    expect(workflow).toContain('p.overrides["@oxy.so/bloom"] = bloom');
    expect(workflow).toContain('p.resolutions["@oxy.so/bloom"] = bloom');
  });

  test('scaffold smoke consumes every generated Oxy workspace package from a HEAD tarball', () => {
    const workflowPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '.github',
      'workflows',
      'scaffold-smoke.yml',
    );
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
