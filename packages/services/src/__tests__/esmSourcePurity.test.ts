/**
 * `@oxyhq/services` ships an ESM build, and ESM has no `require`.
 *
 * This is not a style rule: a surviving `require()` puts web bundlers into
 * CommonJS interop, which hands consumers `undefined` bindings with no build
 * error and no warning. It blanked auth.oxy.so/authorize once — see the note on
 * `screenComponents` in `../ui/navigation/routes` for the mechanism, and
 * `README.md` for the incident.
 *
 * Deferring is still legitimate: a thunk over a static import defers a READ,
 * `import()` defers a LOAD. Neither needs `require()`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_ROOT = join(__dirname, '..');

/** Source extensions that end up in the published ESM build. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx'];

/** Tests are compiled to CommonJS by ts-jest and never ship, so they are exempt. */
const EXEMPT_SEGMENTS = ['__tests__'];

function collectSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (EXEMPT_SEGMENTS.includes(entry)) continue;
      found.push(...collectSourceFiles(path));
      continue;
    }
    if (SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext)) && !path.endsWith('.d.ts')) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Drop comments and string/template literals so prose about `require()` — such
 * as the notes explaining this very rule — is not mistaken for a call.
 */
function stripCommentsAndStrings(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

describe('ESM source purity', () => {
  it('never calls require() anywhere in the shipped source', () => {
    const offenders = collectSourceFiles(SRC_ROOT)
      .filter((file) => /\brequire\s*\(/.test(stripCommentsAndStrings(readFileSync(file, 'utf8'))))
      .map((file) => relative(SRC_ROOT, file));

    expect(offenders).toEqual([]);
  });
});
