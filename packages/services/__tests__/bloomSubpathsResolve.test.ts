/**
 * Every `@oxyhq/bloom/…` specifier this package imports must exist in the
 * INSTALLED Bloom's `exports` map.
 *
 * This class of break is invisible to every other gate we run:
 *
 *  - **jest cannot see it.** `jest.config.js` maps `^@oxyhq/bloom/(.*)$` to one
 *    stub file, so a subpath that no longer exists resolves to the stub just as
 *    happily as one that does. Every suite stays green.
 *  - **the package's own `tsc` could not be trusted to see it either.** This
 *    worktree sits inside a checkout that has its own `node_modules`, and
 *    TypeScript walks UP for `node_modules` — so a subpath deleted from the
 *    installed Bloom can still resolve against an older copy in a parent
 *    directory and typecheck clean.
 *
 * What it actually costs: an import of a removed subpath is a hard RESOLUTION
 * failure, not a type error. Metro cannot resolve it, so a consuming app fails
 * at import time — a white screen, not a red squiggle. `@oxyhq/bloom/menu` and
 * `@oxyhq/bloom/collapsible` were both deleted in Bloom 1.0.0 and both were
 * still imported here; neither `bun run typescript` nor `bun run test` noticed.
 *
 * Reads the export map rather than calling `require.resolve`, because the
 * specifiers resolve through the `react-native` condition that Jest's resolver
 * is not configured for.
 */
import fs from 'node:fs';
import path from 'node:path';

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(PACKAGE_ROOT, 'src');

/** `@oxyhq/bloom`'s manifest, from wherever this package actually resolves it. */
function readBloomExports(): Set<string> {
  const manifestPath = require.resolve('@oxyhq/bloom/package.json', { paths: [PACKAGE_ROOT] });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  return new Set(Object.keys(manifest.exports ?? {}));
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SPECIFIER = /['"](@oxyhq\/bloom(?:\/[^'"]*)?)['"]/g;

/** Every distinct Bloom subpath `src/` names, mapped to the files naming it. */
function collectSubpaths(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(SRC_ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    SPECIFIER.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SPECIFIER.exec(text))) {
      const specifier = match[1];
      const subpath =
        specifier === '@oxyhq/bloom' ? '.' : `.${specifier.slice('@oxyhq/bloom'.length)}`;
      const where = found.get(subpath) ?? [];
      where.push(path.relative(PACKAGE_ROOT, file));
      found.set(subpath, where);
    }
  }
  return found;
}

describe('every @oxyhq/bloom subpath this package imports exists', () => {
  const exported = readBloomExports();
  const imported = collectSubpaths();

  // Floors. A scan that read nothing reports the same clean pass as a scan that
  // read everything and found no problem, so pin both sides to a real number.
  it('the scan actually read Bloom and this package', () => {
    expect(exported.size).toBeGreaterThan(50);
    expect(imported.size).toBeGreaterThan(10);
    // A known-present subpath, so a wholesale regex failure cannot pass as clean.
    expect(imported.has('./surfaces')).toBe(true);
  });

  it('resolves every imported subpath against the installed export map', () => {
    const missing = [...imported.entries()]
      .filter(([subpath]) => !exported.has(subpath))
      .map(([subpath, where]) => `${subpath} <- ${where.join(', ')}`);

    expect(missing).toEqual([]);
  });
});
