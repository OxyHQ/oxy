/**
 * Every package `@oxyhq/core/server` VALUE-imports must be a real dependency.
 *
 * ## The failure this exists for, which happened
 *
 * `helmet` was declared an OPTIONAL peer dependency. `src/server/securityHeaders.ts`
 * imports it at the top level, and the server barrel re-exports that module — so
 * importing *anything* from `@oxyhq/core/server` loads helmet, and a consumer
 * that believed the "optional" marking did not install it.
 *
 * The result was a backend that could not boot: `Cannot find package 'helmet'`.
 * `tsc` passed clean the whole time, because types resolve from a peer whether
 * or not the runtime can find the module. It was found by a test suite failing
 * to resolve 29 of 63 files while every typecheck was green — which is a very
 * expensive way to learn it.
 *
 * ## Why value imports and not all imports
 *
 * `express` is imported by eight files here and every one of them is
 * `import type`. Those vanish at build time, so an optional peer is a truthful
 * declaration for it: a consumer of the client entry never needs express
 * installed. The distinction this test draws is exactly the one that decides
 * whether a missing package is a warning or a crash.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const packageRoot = path.resolve(__dirname, '../..');
const serverDir = path.join(packageRoot, 'src', 'server');

const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
const requiredPeers = new Set(
  Object.keys(manifest.peerDependencies ?? {}).filter(
    (name) => manifest.peerDependenciesMeta?.[name]?.optional !== true
  )
);

/**
 * Bare specifiers imported for their VALUE — `import x from 'y'`,
 * `import { a } from 'y'`, `import 'y'` — but never `import type`.
 */
function valueImports(source: string): string[] {
  const found: string[] = [];
  // Strip comments first: prose in a doc comment can otherwise read as code.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  for (const match of code.matchAll(/import\s+(?!type\b)([^;']*?)from\s*'([^']+)'/g)) {
    // `import { type A, type B } from 'x'` is still type-only in effect.
    const clause = match[1];
    const specifier = match[2];
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
    const names = clause.replace(/[{}]/g, '').split(',').map((n) => n.trim()).filter(Boolean);
    if (names.length > 0 && names.every((n) => n.startsWith('type '))) continue;
    found.push(specifier);
  }
  for (const match of code.matchAll(/import\s*'([^']+)'/g)) {
    if (!match[1].startsWith('.') && !match[1].startsWith('node:')) found.push(match[1]);
  }
  return found;
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

const files = readdirSync(serverDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));

describe('@oxyhq/core/server value imports are installable', () => {
  it('reads a non-trivial number of server modules', () => {
    // Vacuity floor: a traversal that found nothing would satisfy every
    // assertion below by having nothing to check.
    expect(files.length).toBeGreaterThan(5);
  });

  it('declares every value-imported package as a dependency or a REQUIRED peer', () => {
    const undeclared: string[] = [];
    for (const file of files) {
      const source = readFileSync(path.join(serverDir, file), 'utf8');
      for (const specifier of valueImports(source)) {
        const name = packageNameOf(specifier);
        if (dependencies.has(name) || requiredPeers.has(name)) continue;
        undeclared.push(`${file} → ${name}`);
      }
    }

    // An OPTIONAL peer is not enough here and that is the whole point: the
    // module is loaded the moment anything is imported from the server barrel,
    // so "optional" describes a package the consumer cannot actually omit.
    expect(undeclared.sort()).toEqual([]);
  });

  it('keeps helmet installable rather than optional', () => {
    // The specific regression, asserted by name so a failure says what broke
    // rather than only showing it inside a list.
    expect(dependencies.has('helmet')).toBe(true);
    expect(manifest.peerDependenciesMeta?.helmet?.optional).toBeUndefined();
  });

  it('keeps express-rate-limit installable rather than a peer', () => {
    // Same class as helmet: `rateLimit.ts` value-imports it and the server
    // barrel re-exports that module, so a missing install crashes at boot.
    expect(dependencies.has('express-rate-limit')).toBe(true);
    expect(manifest.peerDependencies?.['express-rate-limit']).toBeUndefined();
  });

  it('leaves express as an optional peer, because it is type-only here', () => {
    // The counter-example that stops this test from being read as "declare
    // everything": type imports vanish at build time, so an optional peer is a
    // truthful declaration for express and making it required would nag every
    // React Native consumer about a package they never load.
    expect(manifest.peerDependenciesMeta?.express?.optional).toBe(true);
  });
});
