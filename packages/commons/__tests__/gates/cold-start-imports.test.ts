import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * What expo-router evaluates before the first screen.
 *
 * `getLinkingConfig` loads `app/+native-intent.ts` (and everything it imports)
 * while it builds the router, before any layout renders, on every launch. A
 * module-scope throw anywhere in that graph is a crash on launch with no screen
 * to show it: Commons 1.3.0 died there because the file imported the ROOT of
 * `@oxy.so/contracts`, which evaluates every Zod schema in the package (about
 * 200 modules), and a stale build of it called a Zod 3 method at module scope.
 *
 * The root is for servers (oxy `AGENTS.md`: client code takes contract VALUES
 * from `@oxy.so/contracts/client`, never Zod). This file keeps the cold-start
 * graph on Zod-free entries, so it stays small and its module scope stays
 * free of schema construction.
 */
const NATIVE_INTENT = readFileSync(resolve(__dirname, '../../app/+native-intent.ts'), 'utf8');

function valueImports(source: string): string[] {
  return [...source.matchAll(/^import\s+(?!type\b)[^'"]*from\s+['"]([^'"]+)['"]/gm)].map(
    (match) => match[1],
  );
}

describe('cold-start import graph (app/+native-intent.ts)', () => {
  it('imports values only from Zod-free entry points', () => {
    const imports = valueImports(NATIVE_INTENT);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports).not.toContain('@oxy.so/contracts');
    expect(imports).not.toContain('@oxy.so/core');
    expect(imports).not.toContain('zod');
    for (const specifier of imports) {
      expect(['@oxy.so/contracts/client', '@oxy.so/core/civic']).toContain(specifier);
    }
  });

  it('still rewrites a card link and passes other paths through', () => {
    const { redirectSystemPath } =
      require('@/app/+native-intent') as typeof import('@/app/+native-intent');
    expect(redirectSystemPath({ path: 'card?did=did:oxy:abc&v=1', initial: true })).toBe(
      '/card/did%3Aoxy%3Aabc',
    );
    expect(redirectSystemPath({ path: '/approve?code=x', initial: true })).toBe('/approve?code=x');
  });
});
