/**
 * Every `@oxy.so/bloom/…` specifier this package imports must exist in the
 * INSTALLED Bloom's `exports` map.
 *
 * This class of break is invisible to every other gate we run:
 *
 *  - **jest cannot see it.** `jest.config.js` maps `^@oxy.so/bloom/(.*)$` to one
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
 * at import time — a white screen, not a red squiggle. `@oxy.so/bloom/menu` and
 * `@oxy.so/bloom/collapsible` were both deleted in Bloom 1.0.0 and both were
 * still imported here; neither `bun run typescript` nor `bun run test` noticed.
 *
 * Reads the export map rather than calling `require.resolve`, because the
 * specifiers resolve through the `react-native` condition that Jest's resolver
 * is not configured for.
 *
 * An export key may be a subpath PATTERN — Bloom 3.2.0 publishes one glyph per
 * module behind `"./icons/Ri*"` — so a key set alone cannot answer the question.
 * A pattern is matched the way Node matches it (one `*`, longest key wins) and
 * then the substituted TARGET is required to exist on disk, because that is the
 * half that fails: `@oxy.so/bloom/icons/RiNotAGlyph` matches `./icons/Ri*`
 * perfectly and still resolves to a file that is not there.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(PACKAGE_ROOT, 'src');

type ExportMap = { dir: string; entries: Record<string, unknown> };

/** `@oxy.so/bloom`'s manifest, from wherever this package actually resolves it. */
function readBloomExports(): ExportMap {
  const manifestPath = require.resolve('@oxy.so/bloom/package.json', { paths: [PACKAGE_ROOT] });
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  return { dir: path.dirname(manifestPath), entries: manifest.exports ?? {} };
}

/** Every file path an export target can resolve to, across all conditions. */
function targetPaths(target: unknown): string[] {
  if (typeof target === 'string') return [target];
  if (Array.isArray(target)) return target.flatMap(targetPaths);
  if (target && typeof target === 'object') return Object.values(target).flatMap(targetPaths);
  return [];
}

/**
 * Does the installed Bloom really serve this subpath? Exact key first, then the
 * pattern keys, longest-prefix first, as Node does — and a pattern only counts
 * when a file it substitutes to is actually on disk.
 */
function resolvesAgainst({ dir, entries }: ExportMap, subpath: string): boolean {
  if (Object.hasOwn(entries, subpath)) return true;

  const patterns = Object.keys(entries)
    .filter((key) => key.split('*').length === 2)
    .sort((a, b) => b.indexOf('*') - a.indexOf('*'));

  for (const key of patterns) {
    const [prefix, suffix] = key.split('*');
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    if (subpath.length < prefix.length + suffix.length) continue;
    const star = subpath.slice(prefix.length, subpath.length - suffix.length);
    // EVERY `*` in the target, not the first. A pattern KEY may hold only one,
    // but Node substitutes the match into every occurrence in the target, and a
    // gate that models the resolver loosely is a gate that passes a specifier
    // the resolver would reject.
    const served = targetPaths(entries[key]).some((target) =>
      fs.existsSync(path.join(dir, target.split('*').join(star))),
    );
    if (served) return true;
  }
  return false;
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

const SPECIFIER = /['"](@oxy.so\/bloom(?:\/[^'"]*)?)['"]/g;

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
        specifier === '@oxy.so/bloom' ? '.' : `.${specifier.slice('@oxy.so/bloom'.length)}`;
      const where = found.get(subpath) ?? [];
      where.push(path.relative(PACKAGE_ROOT, file));
      found.set(subpath, where);
    }
  }
  return found;
}

describe('every @oxy.so/bloom subpath this package imports exists', () => {
  const exported = readBloomExports();
  const imported = collectSubpaths();

  // Floors. A scan that read nothing reports the same clean pass as a scan that
  // read everything and found no problem, so pin both sides to a real number.
  it('the scan actually read Bloom and this package', () => {
    expect(Object.keys(exported.entries).length).toBeGreaterThan(50);
    expect(imported.size).toBeGreaterThan(10);
    // A known-present subpath, so a wholesale regex failure cannot pass as clean.
    expect(imported.has('./surfaces')).toBe(true);
    // A glyph subpath, so a pattern matcher that quietly stopped working cannot
    // pass as clean either — this is how every icon in this package resolves.
    expect(imported.has('./icons/RiSparklingLine')).toBe(true);
  });

  // Metro retains the entire barrel: ProfileButton once pulled 465 icon
  // modules into Mention's common chunk just to draw login and overflow.
  it('imports icons through public glyph subpaths instead of the collection barrel', () => {
    const runtimeBarrels = (imported.get('./icons') ?? []).filter((file) => {
      const source = ts.createSourceFile(file, fs.readFileSync(path.join(PACKAGE_ROOT, file), 'utf8'), ts.ScriptTarget.Latest);
      return source.statements.some((statement) =>
        ts.isImportDeclaration(statement)
        && !statement.importClause?.isTypeOnly
        && ts.isStringLiteral(statement.moduleSpecifier)
        && statement.moduleSpecifier.text === '@oxy.so/bloom/icons',
      );
    });
    expect(runtimeBarrels).toEqual([]);
  });

  it('resolves every imported subpath against the installed export map', () => {
    const missing = [...imported.entries()]
      .filter(([subpath]) => !resolvesAgainst(exported, subpath))
      .map(([subpath, where]) => `${subpath} <- ${where.join(', ')}`);

    expect(missing).toEqual([]);
  });

  // The pattern branch has to be able to say no, or it is not a gate. Node would
  // fail this specifier at read time; so must we, before it reaches a consumer.
  it('refuses a glyph subpath that matches the pattern but has no file', () => {
    expect(resolvesAgainst(exported, './icons/RiNotAGlyphThatExists')).toBe(false);
  });
});
