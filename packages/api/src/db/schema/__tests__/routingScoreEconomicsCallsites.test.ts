import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SCORE_TABLES = new Set([
  'inferenceDeploymentRoutingScores',
  'inferenceDeploymentRoutingScoreEvents',
]);
const REQUIRED_ECONOMICS = new Set(['fundingClass', 'fundingState', 'fundingEvidenceRef']);

function typescriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const resolved = path.join(directory, entry.name);
    return entry.isDirectory()
      ? typescriptFiles(resolved)
      : entry.isFile() && entry.name.endsWith('.ts')
        ? [resolved]
        : [];
  });
}

test('every application and script routing-score insert states reviewed economics', () => {
  const apiRoot = path.resolve(__dirname, '../../../..');
  const files = [
    ...typescriptFiles(path.join(apiRoot, 'src')),
    ...typescriptFiles(path.join(apiRoot, 'scripts')),
  ];
  const callsites: string[] = [];

  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const declarations = new Map<string, { readonly position: number; readonly value: ts.Expression }[]>();
    const collectDeclarations = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined
      ) {
        declarations.set(node.name.text, [
          ...(declarations.get(node.name.text) ?? []),
          { position: node.getStart(source), value: node.initializer },
        ]);
      }
      ts.forEachChild(node, collectDeclarations);
    };
    collectDeclarations(source);

    const economicsOf = (
      expression: ts.Expression,
      callPosition: number,
      seen = new Set<string>()
    ): Set<string> => {
      if (ts.isIdentifier(expression)) {
        if (seen.has(expression.text)) return new Set();
        const declaration = declarations
          .get(expression.text)
          ?.filter((candidate) => candidate.position < callPosition)
          .sort((left, right) => right.position - left.position)[0];
        if (declaration === undefined) return new Set();
        return economicsOf(
          declaration.value,
          declaration.position,
          new Set([...seen, expression.text])
        );
      }
      if (!ts.isObjectLiteralExpression(expression)) return new Set();
      const fields = new Set<string>();
      for (const property of expression.properties) {
        if (ts.isSpreadAssignment(property)) {
          for (const field of economicsOf(property.expression, callPosition, seen)) {
            fields.add(field);
          }
          continue;
        }
        if (
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          ts.isIdentifier(property.name) &&
          REQUIRED_ECONOMICS.has(property.name.text)
        ) {
          fields.add(property.name.text);
        }
      }
      return fields;
    };

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'values' &&
        ts.isCallExpression(node.expression.expression) &&
        ts.isPropertyAccessExpression(node.expression.expression.expression) &&
        node.expression.expression.expression.name.text === 'insert'
      ) {
        const insert = node.expression.expression;
        const table = insert.arguments[0];
        if (table !== undefined && ts.isIdentifier(table) && SCORE_TABLES.has(table.text)) {
          const relative = path.relative(apiRoot, file);
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          callsites.push(`${relative}:${line}`);
          const fields =
            node.arguments[0] === undefined
              ? new Set()
              : economicsOf(node.arguments[0], node.getStart(source));
          expect([...fields].sort()).toEqual([...REQUIRED_ECONOMICS].sort());
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  expect(callsites).toHaveLength(10);
});
