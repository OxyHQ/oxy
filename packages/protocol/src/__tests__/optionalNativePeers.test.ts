/**
 * Guards the optional-peer contract of the React Native platform fork.
 *
 * `expo-crypto`, `expo-secure-store` and `@react-native-async-storage/async-storage`
 * are declared OPTIONAL peer dependencies. A STATIC `import` of any of them
 * contradicts that: Metro resolves every static import in the eager graph, so an
 * app that omits the optional peer does not degrade — its whole native bundle
 * fails with `Unable to resolve module <peer>`, pointing at a dependency the app
 * never mentions. Because `@oxyhq/core`'s `crypto/polyfill` imports
 * `@oxyhq/protocol`'s ROOT entry, `platform/crypto.native.ts` sits in the eager
 * graph of every React Native app in the fleet, so the blast radius is total.
 *
 * Two tests, deliberately different in kind:
 *
 *  1. A STATIC guard over the module graph reachable from `src/index.ts`
 *     (including the `.native.ts` siblings Metro substitutes), which fails on
 *     any future static import of an optional peer anywhere in that graph.
 *  2. A BEHAVIOURAL check that the fork imports cleanly when the peers are
 *     missing and only throws — with an actionable message — at the point where
 *     the capability is used.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SRC_DIR = resolve(__dirname, '..');
const ROOT_ENTRY = join(SRC_DIR, 'index.ts');

const packageJson = JSON.parse(
  readFileSync(resolve(SRC_DIR, '..', 'package.json'), 'utf8'),
) as {
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const optionalPeers = Object.entries(packageJson.peerDependenciesMeta ?? {})
  .filter(([, meta]) => meta.optional === true)
  .map(([name]) => name);

/**
 * Static `import`/`export … from` specifiers, excluding the `import type` /
 * `export type` forms, which are fully erased at build time and therefore never
 * become a Metro dependency.
 */
function valueImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)([\s\S]*?)\sfrom\s+['"]([^'"]+)['"]/g;
  let match = pattern.exec(source);
  while (match !== null) {
    specifiers.push(match[2]);
    match = pattern.exec(source);
  }
  // Bare side-effect imports (`import 'foo';`) have no `from` clause.
  const sideEffectPattern = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  let sideEffect = sideEffectPattern.exec(source);
  while (sideEffect !== null) {
    specifiers.push(sideEffect[1]);
    sideEffect = sideEffectPattern.exec(source);
  }
  return specifiers;
}

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Every source file Metro can pull into a React Native bundle through the root
 * entry. Metro substitutes `<base>.native.ts` for `<base>.ts` on native, so each
 * reachable module contributes its `.native` sibling too.
 */
function reachableFromRootEntry(): string[] {
  const seen = new Set<string>();
  const queue = [ROOT_ENTRY];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);

    const nativeSibling = file.replace(/\.ts$/, '.native.ts');
    if (nativeSibling !== file && existsSync(nativeSibling) && !seen.has(nativeSibling)) {
      queue.push(nativeSibling);
    }

    for (const specifier of valueImportSpecifiers(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) {
        continue;
      }
      const resolved = resolveRelative(file, specifier);
      if (resolved !== null) {
        queue.push(resolved);
      }
    }
  }
  return [...seen];
}

