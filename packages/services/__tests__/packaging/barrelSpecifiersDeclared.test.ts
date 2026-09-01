/**
 * Every bare specifier reachable from the root barrel must be DECLARED.
 *
 * `tsc` resolves the specifier of an `import()` even when the call is lazy and
 * wrapped in try/catch, so anything the barrel can reach lands in every
 * consumer's type graph. An undeclared specifier there does not fail here — it
 * fails in the consumer, as `TS2307`, and only for consumers that happen not to
 * have the package installed for their own reasons. That is why this is a gate
 * rather than a convention: it works by accident until it doesn't.
 *
 * `expo-web-browser` was exactly that. `ui/components/oauthNavigation.ts` does
 * `await import('expo-web-browser')`, `OxySignInButton` and `OxyContext` import
 * that module, and the barrel exports both — while the package declared it in
 * neither `dependencies`, `devDependencies` nor `peerDependencies`.
 */
import fs from 'node:fs';
import path from 'node:path';

const packageRoot = path.resolve(__dirname, '../..');
const srcRoot = path.join(packageRoot, 'src');

const manifest = JSON.parse(
  fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
) as Record<string, Record<string, string> | undefined>;

const declared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]);

/** Node builtins and self-references are never declared and never should be. */
const IGNORED_PREFIXES = ['node:', '@oxyhq/services'];

/**
 * Specifiers reached only through a RUNTIME-COMPUTED string
 * (`const m = 'expo-secure-store'; await import(m)`) are invisible to this walk
 * by the same mechanism that makes them invisible to `tsc` and Metro — which is
 * the point of writing them that way. They are listed so the omission is a
 * decision rather than a blind spot.
 */
const RUNTIME_COMPUTED_SPECIFIERS = new Set(['expo-secure-store']);

function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (IGNORED_PREFIXES.some((p) => specifier.startsWith(p))) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

function readModule(fromDir: string, specifier: string): string | null {
  const base = path.resolve(fromDir, specifier);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Static imports/re-exports AND dynamic `import()` — the last is the whole point. */
const SPECIFIER_RE =
  /(?:import|export)\s+(?:[^'"]*?from\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * Comments are removed before the scan, because prose reads as code to the
 * regex above.
 *
 * `[^'"]*?` spans newlines, so any `export` earlier in a file, followed by the
 * word "from" anywhere in a later comment, followed by a quoted phrase, matches
 * — and the phrase is then reported as an undeclared package. A doc comment
 * reading `Distinct from "not following"` did exactly that, and the failure
 * names a package nobody imported, which is the most confusing shape a gate can
 * fail in.
 *
 * Stripping comments narrows what the gate can SEE, never what it enforces: a
 * specifier inside a comment is not an import, and `tsc` does not resolve it.
 */
function stripComments(source: string): string {
  // Replace with a space rather than nothing, so two tokens either side of a
  // removed comment cannot fuse into a third thing the regex then matches.
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function walkFromBarrel(): { external: Set<string>; visitedCount: number } {
  const entry = path.join(srcRoot, 'index.ts');
  const queue = [entry];
  const visited = new Set<string>();
  const external = new Set<string>();

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (visited.has(file)) continue;
    visited.add(file);

    const source = stripComments(fs.readFileSync(file, 'utf8'));
    const dir = path.dirname(file);
    for (const match of source.matchAll(SPECIFIER_RE)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      if (specifier.startsWith('.')) {
        const resolved = readModule(dir, specifier);
        if (resolved) queue.push(resolved);
        continue;
      }
      const name = packageNameOf(specifier);
      if (name) external.add(name);
    }
  }

  return { external, visitedCount: visited.size };
}

describe('barrel-reachable specifiers are declared', () => {
  const { external, visitedCount } = walkFromBarrel();

  it('walks a non-trivial module graph', () => {
    // Vacuity floor. A broken resolver would otherwise report an empty graph and
    // pass, which is the failure mode this whole file exists to prevent.
    expect(visitedCount).toBeGreaterThan(50);
    expect(external.size).toBeGreaterThan(10);
  });

  it('declares every external package the barrel can reach', () => {
    const undeclared = [...external]
      .filter((name) => !declared.has(name))
      .filter((name) => !RUNTIME_COMPUTED_SPECIFIERS.has(name))
      .sort();

    expect(undeclared).toEqual([]);
  });

  it('reaches expo-web-browser, and it is declared', () => {
    // The specific regression. Kept separate so a failure names the package
    // rather than only showing it inside a list.
    expect(external.has('expo-web-browser')).toBe(true);
    expect(declared.has('expo-web-browser')).toBe(true);
  });
});
