#!/usr/bin/env bun
/**
 * Exercises check-permission-vocabulary.mjs against fixture trees.
 *
 * A gate nobody has watched fail is not a gate, so the two directions of drift
 * are each PROVEN to go red here — a name removed from the Console copy, and a
 * phantom name added to it — beside a matched fixture that proves the check can
 * still pass. Without that third case, "everything fails" and "the gate works"
 * are the same observation.
 *
 * The case that decides whether the mechanism was chosen correctly is
 * `permission-named-in-a-comment`. The check reads the Console side with the
 * TypeScript compiler rather than a regex, and a regex census is exactly what
 * that fixture defeats: the union is missing a name, a doc comment above it
 * mentions that same name in prose, and the comment is full of apostrophes. A
 * scanner would read the comment, find the name, and report a match that does not
 * exist — the same class of bug that let an apostrophe in ordinary English open a
 * string literal and mis-publish a route's auth elsewhere in this repo.
 *
 * Every fixture is a throwaway tree under the OS temp dir with just the three
 * files the check reads. Nothing here touches the real repository, and the check
 * runs with `cwd` set to the fixture so it resolves its inputs there.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkScript = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'check-permission-vocabulary.mjs',
);
const fixturePrefix = join(tmpdir(), 'oxy-permission-vocabulary-');
const createdFixtures = [];
const failures = [];

/**
 * A vocabulary comfortably above the check's own floor of 8, so a fixture failing
 * for being too small is a case this suite states on purpose rather than a side
 * effect of every other case.
 */
const ACCOUNT_NAMES = [
  'account:read',
  'account:update',
  'account:delete',
  'members:read',
  'members:invite',
  'apps:read',
  'apps:create',
  'billing:read',
  'billing:manage',
  'ownership:transfer',
];

const APPLICATION_NAMES = [
  'app:read',
  'app:update',
  'app:delete',
  'members:read',
  'credentials:read',
  'credentials:create',
  'webhooks:read',
  'webhooks:update',
  'usage:read',
  'billing:read',
];

