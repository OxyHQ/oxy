import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { Icons } from '@/constants/icons';

const ROOT = resolve(__dirname, '..', '..');
const SOURCE_DIRS = ['app', 'components', 'hooks', 'lib', 'constants', 'utils'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

const FILES = SOURCE_DIRS.flatMap((dir) => {
  const path = join(ROOT, dir);
  try {
    return statSync(path).isDirectory() ? sourceFiles(path) : [];
  } catch {
    return [];
  }
}).map((path) => [path.slice(ROOT.length + 1), readFileSync(path, 'utf8')] as const);

/** Import statements only — a path named in a comment is documentation, not a dependency. */
function importsOf(source: string): string[] {
  return [...source.matchAll(/(?:from|import|require\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

describe('import hygiene', () => {
  it('finds the source tree it is meant to be guarding', () => {
    // A vacuity floor: every assertion below passes trivially against an empty
    // list, and a moved directory would make this file silently stop working.
    expect(FILES.length).toBeGreaterThan(90);
  });

  it('draws no glyph from @expo/vector-icons', () => {
    // The app used to draw MaterialCommunityIcons, which ships a 1,307,660-byte
    // TTF — measured as 44% of its iOS assets, for 76 glyph sites. Dropping it
    // is ALL-OR-NOTHING: one import anywhere brings the whole font back.
    // `@expo/vector-icons` stays in package.json because `@oxy.so/services`
    // peers it; it is this app drawing from it that must not come back.
    const offenders = FILES.filter(([, source]) =>
      importsOf(source).some((specifier) => specifier.startsWith('@expo/vector-icons')),
    ).map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('imports Bloom by subpath, never through the root barrel', () => {
    // Metro does not tree-shake, so `from '@oxy.so/bloom'` pulls the library in
    // to reach one function. Eight files did this for `alert` and `toast`.
    const offenders = FILES.filter(([, source]) =>
      importsOf(source).includes('@oxy.so/bloom'),
    ).map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('imports each glyph from its own subpath, never the icons barrel', () => {
    // `@oxy.so/bloom/icons` is a flat barrel over 461 glyphs: naming one bundles
    // all of them (Bloom measured 318,869 B against 7,406 B for twelve
    // subpaths). `@oxy.so/bloom/icons/Ri*` is the shape that ships one.
    const offenders = FILES.filter(([, source]) =>
      importsOf(source).includes('@oxy.so/bloom/icons'),
    ).map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

describe('the glyph vocabulary', () => {
  it('is reached only through constants/icons', () => {
    // One file owns the per-glyph subpath imports, so the rule above has one
    // place to hold rather than thirty-four.
    const offenders = FILES.filter(
      ([path, source]) =>
        path !== 'constants/icons.tsx' &&
        importsOf(source).some((specifier) => specifier.startsWith('@oxy.so/bloom/icons/')),
    ).map(([path]) => path);
    expect(offenders).toEqual(['components/CommonsTabBar.tsx']);
  });

  it('is not reached by a name nothing renders', () => {
    // A weaker claim than "no unused entry", ON PURPOSE. Several icons are
    // DATA — `SOURCE_ICON` in StandingSection keys them by reputation source,
    // `ACTION_META` in reputation-activity by civic action — so the name never
    // appears next to the word "icon" and a textual usage check cannot see it.
    // A gate that reports those as dead would be wrong, and a wrong gate is
    // worse than none. What IS checkable: every name the app writes has to
    // exist in the vocabulary, which is what stops a typo becoming an
    // `undefined` component at render time. `tsc` already proves this for
    // anything typed `IconName`; this covers the `Icons.<name>` member form.
    const names = new Set(Object.keys(Icons));
    const unknown = new Set<string>();
    for (const [path, source] of FILES) {
      if (path === 'constants/icons.tsx') continue;
      for (const m of source.matchAll(/\bIcons\.([a-zA-Z]+)/g)) {
        if (!names.has(m[1])) unknown.add(`${path}: Icons.${m[1]}`);
      }
    }
    expect([...unknown]).toEqual([]);
  });
});
});
