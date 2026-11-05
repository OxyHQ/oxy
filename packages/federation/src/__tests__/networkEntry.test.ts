import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';

/** Every specifier the module at `file` imports, following relative imports. */
function importGraph(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  const specifiers = [...source.matchAll(/^(?:import|export)[^'"]*from\s+'([^']+)'/gm)].map(
    (match) => match[1],
  );
  return specifiers.flatMap((specifier) =>
    specifier.startsWith('.')
      ? importGraph(join(file, '..', `${specifier}.ts`), seen)
      : [specifier],
  );
}

describe('@oxy.so/federation/network', () => {
  it('imports nothing from Node, so a web or React Native bundle can use it', () => {
    const external = importGraph(join(__dirname, '..', 'network.ts'));
    const node = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
    expect(external.filter((specifier) => node.has(specifier))).toEqual([]);
  });
});
