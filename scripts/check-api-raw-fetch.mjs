#!/usr/bin/env bun

/**
 * Refuse a raw WHATWG `fetch` in `packages/api/src`: every outbound fetch goes
 * through `tracedFetch` (`packages/api/src/utils/tracedFetch.ts`).
 *
 * ## WHY
 *
 * The API's OpenTelemetry setup traced `fetch` through
 * `@opentelemetry/instrumentation-undici`, which listens to undici's
 * `diagnostics_channel` events. Node's built-in `fetch` is undici and publishes
 * them; Bun's native `fetch` publishes none. Measured on Bun 1.4.3 against the
 * built API: zero `undici:*` events, zero client spans, and no `traceparent` on
 * the outbound request — so Oxy → Kaana inference, Expo push, the Alia webhook
 * and every other `fetch` would leave X-Ray without an error anywhere. A raw
 * `fetch` added after the wrapper landed would reopen that hole one call at a
 * time, on a runtime where nothing else notices.
 *
 * ## WHAT COUNTS
 *
 * Any reference to the GLOBAL `fetch` as a value, by any spelling: a call
 * `fetch(...)`, `globalThis.fetch` / `global.fetch` / `window.fetch` /
 * `self.fetch`, the bare name passed or stored (`{ fetch }`, `const f = fetch`).
 * NOT counted, because none of them reach the global at run time: a member
 * named `fetch` on some other object (`transport.fetch(...)`), a property or
 * method DECLARED with that name, and a TYPE position (`typeof fetch` as a
 * type). A file that declares its own binding named `fetch` is still counted —
 * shadowing is the kind of thing that should be read, so it needs an allow-list
 * entry saying so.
 *
 * ## HOW IT CANNOT PASS VACUOUSLY
 *
 *   - It parses with the TypeScript compiler, so comments and strings that
 *     mention `fetch(` (the wrapper's own header, `email.service.ts`'s SSRF
 *     note) are never counted. A file that fails to parse is a failure, not a
 *     quiet zero.
 *   - Floors on files read and identifiers walked: a corpus that did not resolve
 *     reports exactly what a clean tree reports.
 *   - {@link ALLOWED} is exact in both directions: an entry whose file no longer
 *     has the reference at its stated count fails. The wrapper's own two
 *     `globalThis.fetch` calls are on it, so a traversal that stopped seeing
 *     `fetch` fails here even on a clean tree.
 *
 * `scripts/test-check-api-raw-fetch.mjs` is the positive control: it plants
 * every counted shape in a fixture tree and requires each to fail, beside a
 * fixture that must pass and fixtures of every NOT-counted shape that must not
 * fire.
 *
 * Usage:  bun scripts/check-api-raw-fetch.mjs   (from the repository root)
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const CORPUS_ROOT = join('packages', 'api', 'src');

/** Globals through which the same `fetch` can be reached as a member. */
const GLOBAL_OBJECTS = new Set(['globalThis', 'global', 'window', 'self']);

/**
 * The places allowed to reach the global `fetch`, and how many times. Exact in
 * both directions: a reference with no entry fails, and an entry whose file no
 * longer holds that many fails too.
 */
const ALLOWED = [
  {
    file: 'packages/api/src/utils/tracedFetch.ts',
    expression: 'globalThis.fetch',
    count: 2,
    why:
      'THE wrapper: the traced call itself, and the untraced pass-through for an input that is ' +
      'not a URL (fetch then raises its own error). Read at call time so a test replacing ' +
      '`globalThis.fetch` still sees the call.',
  },
  {
    file: 'packages/api/src/services/platformActivity.service.ts',
    expression: 'globalThis.fetch',
    count: 4,
    why:
      'Not an outbound call: platform-activity accounting REPLACES the global with an observed ' +
      'wrapper at start-up and restores the original on stop (read, assign, compare, restore). ' +
      '`tracedFetch` reads the global at call time, so traced calls are still counted by it.',
  },
];

const fixtureFloors = process.env.API_RAW_FETCH_FIXTURE_FLOORS === '1';
/** Measured when written: 776 files, 276163 identifiers. Below both, far above zero. */
const MINIMUM_FILES = fixtureFloors ? 1 : 600;
const MINIMUM_IDENTIFIERS = fixtureFloors ? 1 : 200_000;

if (process.env.API_RAW_FETCH_EMIT_POLICY === '1') {
  console.log(
    JSON.stringify({
      corpusRoot: CORPUS_ROOT,
      globalObjects: [...GLOBAL_OBJECTS],
      allowed: ALLOWED.map(({ file, expression, count }) => ({ file, expression, count })),
    }),
  );
  process.exit(0);
}

const SKIP_DIRECTORIES = new Set(['__tests__', '__mocks__', '__fixtures__', 'node_modules']);

