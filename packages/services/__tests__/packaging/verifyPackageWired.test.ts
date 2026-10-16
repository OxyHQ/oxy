/**
 * `scripts/verify-package.mjs` must be reachable from the build, not merely
 * present.
 *
 * A verifier nobody invokes reports nothing, and reports it in exactly the shape
 * of success — which is the same failure it was written to catch one level up
 * (`@oxy.so/services@30.0.0` shipped with no `lib/`, and every check that ran was
 * green because it was reading `src/`). Deleting the `postbuild` entry, renaming
 * the script without moving the file, switching `prepublishOnly` to the partial
 * `build:js`, or a release that packs without running `build` would each disarm
 * it silently; this file makes all four red.
 *
 * The one way a package leaves is the shared release workflow
 * (`.github/workflows/npm-release.yml`, docs/engineering/package-rules.md#publishing):
 * it runs `prepublishOnly`, then `release-package.mjs pack`, which runs `build`
 * before `bun pm pack` in the build job and again in the publish job's rebuild.
 * There is no `release` script any more, and a new one would be a second way out
 * that nothing here checks.
 *
 * The path is DERIVED from what the script actually runs rather than written out
 * here, so the two cannot agree with each other while disagreeing with the disk.
 */
import fs from 'node:fs';
import path from 'node:path';

const packageRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(packageRoot, '../..');

const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

/** The `.mjs`/`.js` file a script invokes, or null when it invokes none. */
function scriptFileOf(command: string | undefined): string | null {
  if (!command) return null;
  const match = command.match(/(?:^|\s)((?:\.\/)?[\w./-]+\.(?:mjs|cjs|js))(?:\s|$)/);
  return match ? match[1] : null;
}

describe('verify-package is wired into the build', () => {
  it('runs a real file as postbuild', () => {
    const target = scriptFileOf(manifest.scripts.postbuild);

    // Vacuity floor: a null target would make every assertion below trivially
    // satisfiable by deleting the postbuild entry.
    expect(target).not.toBeNull();
    expect(fs.existsSync(path.join(packageRoot, target as string))).toBe(true);
  });

  it('exposes the same file under verify:package, for running it standalone', () => {
    expect(scriptFileOf(manifest.scripts['verify:package'])).toBe(
      scriptFileOf(manifest.scripts.postbuild),
    );
  });

  it('builds on the publish paths that run scripts at all', () => {
    // `npm publish <tgz>` and `bun publish <tgz>` run NO lifecycle scripts
    // (measured — docs/engineering/package-rules.md), so a tarball is only ever
    // as good as the build that produced it. On the paths that DO run scripts,
    // `build` has to be one of them or `postbuild` never fires.
    //
    // The negative lookahead is load-bearing: a plain substring match for
    // "bun run build" is also satisfied by "bun run build:js", which is the
    // partial build the next case exists to refuse.
    const runsFullBuild = /bun run build(?![:\w])/;
    expect(manifest.scripts.prepublishOnly).toMatch(runsFullBuild);
  });

  it('is released only by the shared workflow, which runs prepublishOnly and build', () => {
    // The release tool packs whatever tree it is handed, so the build has to be
    // in the same command as the pack: `pack` runs the package's `build` script
    // (the one `postbuild` hangs off, never `build:js`) before `bun pm pack`.
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/npm-release.yml'),
      'utf8',
    );
    const releaseTool = fs.readFileSync(
      path.join(repoRoot, '.github/scripts/release-package.mjs'),
      'utf8',
    );
    expect(workflow).toMatch(/bun run prepublishOnly\b/);
    expect(workflow).toMatch(/RELEASE_PACKAGE: .*\/\.github\/scripts\/release-package\.mjs$/m);
    expect(workflow).toMatch(/"\$RELEASE_PACKAGE" pack\b/);
    expect(releaseTool).toMatch(/\[\s*'run',\s*(?:'--if-present',\s*)?'build'\s*\]/);

    // No laptop path: a `release` script would be a way out this file does not check.
    expect(manifest.scripts.release).toBeUndefined();
  });

  it('does not release through the partial build', () => {
    // `build:js` skips the typescript target — the exact tree whose absence is
    // invisible to Metro and fatal to everyone else.
    expect(manifest.scripts.prepublishOnly).not.toContain('build:js');
  });
});
