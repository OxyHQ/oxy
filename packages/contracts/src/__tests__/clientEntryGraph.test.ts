/**
 * `@oxy.so/contracts/client` never reaches Zod.
 *
 * The point of the client entry is that an app importing it ships no Zod. This
 * walks the STATIC value-import graph from `src/client/index.ts` — the graph
 * every bundler, Metro without tree shaking included, must load — and asserts
 * no module on it imports a Zod runtime. Type-only imports (the checks name their
 * contract types with `import type`) are erased and are not edges.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const SRC = resolve(__dirname, '..');

function isTypeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return true;
    const clause = node.exportClause;
    return Boolean(
      clause &&
        ts.isNamedExports(clause) &&
        clause.elements.length > 0 &&
        clause.elements.every((e) => e.isTypeOnly),
    );
  }
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  return Boolean(
    bindings &&
      ts.isNamedImports(bindings) &&
      bindings.elements.length > 0 &&
      bindings.elements.every((e) => e.isTypeOnly),
  );
}

function staticSpecifiers(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (
      (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) &&
      st.moduleSpecifier &&
      ts.isStringLiteral(st.moduleSpecifier) &&
      !isTypeOnly(st)
    ) {
      out.push(st.moduleSpecifier.text);
    }
  }
  return out;
}

function resolveRelative(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier.replace(/\.js$/, ''));
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`unresolved relative import '${specifier}' in ${fromFile}`);
}

/** Every module on the static graph of `entry`, and who imports each external package. */
function walk(entry: string): { files: string[]; externals: Map<string, string[]> } {
  const files = new Set<string>();
  const externals = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of staticSpecifiers(file)) {
      if (specifier.startsWith('.')) {
        queue.push(resolveRelative(file, specifier));
      } else {
        externals.set(specifier, [...(externals.get(specifier) ?? []), relative(SRC, file)]);
      }
    }
  }
  return { files: [...files].map((file) => relative(SRC, file)), externals };
}

describe('@oxy.so/contracts/client entry graph', () => {
  const { files, externals } = walk(join(SRC, 'client/index.ts'));

  it('reaches the checks it exports (the walk is not vacuous)', () => {
    expect(files).toEqual(
      expect.arrayContaining(['client/check.ts', 'client/deviceSession.ts', 'client/signIn.ts']),
    );
  });

  it('imports no package at all — Zod least of all', () => {
    expect(Object.fromEntries(externals)).toEqual({});
  });

  it('only reaches the pure capability helpers, product catalogue and colour table outside src/client/', () => {
    expect(files.filter((file) => !file.startsWith('client/'))).toEqual([
      'capabilityBindings.ts',
      'profileColors.generated.ts',
      'products/one.ts',
    ]);
  });

  it('the root entry does reach Zod (the control that proves the walk sees an import)', () => {
    expect(walk(join(SRC, 'index.ts')).externals.has('@oxy.so/zod4')).toBe(true);
  });
});
