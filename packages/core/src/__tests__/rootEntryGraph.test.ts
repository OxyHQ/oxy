/**
 * The root entry (`@oxy.so/core`) stays light.
 *
 * An app that only calls the API must not ship the self-custody identity
 * (secp256k1, bip39, the AEAD cipher), the public-suffix list, or the inference
 * client. Those live behind their own entries (`/crypto`, `/server`,
 * `/inference`) and the namespaces that need them load them with `import()` on
 * first use. This walks the STATIC value-import graph of `src/index.ts` — the
 * graph every bundler, Metro included, must include — and asserts none of them
 * is on it. Dynamic `import()` and type-only imports are not edges.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

const SRC = resolve(__dirname, '..');
const ROOT_ENTRY = join(SRC, 'index.ts');

function isTypeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) {
    if (node.isTypeOnly) return true;
    const clause = node.exportClause;
    return Boolean(clause && ts.isNamedExports(clause) && clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly));
  }
  const clause = node.importClause;
  if (!clause) return false; // side-effect import: a real edge
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  return Boolean(bindings && ts.isNamedImports(bindings) && bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly));
}

function staticSpecifiers(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  for (const st of sf.statements) {
    if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      if (!isTypeOnly(st)) out.push(st.moduleSpecifier.text);
    }
  }
  return out;
}

function resolveRelative(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier.replace(/\.js$/, ''));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), base]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) return candidate;
  }
  throw new Error(`unresolved relative import '${specifier}' in ${fromFile}`);
}

function walk(entry: string): { files: Set<string>; external: Set<string> } {
  const files = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (files.has(file)) continue;
    files.add(file);
    if (!file.endsWith('.ts') && !file.endsWith('.tsx')) continue;
    for (const specifier of staticSpecifiers(file)) {
      if (specifier.startsWith('.')) queue.push(resolveRelative(file, specifier));
      else external.add(specifier);
    }
  }
  return { files, external };
}

describe('@oxy.so/core root entry graph', () => {
  const { files, external } = walk(ROOT_ENTRY);
  const reached = [...files].map((f) => relative(SRC, f));

  it('reaches a real graph (the walk is not vacuous)', () => {
    expect(reached).toContain('OxyServices.ts');
    expect(reached).toContain('HttpService.ts');
    expect(reached).toContain('api/users.ts');
  });

  it.each([
    'crypto/keyManager.ts',
    'crypto/recoveryPhrase.ts',
    'crypto/aead.ts',
    'crypto/signatureService.ts',
    'crypto/registrationPow.ts',
    'utils/registrableApex.ts',
    'inference/OxyInferenceClient.ts',
    'session/SessionClient.ts',
    'session/accountDialogController.ts',
  ])('does not statically reach %s', (file) => {
    expect(reached).not.toContain(file);
  });

  it('reaches no heavy third-party crypto or the public-suffix list', () => {
    const heavy = [...external].filter((spec) => /^@scure\/|^@noble\/curves|^tldts/.test(spec));
    expect(heavy).toEqual([]);
  });

  it('ships only the English dictionary statically', () => {
    const locales = reached.filter((f) => f.startsWith('i18n/locales/'));
    expect(locales).toEqual(['i18n/locales/en-US.ts']);
  });
});
