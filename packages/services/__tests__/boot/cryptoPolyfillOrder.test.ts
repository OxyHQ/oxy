/**
 * An app that imports `@oxy.so/services` before `@oxy.so/core` (Commons'
 * `app/_layout.tsx` does) must still get core's crypto polyfill installed
 * before any `@noble/*` module evaluates.
 *
 * `@noble/hashes` 1.x captures `globalThis.crypto` once, when its `crypto.js`
 * is evaluated, and Hermes has no `globalThis.crypto` at startup. Core's entry
 * installs the shim before anything else (guarded behaviourally by
 * `packages/core/src/crypto/__tests__/polyfillOrder.test.ts`), so services is
 * safe exactly as long as (1) its entry evaluates `@oxy.so/core` before any
 * other module, and (2) nothing in services reaches a capturing crypto library
 * except through core.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC_DIR = resolve(__dirname, '..', '..', 'src');

/** Packages that evaluate `@noble/hashes` without going through core's entry. */
const CRYPTO_LIBRARY = /^(?:@noble\/|@scure\/|@oxy\.so\/protocol(?:\/|$))/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === '__tests__' ? [] : sourceFiles(path);
    }
    return /\.(?:ts|tsx)$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Value-level specifiers (type-only imports are erased and never evaluated). */
function valueSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[^;]*?\sfrom\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[1]));
}

describe('crypto polyfill order through @oxy.so/services', () => {
  it('the services entry evaluates @oxy.so/core before any other module', () => {
    const entry = readFileSync(join(SRC_DIR, 'index.ts'), 'utf8');
    const first = entry.match(/^(?:import|export)\s(?!type\s)[^;]*?['"]([^'"]+)['"]/m);
    expect(first?.[1]).toBe('@oxy.so/core');
  });

  it('no services module reaches a crypto library except through core', () => {
    const offenders = sourceFiles(SRC_DIR).flatMap((file) =>
      valueSpecifiers(readFileSync(file, 'utf8'))
        .filter((specifier) => CRYPTO_LIBRARY.test(specifier))
        .map((specifier) => `${file.slice(SRC_DIR.length + 1)} imports '${specifier}'`),
    );
    expect(offenders).toEqual([]);
  });
});
