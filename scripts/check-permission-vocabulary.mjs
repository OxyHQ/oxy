#!/usr/bin/env bun
/**
 * Fail the build when `packages/console`'s permission unions drift from the
 * API's permission vocabulary.
 *
 * ISSUE #972 WORKSTREAM 9 — THE CONSOLE/API VOCABULARY BOUNDARY
 *
 * `packages/api/src/utils/accountRoles.ts` owns two vocabularies,
 * `ACCOUNT_PERMISSIONS` and `APPLICATION_PERMISSIONS`, and derives its own types
 * from them (`(typeof ACCOUNT_PERMISSIONS)[number]`) so the API side cannot
 * disagree with itself. `packages/console` HAND-DUPLICATES both as string-literal
 * unions, in `src/hooks/use-account.tsx` and `src/hooks/use-applications.ts`.
 *
 * WHY A GATE AND NOT A TYPECHECK
 *
 * There is no compile signal for this drift, and that is not an oversight in the
 * Console — it is structural. `@oxyhq/core` types the wire field as
 * `AccountMember.permissions: string[]`, not as a permission union, so nothing
 * flows from the API into Console's local unions. Console's copies are consumed
 * only as PARAMETER types (`hasPermission(account, permissions:
 * Array<AccountPermission>)`, `can(permission: ApplicationPermission)`) whose
 * call sites pass literals Console itself wrote, and the membership check is
 * `granted.includes(p)` over a `string[]`. So the copies can drift arbitrarily
 * far, in either direction, and `tsc --noEmit` stays green over all of it.
 *
 * WHAT IT WOULD HAVE CAUGHT
 *
 * It was already broken when this was written. PR #1032 added six account-lane
 * strings (`inference:invoke`, `inference:routing:read`/`:write`,
 * `inference:providers:read`/`:write`, `inference:usage:read`) and five
 * application-lane strings (`inference:invoke`,
 * `inference:routing:read`/`:write`, `inference:byok:read`/`:write`) to the
 * source of truth. Console knows none of them, so a Console surface cannot ask
 * about a single inference permission — `access.can('inference:byok:read')` is a
 * compile ERROR in Console today, for a permission the API really grants.
 *
 * BOTH DIRECTIONS FAIL, FOR DIFFERENT REASONS
 *
 *   - In the source, missing from Console: Console cannot offer a permission the
 *     API grants. This is the live case above.
 *   - In Console, missing from the source: Console offers a permission that
 *     authorizes NOTHING. `granted.includes(p)` answers false forever, so the
 *     affordance is permanently disabled and looks like a permissions problem
 *     rather than a typo.
 *
 * HOW EACH SIDE IS READ, AND WHY THE TWO DIFFER
 *
 * Neither side is scanned with a regex. A census over source text that reads a
 * name out of a doc comment measures the comment, and this repo has already been
 * bitten by the sharper version of that — an apostrophe in ordinary English
 * opened a string literal that swallowed 450 lines and mis-published a route's
 * auth.
 *
 *   - The SOURCE side is IMPORTED. `accountRoles.ts` imports nothing at all, so
 *     evaluating it is inert, and the tuples then arrive as the real runtime
 *     values the API actually authorizes against. That is stronger than parsing
 *     its text: it stays correct if the arrays are ever composed by a spread, a
 *     filter or a concatenation instead of written out as literals.
 *   - The CONSOLE side is PARSED WITH THE TYPESCRIPT COMPILER. A type alias has
 *     no runtime value, so importing it is not an option. `typescript` is already
 *     a dependency of this repo and its own lexer handles comments, apostrophes
 *     and template strings by construction, so the extraction cannot be confused
 *     by the file's prose.
 *
 * The lane table below is the only hand-written thing here, and it is the
 * CORRESPONDENCE being asserted rather than a list of names: a lane names one
 * source export and one Console type, and every name on both sides is then
 * discovered. Nothing is derived from a filename, and nothing is skipped for
 * being absent from a map — a lane whose export or type alias cannot be found is
 * a hard failure, because a lane that quietly resolved to nothing would pass by
 * comparing nothing.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

/** The module that owns both vocabularies. Imported, not parsed — see the header. */
const SOURCE_MODULE = 'packages/api/src/utils/accountRoles.ts';

