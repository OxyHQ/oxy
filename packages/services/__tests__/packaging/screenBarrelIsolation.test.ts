import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SRC = resolve(__dirname, '../../src');
const SCREEN_ROOT = join(SRC, 'ui/screens');
// The root barrel is the everything entry (it also re-exports the sign-in
// panels) and registers the screens synchronously. `ui` and `ui/client` are
// what apps and SDKs import on their startup path: the screens reach them only
// through `loadScreens()`'s dynamic import.
const FULL_ENTRIES = [join(SRC, 'index.ts')];
const ENTRIES = [join(SRC, 'ui/client.ts'), join(SRC, 'ui/index.ts')];
const EXTENSIONS = ['.ts', '.tsx', '.native.ts', '.native.tsx', '.web.ts', '.web.tsx'];

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  for (const suffix of [...EXTENSIONS, ...EXTENSIONS.map((extension) => `/index${extension}`)]) {
    try {
      const candidate = `${base}${suffix}`;
      readFileSync(candidate);
      return candidate;
    } catch {
      // Try the next supported source suffix.
    }
  }
  return null;
}

function staticSpecifiers(source: string): string[] {
  const runtimeSource = source.replace(/(?:^|\n)\s*(?:import|export)\s+type\s[^;]+;?/g, '\n');
  return [
    ...runtimeSource.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g),
  ].map((match) => match[1]);
}

function staticallyReachable(entry: string): Set<string> {
  const reached = new Set([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const specifier of staticSpecifiers(readFileSync(current, 'utf8'))) {
      if (!specifier.startsWith('.')) continue;
      const next = resolveRelative(current, specifier);
      if (!next || reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }
  return reached;
}

describe('screen entry-point isolation', () => {
  it.each(ENTRIES)('%s does not statically reach a route screen', (entry) => {
    const reached = staticallyReachable(entry);
    // A broken walk must not read as "no screens".
    expect(reached.size).toBeGreaterThan(40);
    const screens = [...reached].filter(
      (file) =>
        (file.startsWith(`${SCREEN_ROOT}/`) && !file.includes('/navigation/')) ||
        file === join(SRC, 'ui/navigation/screenComponents.ts'),
    );
    expect(screens).toEqual([]);
    expect(readFileSync(entry, 'utf8')).not.toMatch(/registerScreens\(/);
  });

  it('loads the screens lazily, as one dynamic chunk, from OxyProvider', () => {
    const routes = readFileSync(join(SRC, 'ui/navigation/routes.ts'), 'utf8');
    expect(routes).toMatch(/import\(\s*'\.\/screenComponents'\s*\)/);
    const provider = readFileSync(join(SRC, 'ui/components/OxyProvider.tsx'), 'utf8');
    expect(provider).toMatch(/loadScreens\(\)/);
  });

  it.each(FULL_ENTRIES)('%s registers the real screen components before navigation', (entry) => {
    const source = readFileSync(entry, 'utf8');
    expect(source).toContain('registerScreens(screenComponents)');
    expect(staticallyReachable(entry).has(join(SCREEN_ROOT, 'ManageAccountScreen.tsx'))).toBe(true);
    expect(staticallyReachable(entry).has(join(SCREEN_ROOT, 'PreferencesScreen.tsx'))).toBe(true);
    const host = readFileSync(join(SRC, 'ui/components/SurfaceScreen.tsx'), 'utf8');
    expect(host).not.toMatch(/Suspense|ScreenPending|ScreenPlaceholder/);
  });

  it('keeps screens explicitly available from their own subpath', () => {
    const barrel = readFileSync(join(SCREEN_ROOT, 'index.ts'), 'utf8');
    expect(barrel).toContain("from './ProfileScreen'");
    expect(barrel).toContain("from './AccountSettingsScreen'");
  });
});
