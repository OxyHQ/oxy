/**
 * `@oxy.so/services/ui/client` never reaches the sign-in panels.
 *
 * The root barrel re-exports every sign-in panel for apps that embed one, and
 * Metro does not tree-shake: importing any symbol from `@oxy.so/services` ships
 * `OxySignInPanel`, `OxyLinkCommonsPanel` with its QR encoder, Bloom's auth card
 * and the rest, even though the account dialog that shows them is loaded on
 * demand. Mention measured ~140 KB of that on its home route (OxyHQ/Mention#1216).
 * `ui/client` is the entry an app's startup path imports instead, so what it
 * reaches is a contract, not an accident of today's imports.
 *
 * The walk follows every platform variant of a module, so a panel reached only
 * from `.web.tsx` or `.native.tsx` still fails.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const SRC = resolve(__dirname, '../../src');
const ENTRY = join(SRC, 'ui/client.ts');
const EXTENSIONS = ['.ts', '.tsx', '.native.ts', '.native.tsx', '.web.ts', '.web.tsx'];

/** Source files the entry must not reach: panels, not the flow store they share. */
const FORBIDDEN_FILE = /ui\/components\/(?:signIn\/(?!signInFlowStore\.ts$)|OxyConsentScreen)/;
/** Packages that only the panels need. */
const FORBIDDEN_PACKAGES = ['react-native-qrcode-svg', 'qrcode', '@oxy.so/bloom/auth-card'];

function resolveAll(fromFile: string, specifier: string): string[] {
  const base = resolve(dirname(fromFile), specifier);
  const found: string[] = [];
  for (const suffix of [...EXTENSIONS, ...EXTENSIONS.map((extension) => `/index${extension}`)]) {
    try {
      readFileSync(`${base}${suffix}`);
      found.push(`${base}${suffix}`);
    } catch {
      // Not this variant.
    }
  }
  return found;
}

function staticSpecifiers(source: string): string[] {
  const runtimeSource = source.replace(/(?:^|\n)\s*(?:import|export)\s+type\s[^;]+;?/g, '\n');
  return [
    ...runtimeSource.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g),
    ...runtimeSource.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g),
  ].map((match) => match[1]);
}

function reach(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set([entry]);
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const specifier of staticSpecifiers(readFileSync(current, 'utf8'))) {
      if (!specifier.startsWith('.')) {
        packages.add(specifier);
        continue;
      }
      for (const next of resolveAll(current, specifier)) {
        if (files.has(next)) continue;
        files.add(next);
        queue.push(next);
      }
    }
  }
  return { files, packages };
}

const reached = reach(ENTRY);

describe('runtime entry isolation', () => {
  const runtimeEntry = join(SRC, 'runtime.ts');
  const runtime = reach(runtimeEntry);

  it('reaches the provider runtime context without screens or optional packages', () => {
    expect(runtime.files.has(join(SRC, 'ui/runtime/runtimeContext.tsx'))).toBe(true);
    expect([...runtime.files].map((file) => relative(SRC, file)).sort()).toEqual([
      'runtime.ts',
      'ui/runtime/runtimeContext.tsx',
      'ui/runtime/useRuntimeSnapshot.ts',
    ]);
    expect([...runtime.packages]).toEqual(['react']);
  });

  it('shares the exact runtime hook and missing-provider error with the existing entry', () => {
    const light = require('../../src/runtime');
    const providerRuntime = require('../../src/ui/runtime/runtimeContext');
    expect(light.useOxyRuntime).toBe(providerRuntime.useOxyRuntime);
    expect(light.OxyRuntimeMissingError).toBe(providerRuntime.OxyRuntimeMissingError);
  });
});

describe('ui/client entry isolation', () => {
  it('walked a plausible graph', () => {
    // A broken walk must not read as "nothing forbidden".
    expect(reached.files.size).toBeGreaterThan(40);
  });

  it('reaches no sign-in panel and no consent screen', () => {
    const panels = [...reached.files]
      .map((file) => relative(SRC, file))
      .filter((file) => FORBIDDEN_FILE.test(file));
    expect(panels).toEqual([]);
  });

  it('reaches no account screen: they load lazily from the route registry', () => {
    // A static import of any screen puts every one of them, with Bloom's phone
    // input and its flags, in an app's first-paint chunk on web (Syra measured
    // +128.6 KB gzipped when the app assertion came from the full `ui` barrel).
    const screens = [...reached.files]
      .map((file) => relative(SRC, file))
      .filter((file) => /^ui\/screens\//.test(file));
    expect(screens).toEqual([]);
  });

  it('proves the screen check can fail: the root barrel does reach the screens', () => {
    const root = reach(join(SRC, 'index.ts'));
    expect([...root.files].some((file) => /^ui\/screens\//.test(relative(SRC, file)))).toBe(true);
  });

  it('reaches none of the packages only the panels need', () => {
    expect(FORBIDDEN_PACKAGES.filter((name) => reached.packages.has(name))).toEqual([]);
  });

  it('proves the check can fail: the root barrel does reach the panels', () => {
    const root = reach(join(SRC, 'index.ts'));
    expect([...root.files].some((file) => FORBIDDEN_FILE.test(relative(SRC, file)))).toBe(true);
    expect(root.packages.has('react-native-qrcode-svg')).toBe(true);
  });

  it('exports the cache, query, follow and data hooks an app needs without the root barrel', () => {
    const client = readFileSync(ENTRY, 'utf8');
    for (const symbol of [
      'queryKeys',
      'upsertCachedUser',
      'upsertCachedUsers',
      'clearedFieldsFromAccountUpdate',
      'useUserById',
      'useUserByUsername',
      'useSeedFollowStatuses',
      'useFollowTarget',
      'resolveFollowPrimaryAction',
      'ProfileButton',
      'useAppAssertion',
      'useUploadFile',
      'useUploadAvatar',
      'useFileDownloadUrl',
      'useMutationStatus',
      'useOnlineStatus',
      'useDisplayCurrency',
      'useDisplayPrice',
    ]) {
      expect(client).toMatch(new RegExp(`\\b${symbol}\\b`));
    }
  });
});