function runCheck(cwd) {
  try {
    const stdout = execFileSync('bun', [checkScript], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function write(root, relativePath, contents) {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

/** The source module, as a tuple pair. Imports nothing, like the real one. */
function sourceModuleSource(accountNames, applicationNames) {
  const tuple = (names) => names.map((name) => `  '${name}',`).join('\n');
  return (
    `export const ACCOUNT_PERMISSIONS = [\n${tuple(accountNames)}\n] as const;\n\n` +
    `export const APPLICATION_PERMISSIONS = [\n${tuple(applicationNames)}\n] as const;\n`
  );
}

/** A Console file declaring one exported union. */
function consoleUnionSource(typeName, names, { header = '', exported = true, body = null } = {}) {
  const declaration =
    body ?? `${names.map((name) => `  | '${name}'`).join('\n')};`;
  return `${header}${exported ? 'export ' : ''}type ${typeName} =\n${declaration}\n`;
}

/**
 * A complete fixture. Overrides replace whole file bodies, so a case can be
 * malformed in exactly one way without disturbing the other lane.
 */
function createFixture({ account = {}, application = {}, source = {} } = {}) {
  const root = mkdtempSync(fixturePrefix);
  createdFixtures.push(root);

  write(
    root,
    'packages/api/src/utils/accountRoles.ts',
    source.text ??
      sourceModuleSource(source.accountNames ?? ACCOUNT_NAMES, source.applicationNames ?? APPLICATION_NAMES),
  );
  write(
    root,
    'packages/console/src/hooks/use-account.tsx',
    account.text ?? consoleUnionSource('AccountPermission', account.names ?? ACCOUNT_NAMES, account),
  );
  write(
    root,
    'packages/console/src/hooks/use-applications.ts',
    application.text ??
      consoleUnionSource('ApplicationPermission', application.names ?? APPLICATION_NAMES, application),
  );
  return root;
}

function expectVerdict(caseName, root, expectedCode, expectedFragments) {
  const { code, output } = runCheck(root);
  if (code !== expectedCode) {
    failures.push(`${caseName}: expected exit ${expectedCode}, got ${code}.\n${output}`);
    return;
  }
  for (const fragment of [expectedFragments].flat()) {
    if (!output.includes(fragment)) {
      failures.push(`${caseName}: output does not contain ${JSON.stringify(fragment)}.\n${output}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  The positive control: the gate can pass                                   */
/* -------------------------------------------------------------------------- */

expectVerdict('matched', createFixture(), 0, [
  'Permission vocabulary matches',
  'account 10, application 10',
]);

/* -------------------------------------------------------------------------- */
/*  Both directions of drift                                                  */
/* -------------------------------------------------------------------------- */

// DIRECTION 1 — a name in the source that Console does not list. This is the
// live case in the real repository: #1032 added inference permissions the Console
// unions never learned, so no Console surface can ask about them.
expectVerdict(
  'name-removed-from-console-account-lane',
  createFixture({ account: { names: ACCOUNT_NAMES.filter((name) => name !== 'apps:create') } }),
  1,
  ['account lane', 'does not list', 'apps:create'],
);

expectVerdict(
  'name-removed-from-console-application-lane',
  createFixture({
    application: { names: APPLICATION_NAMES.filter((name) => name !== 'webhooks:update') },
  }),
  1,
  ['application lane', 'does not list', 'webhooks:update'],
);

// DIRECTION 2 — a name Console lists that the API does not grant. It authorizes
// nothing, so the affordance behind it is disabled forever and reads as a
// permissions problem rather than as a typo.
expectVerdict(
  'phantom-name-in-console-account-lane',
  createFixture({ account: { names: [...ACCOUNT_NAMES, 'account:teleport'] } }),
  1,
  ['account lane', 'authorize nothing', 'account:teleport'],
);

expectVerdict(
  'phantom-name-in-console-application-lane',
  createFixture({ application: { names: [...APPLICATION_NAMES, 'app:teleport'] } }),
  1,
  ['application lane', 'authorize nothing', 'app:teleport'],
);

// Both directions at once still reports both, rather than stopping at the first.
expectVerdict(
  'drift-in-both-directions',
  createFixture({
    account: { names: [...ACCOUNT_NAMES.filter((name) => name !== 'apps:read'), 'account:teleport'] },
  }),
  1,
  ['apps:read', 'account:teleport'],
);

/* -------------------------------------------------------------------------- */
/*  The mechanism case: prose is not a vocabulary                             */
/* -------------------------------------------------------------------------- */

// The reason this check parses instead of scanning. The union is MISSING
// `apps:create`, and the comment above it names `apps:create` in prose stuffed
// with apostrophes. A regex census would find the name in the comment and report
// a match that does not exist; the compiler's lexer cannot.
expectVerdict(
  'permission-named-in-a-comment',
  createFixture({
    account: {
      names: ACCOUNT_NAMES.filter((name) => name !== 'apps:create'),
      header:
        "/**\n" +
        " * The caller's own permissions, as the account's membership reports them.\n" +
        " *\n" +
        " * Deliberately does not carry 'apps:create': an account's app-creation right\n" +
        " * isn't something this screen's affordances can offer, and it's the API's to\n" +
        " * grant. Don't add 'apps:create' here without a surface that uses it.\n" +
        " */\n",
    },
  }),
  1,
  ['does not list', 'apps:create'],
);

/* -------------------------------------------------------------------------- */
/*  Vacuity floor and malformed inputs                                        */
/* -------------------------------------------------------------------------- */

// A truncated read must FAIL rather than pass by comparing two tiny sets. Both
// sides are shrunk to the same three names, so the comparison itself would agree
// perfectly — only the floor catches it.
expectVerdict(
  'below-the-vacuity-floor',
  createFixture({
    source: { accountNames: ACCOUNT_NAMES.slice(0, 3) },
    account: { names: ACCOUNT_NAMES.slice(0, 3) },
  }),
  1,
  ['below the floor', 'not measuring the vocabulary'],
);

expectVerdict(
  'console-type-alias-renamed',
  createFixture({ account: { text: consoleUnionSource('AccountPermissions', ACCOUNT_NAMES) } }),
  1,
  ['declares no top-level type alias', 'AccountPermission'],
);

expectVerdict(
  'console-type-not-exported',
  createFixture({ account: { exported: false } }),
  1,
  ['is not exported'],
);

expectVerdict(
  'console-type-is-not-a-union',
  createFixture({ account: { text: 'export type AccountPermission = string;\n' } }),
  1,
  ['is not a union of string literals'],
);

// A single-member union is a valid union node but not a vocabulary, and it is
// what a truncated generator would emit.
expectVerdict(
  'console-union-has-a-non-literal-member',
  createFixture({
    account: { text: "export type AccountPermission =\n  | 'account:read'\n  | (string & {});\n" },
  }),
  1,
  ['not a string literal'],
);

expectVerdict(
  'console-union-repeats-a-name',
  createFixture({ account: { names: [...ACCOUNT_NAMES, 'account:read'] } }),
  1,
  ['more than once', 'account:read'],
);

expectVerdict(
  'source-export-renamed',
  createFixture({
    source: {
      text: sourceModuleSource(ACCOUNT_NAMES, APPLICATION_NAMES).replace(
        'ACCOUNT_PERMISSIONS',
        'ACCOUNT_PERMS',
      ),
    },
  }),
  1,
  ['does not export an array named', 'ACCOUNT_PERMISSIONS'],
);

expectVerdict(
  'source-tuple-is-not-flat-strings',
  createFixture({
    source: {
      text:
        'export const ACCOUNT_PERMISSIONS = [\n' +
        "  'account:read',\n" +
        "  { name: 'account:update' },\n" +
        '] as const;\n\n' +
        'export const APPLICATION_PERMISSIONS = [] as const;\n',
    },
  }),
  1,
  ['non-string'],
);

// The source module is IMPORTED, so a module that cannot be evaluated must be a
// loud failure rather than an empty vocabulary that passes.
expectVerdict(
  'source-module-throws-on-import',
  createFixture({ source: { text: 'throw new Error("boom");\n' } }),
  1,
  ['could not be imported'],
);

/* -------------------------------------------------------------------------- */

for (const root of createdFixtures) {
  rmSync(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`\n${failures.length} fixture case(s) did not behave as expected:\n`);
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log(
  `Permission vocabulary check discriminated ${createdFixtures.length} fixture case(s), ` +
    'including both directions of drift and a permission named only in a comment.',
);