function sourceFilesUnder(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry)) sourceFilesUnder(path, out);
      continue;
    }
    if (!/\.tsx?$/.test(path)) continue;
    if (/\.(test|spec)\.tsx?$/.test(path)) continue;
    if (path.endsWith('.d.ts')) continue;
    out.push(path);
  }
  return out;
}

/** True when `node` is the NAME being declared, not a reference. */
function isDeclarationName(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isMethodSignature(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) return true;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (ts.isLabeledStatement(parent) || ts.isBreakOrContinueStatement(parent)) return true;
  return false;
}

/** True when `node` sits in a type position (`typeof fetch` as a type, generics...). */
function isInTypePosition(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isExpressionWithTypeArguments(current) && ts.isHeritageClause(current.parent)) {
      return false;
    }
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

const problems = [];
const found = new Map();
const locations = new Map();
const key = (file, expression) => JSON.stringify([file, expression]);

if (!existsSync(CORPUS_ROOT)) {
  problems.push(`${CORPUS_ROOT} does not exist. Run this from the repository root.`);
}
const files = existsSync(CORPUS_ROOT) ? sourceFilesUnder(CORPUS_ROOT).sort() : [];
let identifiers = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const parseDiagnostics = sourceFile.parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    const first = ts.flattenDiagnosticMessageText(parseDiagnostics[0].messageText, ' ');
    problems.push(`${file} did not parse (${first}), so nothing in it was inspected.`);
    continue;
  }
  const record = (node, expression) => {
    const k = key(file.split('\\').join('/'), expression);
    found.set(k, (found.get(k) ?? 0) + 1);
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    locations.set(k, [...(locations.get(k) ?? []), line]);
  };

  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      identifiers += 1;
      if (node.text === 'fetch') {
        const parent = node.parent;
        if (
          parent &&
          ts.isPropertyAccessExpression(parent) &&
          parent.name === node &&
          ts.isIdentifier(parent.expression) &&
          GLOBAL_OBJECTS.has(parent.expression.text)
        ) {
          record(node, `${parent.expression.text}.fetch`);
        } else if (!isDeclarationName(node) && !isInTypePosition(node)) {
          record(node, 'fetch');
        }
      }
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_OBJECTS.has(node.expression.text) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      node.argumentExpression.text === 'fetch'
    ) {
      record(node, `${node.expression.text}['fetch']`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

const unlisted = [];
for (const [k, count] of found) {
  const [file, expression] = JSON.parse(k);
  const entry = ALLOWED.find((a) => a.file === file && a.expression === expression);
  if (!entry) unlisted.push({ file, expression, count, lines: locations.get(k) });
}
for (const entry of ALLOWED) {
  const count = found.get(key(entry.file, entry.expression)) ?? 0;
  if (count !== entry.count) {
    problems.push(
      `ALLOWED says ${entry.file} reaches \`${entry.expression}\` ${entry.count} time(s); found ` +
        `${count}. Update the entry in the same commit as the code, or — if this is 0 on a tree ` +
        'you did not change — the census stopped seeing `fetch`.',
    );
  }
}
if (files.length < MINIMUM_FILES) {
  problems.push(
    `${files.length} file(s) read under ${CORPUS_ROOT} is below the ${MINIMUM_FILES} floor; the ` +
      'corpus is not resolving.',
  );
}
if (identifiers < MINIMUM_IDENTIFIERS) {
  problems.push(
    `${identifiers} identifier(s) walked is below the ${MINIMUM_IDENTIFIERS} floor; the ` +
      'traversal is not descending.',
  );
}

if (unlisted.length > 0 || problems.length > 0) {
  console.error('API raw-fetch guard FAILED:\n');
  for (const u of unlisted) {
    console.error(
      `  ${u.file}:${u.lines.join(',')} — \`${u.expression}\` (×${u.count}) reaches the global ` +
        'fetch.\n',
    );
  }
  for (const problem of problems) console.error(`  ${problem}\n`);
  if (unlisted.length > 0) {
    console.error(
      "  Call `tracedFetch` from packages/api/src/utils/tracedFetch.ts instead. Bun's fetch is\n" +
        '  invisible to the undici instrumentation, so a raw fetch records no client span and\n' +
        '  sends no traceparent. If a hit is not the global fetch, add an ALLOWED entry in\n' +
        '  scripts/check-api-raw-fetch.mjs saying what it is.\n',
    );
  }
  process.exit(1);
}

console.log(
  `API raw-fetch guard passed — ${files.length} files under ${CORPUS_ROOT}, ${identifiers} ` +
    `identifiers walked, no raw fetch; ${ALLOWED.length} allowed reference(s) present at their ` +
    'stated counts.',
);
