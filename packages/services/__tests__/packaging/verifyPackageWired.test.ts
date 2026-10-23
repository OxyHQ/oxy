/**
 * `scripts/verify-package.mjs` must be reachable from the build, not merely
 * present.
 *
 * A verifier nobody invokes reports nothing, and reports it in exactly the shape
 * of success — which is the same failure it was written to catch one level up
 * (`@oxy.so/services@30.0.0` shipped with no `lib/`, and every check that ran was
 * green because it was reading `src/`). Deleting the `postbuild` entry, renaming
 * the script without moving the file, or a release that packs without running
 * `build` would each disarm it silently; this file makes all three red.
 *
 * The one way a package leaves is the shared release workflow
 * (`.github/workflows/npm-release.yml`, docs/engineering/package-rules.md#publishing):
 * its build job runs each released package's `build` once, then
 * `release-package.mjs pack` packs that tree. There is no `release` script any
 * more, and a new one would be a second way out that nothing here checks.
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

  it('is released only by the shared workflow, which builds before it packs', () => {
    // The release tool packs whatever tree it is handed, so the release has to
    // run the package's `build` script (the one `postbuild` hangs off, never a
    // partial `build:js`) in the same job, before `pack`.
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/npm-release.yml'),
      'utf8',
    );
    expect(workflow).toMatch(/RELEASE_PACKAGE: .*\/\.github\/scripts\/release-package\.mjs$/m);
    const build = workflow.search(/bun run --if-present build\b(?![:\w])/);
    const pack = workflow.search(/"\$RELEASE_PACKAGE" pack\b/);
    expect(build).toBeGreaterThan(-1);
    expect(pack).toBeGreaterThan(build);

    // No laptop path: a `release` script would be a way out this file does not check.
    expect(manifest.scripts.release).toBeUndefined();
  });
});
