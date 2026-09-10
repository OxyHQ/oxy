import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SRC = resolve(__dirname, '../../src');
const SCREEN_ROOT = join(SRC, 'ui/screens');
const ENTRIES = [
  join(SRC, 'index.ts'),
  join(SRC, 'ui/index.ts'),
  join(SRC, 'ui/client.ts'),
];
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
  return [...runtimeSource.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1]);
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
    const screens = [...staticallyReachable(entry)].filter(
      (file) => file.startsWith(`${SCREEN_ROOT}/`) && !file.includes('/navigation/'),
    );
    expect(screens).toEqual([]);
  });

  it('keeps screens explicitly available from their own subpath', () => {
    const barrel = readFileSync(join(SCREEN_ROOT, 'index.ts'), 'utf8');
    expect(barrel).toContain("from './ProfileScreen'");
    expect(barrel).toContain("from './AccountSettingsScreen'");
  });
});
