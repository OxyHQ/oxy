/**
 * `@oxy.so/core` 3.0 codemod: rewrites 2.x flat calls to the namespaces.
 *
 *   bun scripts/codemods/core-3/codemod.ts <dir> [--dry]
 *
 * For every `.ts`/`.tsx` under <dir> (skipping node_modules, dist, build
 * output), each `receiver.method(...)` whose method is in METHOD_MAP and whose
 * receiver looks like an Oxy client is rewritten:
 *
 * - `oxy.getUserById(id)`        → `oxy.users.get(id)`
 * - `oxy.getAccessToken()`       → `oxy.session.accessToken`     (getter)
 * - `oxy.makeServiceRequest(…)`  → `oxy.serviceRequest(…)` and the file is
 *   flagged: its client must be an `OxyServer` from `@oxy.so/core/server`
 * - removed methods and changed signatures get a `// TODO(core-3): …` line
 *
 * Anything it cannot see (destructured methods, a client under another name)
 * is left alone; `grep TODO\(core-3\)` and the typechecker find the rest.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { METHOD_MAP } from './map';

const CORE_SRC = path.resolve(import.meta.dir, '../../../packages/core/src');

/** Names a module file exports (value and type), read from its source. */
function exportedNames(file: string): Set<string> {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) names.add(el.name.text);
    } else if (
      (ts.isClassDeclaration(st) || ts.isFunctionDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) &&
      st.name && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      names.add(st.name.text);
    } else if (ts.isVariableStatement(st) && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.add(d.name.text);
    }
  }
  return names;
}

/** Where each `@oxy.so/core` symbol lives in 3.0, first match wins (root first). */
const ENTRIES: Array<[string, Set<string>]> = [
  ['@oxy.so/core', exportedNames(path.join(CORE_SRC, 'index.ts'))],
  ['@oxy.so/core/session', exportedNames(path.join(CORE_SRC, 'session/index.ts'))],
  ['@oxy.so/core/crypto', exportedNames(path.join(CORE_SRC, 'crypto/index.ts'))],
  ['@oxy.so/core/civic', exportedNames(path.join(CORE_SRC, 'civic/index.ts'))],
  ['@oxy.so/core/inference', exportedNames(path.join(CORE_SRC, 'inference/index.ts'))],
  ['@oxy.so/core/server', exportedNames(path.join(CORE_SRC, 'server/index.ts'))],
];

function entryFor(symbol: string): string | null {
  for (const [spec, names] of ENTRIES) if (names.has(symbol)) return spec;
  return null;
}

/** Old names that became getters/properties: the call parentheses go. */
const BECAME_PROPERTY = new Set([
  'getBaseURL', 'getCloudURL', 'getClient', 'getAccessToken', 'getAccessTokenExpiry',
  'getCurrentUserId', 'hasValidToken', 'getMyDid',
]);

/**
 * A receiver is an Oxy client when its text names one. Generic method names
 * (`auth`, `validate`, `register`, `subscribe`, `search`…) only ever match an
 * explicitly Oxy-named receiver, so an unrelated `passport.auth()` stays put.
 */
const OXY_RECEIVER = /(^|\.)(oxy\w*|\w*Oxy\w*|oxyServices|oxyClient|oxyInstance|services)$|getServiceOxyClient\(\)$|getRuntimeOxyClient\(\)$/;
const GENERIC = new Set(['auth', 'validate', 'register', 'subscribe', 'search', 'inference', 'getClient', 'getStorage', 'handleError']);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.expo', '.next', 'web-build', '.turbo', 'coverage', '.git']);

interface Edit { start: number; end: number; text: string }
interface FileReport { file: string; rewrites: number; todos: number; server: boolean }

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(path.join(dir, entry.name), out);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(path.join(dir, entry.name));
    }
  }
}

