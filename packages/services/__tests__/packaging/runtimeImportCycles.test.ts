import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const src = resolve(__dirname, '../../src');
const imports = new Map<string, string[]>();

function runtimeImports(file: string): string[] {
  const cached = imports.get(file);
  if (cached) return cached;
  // Type references to a presenter are legal; value imports can close a cycle.
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
    fileName: file,
  });
  const ast = ts.createSourceFile(file, outputText, ts.ScriptTarget.Latest, true);
  const dependencies: string[] = [];
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue;
    const base = resolve(dirname(file), specifier.text);
    const dependency = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
      .map((suffix) => base + suffix)
      .find((candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate));
    if (dependency) dependencies.push(dependency);
  }
  imports.set(file, dependencies);
  return dependencies;
}

function pathTo(start: string, target: string, visited = new Set<string>()): string[] | null {
  if (start === target) return [start];
  if (visited.has(start)) return null;
  visited.add(start);
  for (const next of runtimeImports(start)) {
    const path = pathTo(next, target, visited);
    if (path) return [start, ...path];
  }
  return null;
}

it.each([
  ['ui/components/SurfaceScreen.tsx', 'ui/navigation/surfaces.ts'],
  ['ui/hooks/useFollow.ts', 'ui/context/OxyContext.tsx'],
])('%s does not import its runtime owner %s', (child, owner) => {
  expect(pathTo(resolve(src, child), resolve(src, owner))).toBeNull();
});
