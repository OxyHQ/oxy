/**
 * An OPTIONAL peer must not be able to fail a consumer's Metro build.
 *
 * Metro resolves `import()` and `require()` of a string literal at BUILD time,
 * exactly like a static import: an app without the package fails to bundle with
 * `Unable to resolve module <peer>`, whether or not the call would ever run. The
 * one exception is a dependency Metro marks OPTIONAL, which it does (with
 * `allowOptionalDependencies`, on in every Expo Metro config) only when the
 * call sits in a statement whose NEAREST enclosing block is the block of a
 * `try`, counting at most three statements up (`isOptionalDependency` in
 * metro's `collectDependencies`, identical in metro 0.83 and 0.84). Metro 0.84
 * also accepts a `.catch()` promise chain; 0.83, which Expo 56 ships, does not,
 * so this gate accepts only the `try` shape.
 *
 * `ui/utils/clipboard.native.ts` once did `await import('expo-clipboard')`
 * outside any `try`. It is reachable from the root barrel, so every Android and
 * iOS bundle of an app that skipped the optional `expo-clipboard` failed, while
 * the file's own comment promised that such an app "still bundles and boots".
 * Measured in GoWay and in a minimal Expo 57 app (`expo export --platform
 * android`): red on 11.1.17, green once the `import()` is a direct statement of
 * a `try` block.
 *
 * The rule is re-implemented over the TypeScript AST rather than imported from
 * metro, which this package does not depend on; the positive controls below
 * pin it to metro's behaviour for the shapes that matter.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const packageRoot = path.resolve(__dirname, '../..');
const srcRoot = path.join(packageRoot, 'src');

const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

const OPTIONAL_PEERS = Object.entries(manifest.peerDependenciesMeta ?? {})
  .filter(([, meta]) => meta.optional === true)
  .map(([name]) => name)
  // Type packages are never loaded at runtime.
  .filter((name) => !name.startsWith('@types/'));

/**
 * Optional peers this package imports STATICALLY, each a decision with its
 * reason. A static import of an optional peer is a hard install requirement for
 * every bundle that reaches the importing file, so a new entry here needs the
 * same justification.
 */
const STATIC_OPTIONAL_PEER_IMPORTS: Record<string, string> = {
  // `expo` depends on `expo-modules-core`; an Expo app cannot be without it.
  'expo-modules-core': 'installed by expo itself',
  // The native keyboard boundary wraps the provider tree in `KeyboardProvider`.
  // An app on iOS/Android without this peer does not bundle; that is a known,
  // separate requirement, recorded here so it is not mistaken for optional.
  'react-native-keyboard-controller': 'native KeyboardBoundary needs it at bundle time',
};

function peerOf(specifier: string): string | null {
  return OPTIONAL_PEERS.find((peer) => specifier === peer || specifier.startsWith(`${peer}/`)) ?? null;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

const STATEMENT_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Block,
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.ExpressionStatement,
  ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ThrowStatement,
  ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.SwitchStatement,
  ts.SyntaxKind.LabeledStatement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
]);

/** metro's `isOptionalDependency`, minus the promise-chain form metro 0.83 lacks. */
function isMetroOptional(call: ts.Node): boolean {
  let statements = 0;
  let node: ts.Node | undefined = call;
  while (node && statements < 3) {
    if (STATEMENT_KINDS.has(node.kind)) {
      if (ts.isBlock(node)) {
        return node.parent !== undefined && ts.isTryStatement(node.parent) && node.parent.tryBlock === node;
      }
      statements += 1;
    }
    node = node.parent;
  }
  return false;
}

interface Load {
  peer: string;
  line: number;
  kind: 'dynamic' | 'static';
  optional: boolean;
}

function loadsIn(fileName: string, text: string): Load[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const loads: Load[] = [];
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const isLoad =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require');
      const [arg] = node.arguments;
      const peer = isLoad && arg && ts.isStringLiteralLike(arg) ? peerOf(arg.text) : null;
      if (peer) loads.push({ peer, line: lineOf(node), kind: 'dynamic', optional: isMetroOptional(node) });
    } else if (
      (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
      (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier)
    ) {
      const spec = node.moduleSpecifier;
      const peer = spec && ts.isStringLiteral(spec) ? peerOf(spec.text) : null;
      if (peer) loads.push({ peer, line: lineOf(node), kind: 'static', optional: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return loads;
}

describe('optional peer loads', () => {
  const files = sourceFiles(srcRoot);
  const loads = files.flatMap((file) =>
    loadsIn(file, fs.readFileSync(file, 'utf8')).map((load) => ({
      ...load,
      file: path.relative(srcRoot, file),
    })),
  );

  it('walks the real source tree and finds the known loads', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(OPTIONAL_PEERS).toEqual(expect.arrayContaining(['expo-clipboard', 'expo-notifications']));
    const found = new Set(loads.map((load) => `${load.file}:${load.peer}`));
    expect(found).toContain(`${path.join('ui', 'utils', 'clipboard.native.ts')}:expo-clipboard`);
    expect(found).toContain(`${path.join('notifications', 'deviceNotifications.ts')}:expo-notifications`);
  });

  it('loads every optional peer dynamically in a shape Metro marks optional', () => {
    const offenders = loads
      .filter((load) => load.kind === 'dynamic' && !load.optional)
      .map((load) => `${load.file}:${load.line} ${load.peer}`);
    expect(offenders).toEqual([]);
  });

  it('imports an optional peer statically only where recorded', () => {
    const offenders = loads
      .filter((load) => load.kind === 'static' && !(load.peer in STATIC_OPTIONAL_PEER_IMPORTS))
      .map((load) => `${load.file}:${load.line} ${load.peer}`);
    expect(offenders).toEqual([]);
  });

  describe('positive controls (the shapes metro marks, and the ones it does not)', () => {
    const verdict = (body: string) => loadsIn('fixture.ts', body).map((load) => load.optional);

    it('rejects an import() outside any try: the old clipboard shape', () => {
      expect(verdict(`export async function f() { const m = await import('expo-clipboard'); return m; }`)).toEqual([false]);
    });

    it('accepts an import() or require() that is a direct statement of a try block', () => {
      expect(verdict(`async function f() { try { return await import('expo-notifications'); } catch { return null; } }`)).toEqual([true]);
      expect(verdict(`function f() { try { const m = require('expo-clipboard'); return m; } catch { return null; } }`)).toEqual([true]);
    });

    it('rejects one block of nesting inside the try, and the catch block', () => {
      expect(verdict(`async function f(x: boolean) { try { if (x) { await import('expo-clipboard'); } } catch {} }`)).toEqual([false]);
      expect(verdict(`async function f() { try { g(); } catch { await import('expo-clipboard'); } }`)).toEqual([false]);
    });

    it('rejects a promise chain, which metro 0.83 does not mark optional', () => {
      expect(verdict(`function f() { return import('expo-clipboard').catch(() => null); }`)).toEqual([false]);
    });

    it('flags a static value import and ignores a type-only one', () => {
      expect(loadsIn('fixture.ts', `import { x } from 'expo-clipboard';`)).toHaveLength(1);
      expect(loadsIn('fixture.ts', `import type { x } from 'expo-clipboard';`)).toHaveLength(0);
    });
  });
});