function lineStart(text: string, pos: number): number {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

function indentAt(text: string, pos: number): string {
  const start = lineStart(text, pos);
  return /^[ \t]*/.exec(text.slice(start))?.[0] ?? '';
}

export function transform(fileName: string, text: string): { text: string; report: FileReport } {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits: Edit[] = [];
  const todoLines = new Map<number, string[]>();
  const report: FileReport = { file: fileName, rewrites: 0, todos: 0, server: false };

  const todo = (node: ts.Node, message: string): void => {
    const at = lineStart(text, node.getStart(sf));
    const list = todoLines.get(at) ?? [];
    if (!list.includes(message)) list.push(message);
    todoLines.set(at, list);
    report.todos++;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
      const method = node.name.text;
      const entry = Object.prototype.hasOwnProperty.call(METHOD_MAP, method) ? METHOD_MAP[method] : undefined;
      const receiver = node.expression.getText(sf).replace(/\s+/g, '');
      const call = ts.isCallExpression(node.parent) && node.parent.expression === node ? node.parent : null;
      const oxyNamed = OXY_RECEIVER.test(receiver);
      if (entry && oxyNamed && (call || method === 'httpService') && !(GENERIC.has(method) && !/oxy/i.test(receiver))) {
        const { to, sig } = entry;
        if (to === null) {
          todo(node, `${method} was removed in @oxy.so/core 3${sig ? ` — ${sig}` : ''}`);
        } else {
          const isServer = to.startsWith('server:');
          const target = isServer ? to.slice('server:'.length) : to;
          if (isServer) report.server = true;
          edits.push({ start: node.name.getStart(sf), end: node.name.getEnd(), text: target });
          if (call && BECAME_PROPERTY.has(method) && call.arguments.length === 0) {
            // `x.getAccessToken()` → `x.session.accessToken`: drop `(…)` incl. type args.
            edits.push({ start: node.getEnd(), end: call.getEnd(), text: '' });
          }
          // A getter conversion is fully handled above; any other note is a real TODO.
          if (sig && !BECAME_PROPERTY.has(method)) todo(node, `${method} → ${target}: ${sig}`);
          report.rewrites++;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // Imports from the root that moved to a subpath (or went away).
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== '@oxy.so/core') continue;
    const clause = st.importClause;
    if (!clause) continue;
    const typeOnly = clause.isTypeOnly;
    const groups = new Map<string, string[]>();
    const missing: string[] = [];
    let defaultName: string | null = null;
    if (clause.name) defaultName = clause.name.text;
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) continue;
    const specifiers = clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : [];
    for (const el of specifiers) {
      const imported = (el.propertyName ?? el.name).text;
      const spec = entryFor(imported);
      if (!spec) missing.push(imported);
      const text = `${el.isTypeOnly ? 'type ' : ''}${el.getText(sf).replace(/^type\s+/, '')}`;
      const list = groups.get(spec ?? '@oxy.so/core') ?? [];
      list.push(text);
      groups.set(spec ?? '@oxy.so/core', list);
    }
    if (defaultName) {
      // `import OxyServices from '@oxy.so/core'` — there is no default export any more.
      const list = groups.get('@oxy.so/core') ?? [];
      list.unshift(defaultName === 'OxyServices' ? 'OxyServices' : `OxyServices as ${defaultName}`);
      groups.set('@oxy.so/core', list);
    }
    const onlyRoot = groups.size === 1 && groups.has('@oxy.so/core') && !defaultName;
    if (onlyRoot && missing.length === 0) continue;
    const statements = [...groups.entries()].map(
      ([spec, names]) => `import ${typeOnly ? 'type ' : ''}{ ${names.join(', ')} } from '${spec}';`,
    );
    edits.push({ start: st.getStart(sf), end: st.getEnd(), text: statements.join('\n') });
    report.rewrites++;
    if (missing.length) todo(st, `not exported by @oxy.so/core 3: ${missing.join(', ')}`);
  }

  // Re-exports: `export { A, type B } from '@oxy.so/core'` split the same way.
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier) || st.moduleSpecifier.text !== '@oxy.so/core') continue;
    if (!st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
    const groups = new Map<string, string[]>();
    const missing: string[] = [];
    for (const el of st.exportClause.elements) {
      const exported = (el.propertyName ?? el.name).text;
      const spec = entryFor(exported);
      if (!spec) missing.push(exported);
      const list = groups.get(spec ?? '@oxy.so/core') ?? [];
      list.push(el.getText(sf));
      groups.set(spec ?? '@oxy.so/core', list);
    }
    if (groups.size === 1 && groups.has('@oxy.so/core') && missing.length === 0) continue;
    const statements = [...groups.entries()].map(
      ([spec, names]) => `export ${st.isTypeOnly ? 'type ' : ''}{ ${names.join(', ')} } from '${spec}';`,
    );
    edits.push({ start: st.getStart(sf), end: st.getEnd(), text: statements.join('\n') });
    report.rewrites++;
    if (missing.length) todo(st, `not exported by @oxy.so/core 3: ${missing.join(', ')}`);
  }

  // A file already on OxyServer needs no reminder (same-name server methods rewrite to themselves).
  if (report.server && !/\bOxyServer\b/.test(text)) {
    const firstStatement = sf.statements[0];
    if (firstStatement) {
      const at = lineStart(text, firstStatement.getStart(sf));
      const list = todoLines.get(at) ?? [];
      list.push("this file uses server-only API: construct `new OxyServer({ …, serviceAuth })` from '@oxy.so/core/server'");
      todoLines.set(at, list);
      report.todos++;
    }
  }

  for (const [at, messages] of todoLines) {
    const indent = indentAt(text, at);
    edits.push({ start: at, end: at, text: messages.map((m) => `${indent}// TODO(core-3): ${m}\n`).join('') });
  }

  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return { text: out, report };
}

function main(): void {
  const [dir, ...flags] = process.argv.slice(2);
  if (!dir) {
    console.error('usage: bun scripts/codemods/core-3/codemod.ts <dir> [--dry]');
    process.exit(1);
  }
  const dry = flags.includes('--dry');
  const files: string[] = [];
  walk(path.resolve(dir), files);
  const reports: FileReport[] = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const result = transform(file, text);
    if (result.text !== text) {
      reports.push(result.report);
      if (!dry) fs.writeFileSync(file, result.text);
    }
  }
  const rewrites = reports.reduce((n, r) => n + r.rewrites, 0);
  const todos = reports.reduce((n, r) => n + r.todos, 0);
  for (const r of reports) {
    console.log(`${path.relative(process.cwd(), r.file)}  rewrites=${r.rewrites} todos=${r.todos}${r.server ? ' SERVER' : ''}`);
  }
  console.log(`\n${reports.length} files, ${rewrites} rewrites, ${todos} TODO(core-3) markers${dry ? ' (dry run)' : ''}`);
}

if (import.meta.main) main();
