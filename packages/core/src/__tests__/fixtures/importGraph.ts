/**
 * The STATIC value-import graph of a TypeScript entry — the graph every
 * bundler, Metro included, must load. Dynamic `import()` and type-only imports
 * are not edges.
 *
 * Relative specifiers are followed. A bare specifier is followed when
 * `resolvePackage` maps it to a source file (a workspace package), and is
 * otherwise recorded as external, with the modules that import it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

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
  if (!clause) return false; // side-effect import: a real edge
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
      ts.isStringLiteral(st.moduleSpecifier)
    ) {
      if (!isTypeOnly(st)) out.push(st.moduleSpecifier.text);
    }
  }
  return out;
}

/** `./x`, `./x.js`, `./dir` → the `.ts`/`.tsx`/`index.ts` source it names. */
export function resolveSource(base: string): string {
  const stem = base.replace(/\.js$/, '');
  for (const candidate of [`${stem}.ts`, `${stem}.tsx`, join(stem, 'index.ts'), stem]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) return candidate;
  }
  throw new Error(`unresolved import '${base}'`);
}

export interface ImportGraph {
  /** Every source file on the graph, absolute. */
  files: Set<string>;
  /** Each external specifier, with the (absolute) files that import it. */
  external: Map<string, string[]>;
}

export function walkImportGraph(
  entry: string,
  resolvePackage: (specifier: string) => string | null = () => null,
): ImportGraph {
  const files = new Set<string>();
  const external = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (files.has(file)) continue;
    files.add(file);
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
    for (const specifier of staticSpecifiers(file)) {
      if (specifier.startsWith('.')) {
        queue.push(resolveSource(resolve(dirname(file), specifier)));
        continue;
      }
      const source = resolvePackage(specifier);
      if (source) queue.push(source);
      else external.set(specifier, [...(external.get(specifier) ?? []), file]);
    }
  }
  return { files, external };
}
