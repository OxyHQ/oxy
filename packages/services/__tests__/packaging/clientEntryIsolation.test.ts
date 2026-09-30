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

  it('reaches none of the packages only the panels need', () => {
    expect(FORBIDDEN_PACKAGES.filter((name) => reached.packages.has(name))).toEqual([]);
  });

  it('proves the check can fail: the root barrel does reach the panels', () => {
    const root = reach(join(SRC, 'index.ts'));
    expect([...root.files].some((file) => FORBIDDEN_FILE.test(relative(SRC, file)))).toBe(true);
    expect(root.packages.has('react-native-qrcode-svg')).toBe(true);
  });

  it('exports the cache, query and follow helpers an app needs at startup', () => {
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
    ]) {
      expect(client).toMatch(new RegExp(`\\b${symbol}\\b`));
    }
  });
});