describe('optional peer dependencies are never statically imported', () => {
  it('declares the React Native modules as optional peers', () => {
    expect(optionalPeers).toEqual(
      expect.arrayContaining([
        'expo-crypto',
        'expo-secure-store',
        '@react-native-async-storage/async-storage',
      ]),
    );
  });

  it('has no static import of an optional peer anywhere in the root-entry graph', () => {
    const offenders: string[] = [];
    for (const file of reachableFromRootEntry()) {
      for (const specifier of valueImportSpecifiers(readFileSync(file, 'utf8'))) {
        if (optionalPeers.includes(specifier)) {
          offenders.push(`${file.slice(SRC_DIR.length + 1)} statically imports '${specifier}'`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reaches the React Native crypto fork from the root entry', () => {
    // Sanity check on the walker itself: if this ever stops holding, the guard
    // above would pass vacuously.
    expect(reachableFromRootEntry()).toEqual(
      expect.arrayContaining([join(SRC_DIR, 'platform', 'crypto.native.ts')]),
    );
  });
});

describe('crypto.native optional-peer degradation', () => {
  const MODULE_PATH = '../platform/crypto.native';

  function unresolvable(name: string): () => never {
    return () => {
      throw new Error(`Cannot find module '${name}'`);
    };
  }

  beforeEach(() => {
    jest.resetModules();
  });

  it('imports cleanly when every optional peer is missing', () => {
    jest.isolateModules(() => {
      jest.doMock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }), {
        virtual: true,
      });
      jest.doMock('expo-crypto', unresolvable('expo-crypto'), { virtual: true });
      jest.doMock('expo-secure-store', unresolvable('expo-secure-store'), { virtual: true });
      jest.doMock(
        '@react-native-async-storage/async-storage',
        unresolvable('@react-native-async-storage/async-storage'),
        { virtual: true },
      );

      expect(() => require(MODULE_PATH)).not.toThrow();
    });
  });

  it('throws an actionable error per capability when the peer is missing', async () => {
    await jest.isolateModulesAsync(async () => {
      jest.doMock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }), {
        virtual: true,
      });
      jest.doMock('expo-crypto', unresolvable('expo-crypto'), { virtual: true });
      jest.doMock('expo-secure-store', unresolvable('expo-secure-store'), { virtual: true });
      jest.doMock(
        '@react-native-async-storage/async-storage',
        unresolvable('@react-native-async-storage/async-storage'),
        { virtual: true },
      );

      const mod = require(MODULE_PATH) as typeof import('../platform/crypto.native');

      await expect(mod.loadExpoCrypto()).rejects.toThrow(/npx expo install expo-crypto/);
      await expect(mod.loadSecureStore()).rejects.toThrow(/npx expo install expo-secure-store/);
      await expect(mod.loadAsyncStorage()).rejects.toThrow(
        /npx expo install @react-native-async-storage\/async-storage/,
      );
      expect(() => mod.getRandomBytesRN(8)).toThrow(/npx expo install expo-crypto/);

      // The Metro resolution failure is reported, not swallowed.
      expect(() => mod.getRandomBytesRN(8)).toThrow(/Cannot find module 'expo-crypto'/);
    });
  });

  it('returns the real modules when the optional peers are installed', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fakeCrypto = {
      getRandomBytes: () => bytes,
      getRandomBytesAsync: async () => bytes,
      digestStringAsync: async () => 'digest',
      CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    };
    const fakeSecureStore = {
      setItemAsync: async () => undefined,
      getItemAsync: async () => null,
      deleteItemAsync: async () => undefined,
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
      WHEN_UNLOCKED: 2,
    };
    const fakeAsyncStorage = {
      getItem: async () => null,
      setItem: async () => undefined,
      removeItem: async () => undefined,
    };

    await jest.isolateModulesAsync(async () => {
      jest.doMock('expo-modules-core', () => ({ requireOptionalNativeModule: () => null }), {
        virtual: true,
      });
      jest.doMock('expo-crypto', () => fakeCrypto, { virtual: true });
      jest.doMock('expo-secure-store', () => fakeSecureStore, { virtual: true });
      jest.doMock('@react-native-async-storage/async-storage', () => ({ default: fakeAsyncStorage }), {
        virtual: true,
      });

      const mod = require(MODULE_PATH) as typeof import('../platform/crypto.native');

      await expect(mod.loadExpoCrypto()).resolves.toBe(fakeCrypto);
      await expect(mod.loadSecureStore()).resolves.toBe(fakeSecureStore);
      await expect(mod.loadAsyncStorage()).resolves.toEqual({ default: fakeAsyncStorage });
      expect(mod.getRandomBytesRN(4)).toBe(bytes);
    });
  });
});
