/**
 * The root barrel must never reach `expo-notifications`.
 *
 * `expo-notifications` and `expo-constants` are OPTIONAL peer dependencies, but
 * `tsc` resolves the specifier of an `import()` even when the call is lazy and
 * wrapped in try/catch. So the moment ANY module reachable from `src/index.ts`
 * names one of them, every consumer of this package is forced to install it or
 * fail to type-check with TS2307 — regardless of whether that consumer has any
 * interest in push. That is exactly the regression this file exists to catch:
 * it shipped once (22.13.x) and broke consumers that use no notifications at
 * all. The adapter now lives behind the `@oxyhq/services/notifications` entry
 * point, and this test is what keeps it there.
 *
 * The check walks the REAL module graph rather than grepping `src/index.ts`,
 * because the failure mode is transitive: re-exporting the adapter from any
 * intermediate module would reintroduce the defect while leaving the barrel
 * itself looking clean.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '../../src');
const BARREL = join(SRC, 'index.ts');

/**
 * Specifiers that must not be reachable from the root barrel.
 *
 * Scoped to the two the notifications adapter owns. The other optional expo
 * peers (`expo-image-picker`, `expo-document-picker`, …) ARE legitimately
 * reachable from the barrel today because the UI screens that use them are core
 * to the SDK, so listing them here would fail for a different, unrelated reason.
 */
const FORBIDDEN = ['expo-notifications', 'expo-constants'] as const;

/**
 * The lowest plausible size of the barrel's module graph.
 *
 * A vacuity floor: without it, a traversal that silently resolved nothing (a
 * changed extension convention, a bad join) would report "no forbidden
 * specifier reachable" and pass while checking nothing at all.
 */
const MIN_REACHABLE_FILES = 100;

const EXTENSIONS = ['.ts', '.tsx', '.native.ts', '.native.tsx', '.web.ts', '.web.tsx'];

/** Resolve a relative specifier to a concrete file on disk, or `null`. */
function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const extension of EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsFile(candidate)) {
      return candidate;
    }
  }
  for (const extension of EXTENSIONS) {
    const candidate = join(base, `index${extension}`);
    if (existsFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

function existsFile(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Every specifier this file imports, exports-from, or dynamically imports. */
function specifiersOf(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      found.push(match[1]);
    }
  }
  return found;
}

interface Reachable {
  /** Every file reachable from the barrel. */
  files: Set<string>;
  /** For each reached file, the file that first pulled it in. */
  parents: Map<string, string>;
}

function walkFromBarrel(): Reachable {
  const files = new Set<string>();
  const parents = new Map<string, string>();
  const queue = [BARREL];
  files.add(BARREL);

  while (queue.length > 0) {
    const current = queue.shift() as string;
    const source = readFileSync(current, 'utf8');
    for (const specifier of specifiersOf(source)) {
      if (!specifier.startsWith('.')) {
        continue;
      }
      const next = resolveRelative(current, specifier);
      if (next === null || files.has(next)) {
        continue;
      }
      files.add(next);
      parents.set(next, current);
      queue.push(next);
    }
  }
  return { files, parents };
}

/** The chain from the barrel down to `file`, for a failure message that names names. */
function chainTo(file: string, parents: Map<string, string>): string {
  const chain: string[] = [];
  let cursor: string | undefined = file;
  while (cursor !== undefined) {
    chain.unshift(relative(SRC, cursor));
    cursor = parents.get(cursor);
  }
  return chain.join('\n    -> ');
}

describe('root barrel isolation from the notifications adapter', () => {
  const { files, parents } = walkFromBarrel();

  it(`reaches at least ${MIN_REACHABLE_FILES} files (the traversal is not vacuous)`, () => {
    expect(files.size).toBeGreaterThanOrEqual(MIN_REACHABLE_FILES);
  });

  it('reaches the barrel itself and a known-exported module (the traversal resolves)', () => {
    expect(files).toContain(BARREL);
    expect(files).toContain(join(SRC, 'ui/context/OxyContext.tsx'));
  });

  it.each(FORBIDDEN)('does not reach any module naming %s', (specifier) => {
    const offenders = [...files].filter((file) =>
      specifiersOf(readFileSync(file, 'utf8')).includes(specifier),
    );
    const detail = offenders
      .map((file) => `\n  ${specifier} is named by:\n    ${chainTo(file, parents)}`)
      .join('');
    expect(offenders.length === 0 ? '' : detail).toBe('');
  });

  it('does not reach the notifications adapter at all', () => {
    const adapter = join(SRC, 'notifications/deviceNotifications.ts');
    const reached = files.has(adapter);
    expect(reached ? chainTo(adapter, parents) : 'not reachable').toBe('not reachable');
  });
});