/**
 * The two vocabularies, each as (source export ↔ Console declaration).
 *
 * `label` is for the failure message only and is never used to look anything up.
 */
const LANES = [
  {
    label: 'account',
    sourceExport: 'ACCOUNT_PERMISSIONS',
    consoleFile: 'packages/console/src/hooks/use-account.tsx',
    consoleType: 'AccountPermission',
  },
  {
    label: 'application',
    sourceExport: 'APPLICATION_PERMISSIONS',
    consoleFile: 'packages/console/src/hooks/use-applications.ts',
    consoleType: 'ApplicationPermission',
  },
];

/**
 * The vacuity floor, per side, per lane.
 *
 * A broken extractor returns zero names (the alias was not found, the import
 * shape changed) or one (only the first union member was read), and either would
 * make every set comparison below agree with itself about nothing. The real
 * vocabularies carry twenty-plus names each and only ever grow, so a floor here
 * cannot be eroded by legitimate additions the way a `>= current count` floor
 * would be — and it sits far above what any broken read produces.
 */
const MINIMUM_NAMES = 8;

const failures = [];

/**
 * Every string in one exported tuple of the source module.
 *
 * Refuses anything that is not an array of strings rather than coercing: a
 * vocabulary that stopped being a flat string tuple is a change this comparison
 * has to be taught, not one it should quietly reinterpret.
 */
function sourceNames(module, exportName) {
  const value = module[exportName];
  if (!Array.isArray(value)) {
    return {
      error:
        `${SOURCE_MODULE} does not export an array named \`${exportName}\` ` +
        `(got ${value === undefined ? 'nothing' : typeof value}).`,
    };
  }
  const nonStrings = value.filter((entry) => typeof entry !== 'string');
  if (nonStrings.length > 0) {
    return {
      error:
        `\`${exportName}\` in ${SOURCE_MODULE} contains ${nonStrings.length} non-string ` +
        'entry/entries, so it is no longer a flat permission tuple.',
    };
  }
  return { names: value };
}

/**
 * Every string-literal member of an exported union type alias.
 *
 * Parsed with the real compiler, so comments and apostrophes are the lexer's
 * problem and not this file's. `setParentNodes` is off because nothing here walks
 * upward, and the script kind is chosen from the extension because `.tsx`
 * resolves `<` as JSX while `.ts` resolves it as a type argument.
 */
function consoleUnionNames(filePath, typeName) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    return { error: `${filePath} could not be read: ${error.message}` };
  }

  const source = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    false,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const alias = source.statements.find(
    (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName,
  );
  if (alias === undefined) {
    return {
      error:
        `${filePath} declares no top-level type alias \`${typeName}\`. If it moved, point this ` +
        'lane at the new declaration rather than letting the comparison stop running.',
    };
  }

  // Exported, because a type the Console cannot import is not the vocabulary its
  // components are gated on.
  const isExported = (alias.modifiers ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
  );
  if (!isExported) {
    return { error: `\`${typeName}\` in ${filePath} is not exported.` };
  }

  if (!ts.isUnionTypeNode(alias.type)) {
    return {
      error:
        `\`${typeName}\` in ${filePath} is not a union of string literals, so its members cannot ` +
        'be compared name by name.',
    };
  }

  const names = [];
  for (const member of alias.type.types) {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
      return {
        error:
          `\`${typeName}\` in ${filePath} has a member that is not a string literal, so the union ` +
          'is no longer a plain vocabulary.',
      };
    }
    names.push(member.literal.text);
  }
  return { names };
}

