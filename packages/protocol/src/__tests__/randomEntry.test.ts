/**
 * `@oxy.so/protocol/random` must reach no module other than its own platform
 * files and the optional `expo-crypto` peer.
 *
 * `@oxy.so/core`'s crypto polyfill imports this entry to install
 * `globalThis.crypto.getRandomValues` on React Native. Everything the polyfill
 * imports is evaluated BEFORE the polyfill body, and `@noble/hashes` 1.x
 * captures `globalThis.crypto` once, at evaluation. When the polyfill imported
 * the root entry instead, noble was reached through the envelope signer,
 * captured `undefined`, and every Android identity creation failed with
 * `crypto.getRandomValues must be defined`. This guard keeps the entry's graph
 * dependency-free, including the `.native` siblings Metro substitutes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SRC_DIR = resolve(__dirname, '..');
const RANDOM_ENTRY = join(SRC_DIR, 'random.ts');

/**
 * Every value-level module specifier: static imports/re-exports, literal
 * `require()`s and `import()`s. Comments are stripped first so prose that
 * mentions a module (these files document why they avoid them) is not counted.
 */
function valueSpecifiers(rawSource: string): string[] {
  const source = rawSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s+(?!type\s)[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(source);
    while (match !== null) {
      specifiers.push(match[1]);
      match = pattern.exec(source);
    }
  }
  return specifiers;
}

function resolveRelative(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`unresolved relative import '${specifier}' in ${fromFile}`);
}

function walk(entry: string): { files: string[]; external: string[] } {
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const nativeSibling = file.replace(/\.ts$/, '.native.ts');
    if (!file.endsWith('.native.ts') && existsSync(nativeSibling)) {
      queue.push(nativeSibling);
    }
    for (const specifier of valueSpecifiers(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        queue.push(resolveRelative(file, specifier));
      } else {
        external.add(specifier);
      }
    }
  }
  return { files: [...seen], external: [...external] };
}

describe('@oxy.so/protocol/random entry', () => {
  it('reaches no third-party module other than the optional expo-crypto peer', () => {
    expect(walk(RANDOM_ENTRY).external).toEqual(['expo-crypto']);
  });

  it('includes the React Native variant that Metro substitutes', () => {
    // Sanity check on the walker: without the native sibling the guard above
    // would pass vacuously on the default (import-free) variant.
    expect(walk(RANDOM_ENTRY).files).toEqual(
      expect.arrayContaining([join(SRC_DIR, 'platform', 'random.native.ts')]),
    );
  });

  it('is exported as a package subpath', () => {
    const manifest = JSON.parse(readFileSync(resolve(SRC_DIR, '..', 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
    };
    expect(manifest.exports['./random']).toBeDefined();
  });

  it('exposes the platform predicates and the RN randomness source', () => {
    const entry = require('../random') as typeof import('../random');
    expect(typeof entry.isNodeJS).toBe('function');
    expect(typeof entry.isReactNative).toBe('function');
    expect(entry.isNodeJS()).toBe(true);
    expect(() => entry.getRandomBytesRN(8)).toThrow(/outside React Native/);
  });
});