const sourcePath = resolve(process.cwd(), SOURCE_MODULE);
let sourceModule;
try {
  sourceModule = await import(pathToFileURL(sourcePath).href);
} catch (error) {
  console.error(
    `\n${SOURCE_MODULE} could not be imported, so the permission vocabulary it owns cannot be\n` +
      `read: ${error.message}\n\n` +
      'This module is expected to import nothing, which is what makes evaluating it safe. If it\n' +
      'now pulls in configuration or a database client, read its tuples another way rather than\n' +
      'letting this check stop comparing.\n',
  );
  process.exit(1);
}

for (const lane of LANES) {
  const source = sourceNames(sourceModule, lane.sourceExport);
  if (source.error !== undefined) {
    failures.push(source.error);
    continue;
  }
  const consoleSide = consoleUnionNames(resolve(process.cwd(), lane.consoleFile), lane.consoleType);
  if (consoleSide.error !== undefined) {
    failures.push(consoleSide.error);
    continue;
  }

  // Vacuity floor, both sides, before any comparison. A set operation over an
  // empty set reports agreement.
  for (const [side, names, origin] of [
    ['source', source.names, `\`${lane.sourceExport}\` in ${SOURCE_MODULE}`],
    ['console', consoleSide.names, `\`${lane.consoleType}\` in ${lane.consoleFile}`],
  ]) {
    if (names.length < MINIMUM_NAMES) {
      failures.push(
        `${lane.label} lane: only ${names.length} name(s) read from the ${side} side ` +
          `(${origin}), below the floor of ${MINIMUM_NAMES}. A comparison over a set that small ` +
          'is not measuring the vocabulary.',
      );
    }
  }

  const sourceSet = new Set(source.names);
  const consoleSet = new Set(consoleSide.names);

  const duplicated = consoleSide.names.filter((name, index) => consoleSide.names.indexOf(name) !== index);
  if (duplicated.length > 0) {
    failures.push(
      `${lane.label} lane: \`${lane.consoleType}\` lists ${[...new Set(duplicated)].sort().join(', ')} ` +
        'more than once.',
    );
  }

  const missingFromConsole = source.names.filter((name) => !consoleSet.has(name)).sort();
  if (missingFromConsole.length > 0) {
    failures.push(
      `${lane.label} lane: the API grants ${missingFromConsole.length} permission(s) that ` +
        `\`${lane.consoleType}\` (${lane.consoleFile}) does not list, so no Console surface can ask ` +
        `about them:\n      ${missingFromConsole.join('\n      ')}`,
    );
  }

  const missingFromSource = consoleSide.names.filter((name) => !sourceSet.has(name)).sort();
  if (missingFromSource.length > 0) {
    failures.push(
      `${lane.label} lane: \`${lane.consoleType}\` (${lane.consoleFile}) lists ` +
        `${missingFromSource.length} permission(s) that \`${lane.sourceExport}\` does not grant, so ` +
        `they authorize nothing and every check on them answers false forever:\n      ${missingFromSource.join('\n      ')}`,
    );
  }
}

if (failures.length > 0) {
  console.error(
    "\npackages/console's permission unions do not match the API's permission vocabulary.\n\n" +
      `${failures.map((failure) => `  - ${failure}`).join('\n')}\n\n` +
      `Source of truth: ${SOURCE_MODULE}.\n` +
      'There is no compile error for this: `AccountMember.permissions` is typed `string[]`, so\n' +
      "nothing flows from the API into Console's local unions and they can drift silently in\n" +
      'either direction. Fix by editing the Console union to match, name for name.\n',
  );
  process.exit(1);
}

const summary = LANES.map((lane) => {
  const { names } = sourceNames(sourceModule, lane.sourceExport);
  return `${lane.label} ${names.length}`;
}).join(', ');
console.log(
  `Permission vocabulary matches between ${SOURCE_MODULE} and packages/console ` +
    `(${LANES.length} lane(s), by name in both directions: ${summary}).`,
);
