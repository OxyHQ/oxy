#!/usr/bin/env bun

/**
 * Mutation-tests `check-no-payload-persistence.mjs` against fixture schemas.
 *
 * The guard is an ABSENCE check over the real schema, and an absence check that
 * inspected nothing reports exactly what a clean schema reports. So the cases
 * that matter most are the ones where a payload column IS present and the guard
 * has to find it — the positive control the AGENTS.md census rule demands.
 *
 * Fixtures are real drizzle schema modules written to a temp directory and handed
 * to the REAL guard through `PAYLOAD_PERSISTENCE_SCHEMA`. They import
 * `drizzle-orm/pg-core` by absolute URL, resolved from this repository, so the
 * fixture's `pgTable` and the guard's `PgTable` are the same module instance and
 * `is()` recognises the tables — a second copy of drizzle would make every
 * fixture look like an empty schema, which is the exact failure this file is
 * meant to catch elsewhere.
 *
 * The banned patterns, the declared-column list and the required tables come from
 * the guard itself. The clean fixture is built from the declared list, so it is
 * also the assertion that every entry names a column the census really would find.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guard = resolve(repositoryRoot, 'scripts/check-no-payload-persistence.mjs');
const pgCoreUrl = import.meta.resolve('drizzle-orm/pg-core');

function policy() {
  const emitted = Bun.spawnSync({
    cmd: ['bun', guard],
    cwd: repositoryRoot,
    env: { ...process.env, PAYLOAD_PERSISTENCE_EMIT_POLICY: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (emitted.exitCode !== 0) {
    throw new Error(`The guard would not emit its policy: ${emitted.stderr.toString()}`);
  }
  return JSON.parse(emitted.stdout.toString());
}

const { banned, declared, requiredTables } = policy();

if (banned.length === 0 || declared.length === 0 || requiredTables.length === 0) {
  console.error('The guard emitted an empty policy; there is nothing to test.');
  process.exit(1);
}

/**
 * A schema module source from `{ tableName: { columnName: 'builder()' } }`.
 *
 * Every table gets an `id: text()` so a table is never column-less, which is not
 * a shape the real schema has and would exercise a branch that does not exist.
 */
function schemaSource(tables) {
  const lines = [`import { boolean, integer, jsonb, pgTable, text } from '${pgCoreUrl}';`, ''];
  let index = 0;
  for (const [tableName, columns] of Object.entries(tables)) {
    const body = Object.entries(columns)
      .map(([column, builder]) => `  ${column}: ${builder},`)
      .join('\n');
    lines.push(`export const t${index} = pgTable('${tableName}', {`, '  id: text(),', body, '});', '');
    index += 1;
  }
  return lines.join('\n');
}

/**
 * A schema the guard must accept.
 *
 * One table per declared open-shaped column, holding exactly that column as
 * `jsonb`, plus every required table. Built from the guard's own list, so the
 * clean case is simultaneously the proof that no entry has gone stale and that
 * the census reaches the tables the policy names.
 */
function cleanTables(extra = {}) {
  const tables = {};
  for (const entry of declared) {
    tables[entry.table] = { ...(tables[entry.table] ?? {}), [entry.column]: 'jsonb()' };
  }
  for (const table of requiredTables) {
    tables[table] = tables[table] ?? { requestId: 'text()' };
  }
  for (const [table, columns] of Object.entries(extra)) {
    tables[table] = { ...(tables[table] ?? {}), ...columns };
  }
  return tables;
}

async function runAgainst(tables, { realFloors = false, source } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'oxy-payload-guard-'));
  const modulePath = join(directory, 'schema.ts');
  try {
    await writeFile(modulePath, source ?? schemaSource(tables));
    const environment = { ...process.env, PAYLOAD_PERSISTENCE_SCHEMA: modulePath };
    if (!realFloors) environment.PAYLOAD_PERSISTENCE_FIXTURE_FLOORS = '1';
    const proc = Bun.spawnSync({
      cmd: ['bun', guard],
      cwd: repositoryRoot,
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: proc.exitCode,
      output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * The planted payload columns — the positive controls. Each is a shape a
 * well-meaning engineer would actually write while adding debug capture.
 *
 * Coverage against the guard's own pattern list is asserted below, so a pattern
 * added to the guard with no case here fails this file rather than going untested.
 */
const PLANTED = [
  { column: 'promptText', builder: 'text()', holds: 'a prompt' },
  { column: 'systemPrompt', builder: 'text()', holds: 'a prompt' },
  { column: 'completionText', builder: 'text()', holds: 'a completion' },
  { column: 'debugPayload', builder: 'jsonb()', holds: 'a request or response payload' },
  { column: 'conversationTranscript', builder: 'text()', holds: 'a conversation transcript' },
  { column: 'chatLog', builder: 'text()', holds: 'a conversation transcript' },
  { column: 'toolArguments', builder: 'text()', holds: "a tool call's arguments or result" },
  { column: 'toolCallResult', builder: 'text()', holds: "a tool call's arguments or result" },
  { column: 'rawRequest', builder: 'text()', holds: 'a raw request' },
  { column: 'requestBody', builder: 'text()', holds: 'a raw request' },
  { column: 'rawResponse', builder: 'text()', holds: 'a raw response' },
  { column: 'responseBody', builder: 'text()', holds: 'a raw response' },
  { column: 'messageBody', builder: 'text()', holds: 'chat message content' },
  { column: 'messages', builder: 'text()', holds: 'chat message content' },
  { column: 'modelOutput', builder: 'text()', holds: 'model output' },
  { column: 'generatedText', builder: 'text()', holds: 'model output' },
  { column: 'debugCapture', builder: 'text()', holds: 'a debug capture' },
  { column: 'capturedBody', builder: 'text()', holds: 'a debug capture' },
];

const normalise = (name) => name.replace(/[^A-Za-z0-9]/g, '').toLowerCase();

for (const entry of banned) {
  const pattern = new RegExp(entry.source);
  if (PLANTED.some((planted) => pattern.test(normalise(planted.column)))) continue;
  console.error(
    `FAIL coverage: the guard bans /${entry.source}/ (${entry.holds}) and no planted column in\n`
    + 'this file matches it, so the pattern ships untested. Add one to PLANTED.',
  );
  process.exit(1);
}

const [firstDeclared] = declared;

const cases = [
  {
    name: 'a schema with no payload column passes',
    tables: cleanTables(),
    expectFailure: false,
  },

  // ------------------------------------------- the positive controls ------------
  ...PLANTED.map((planted) => ({
    name: `a ${planted.column} column is flagged`,
    tables: cleanTables({ inference_usage_events: { [planted.column]: planted.builder } }),
    expectFailure: true,
    expectOutput: `inference_usage_events.${planted.column}`,
  })),
  {
    // The open-shape half, which is the one a name ban cannot do: a payload
    // column called `capture` matches no pattern, and `jsonb` is the only type
    // that can hold a whole request without anyone deciding it should.
    name: 'an undeclared jsonb column with an innocuous name is flagged',
    tables: cleanTables({ inference_usage_events: { capture: 'jsonb()' } }),
    expectFailure: true,
    expectOutput: 'can hold an entire request',
  },
  {
    // Same, one step further: a name that says nothing at all.
    name: 'an undeclared jsonb column called `d` is flagged',
    tables: cleanTables({ usage_receipts: { d: 'jsonb()' } }),
    expectFailure: true,
    expectOutput: 'usage_receipts.d',
  },
  {
    // THE ARRAY CASE, and the reason the type classification strips dimensions.
    // `getSQLType()` renders `text().array()` as `text[]`, so a lookup on the raw
    // leading word skipped all 38 array columns in this schema — a
    // `prompts text[]` was neither name-checked nor required to declare itself,
    // while the guard's header claimed `text[]` was covered. Found in review of
    // PR #1029, and this case is what stops it coming back.
    name: 'a payload-named text[] column is flagged',
    tables: cleanTables({ inference_usage_events: { promptHistory: 'text().array()' } }),
    expectFailure: true,
    expectOutput: 'inference_usage_events.promptHistory',
  },
  {
    // The open-shape half of the same gap: an array of jsonb can hold a whole
    // request per element, so it needs a declaration exactly as `jsonb` does.
    name: 'an undeclared jsonb[] column is flagged',
    tables: cleanTables({ usage_receipts: { batches: 'jsonb().array()' } }),
    expectFailure: true,
    expectOutput: 'can hold an entire request',
  },
  {
    // The narrowness half: an array of a CLOSED type still cannot hold a payload,
    // so stripping dimensions must not drag `integer[]` into scope.
    name: 'an integer[] column does NOT fire',
    tables: cleanTables({ usage_receipts: { promptTokenCounts: 'integer().array()' } }),
    expectFailure: false,
  },

  // ------------------------------------------------- the narrowness proofs -------
  {
    // THE STRUCTURAL FILTER. `inference_models.supports_prompt_caching` is a real
    // boolean capability flag and `inference_providers.retains_payloads` is a real
    // policy flag; both contain a banned word. A census that ignored the TYPE
    // would need a name-based exception for each, and the next flag after that.
    name: 'boolean flags whose names contain banned words do NOT fire',
    tables: cleanTables({
      inference_models: { supportsPromptCaching: 'boolean()', supportsParallelToolCalls: 'boolean()' },
      inference_providers: { retainsPayloads: 'boolean()' },
    }),
    expectFailure: false,
  },
  {
    // THE RESIDUE, encoded so it is a known gap rather than a surprise. A bare
    // `body` or `text` ban would fire on an email body, an app review, an email
    // template and a reminder — the product — so those names pass, and the guard
    // says so in its header.
    name: "the product's own free-text columns do NOT fire",
    tables: cleanTables({
      app_reviews: { body: 'text()' },
      email_templates: { body: 'text()' },
      reminders: { text: 'text()' },
      users: { autoReplyBody: 'text()' },
    }),
    expectFailure: false,
  },

  // ------------------------------------------- the allow-list is exact ----------
  {
    // The shrink discipline. An entry describing a column that no longer exists
    // must FAIL: a stale entry is indistinguishable from a live one, and it would
    // silently pre-authorise a future column of that name.
    name: 'a declared column that no longer exists FAILS the run',
    tables: (() => {
      const tables = cleanTables();
      delete tables[firstDeclared.table][firstDeclared.column];
      return tables;
    })(),
    expectFailure: true,
    expectOutput: `names ${firstDeclared.table}.${firstDeclared.column}`,
  },
  {
    // A declared column NARROWED to a closed type is also a stale entry — the
    // census would no longer see it, and an entry that matches nothing is exactly
    // what the rule above refuses.
    name: 'a declared column narrowed to a boolean FAILS as stale',
    tables: (() => {
      const tables = cleanTables();
      tables[firstDeclared.table][firstDeclared.column] = 'boolean()';
      return tables;
    })(),
    expectFailure: true,
    expectOutput: 'delete the entry',
  },

  // --------------------------------------- the floors and the required tables ----
  {
    // The positive control on COVERAGE rather than on emptiness: a census can find
    // 149 tables and miss the one the policy is about, and report a clean result.
    name: 'a schema missing a required table FAILS',
    tables: (() => {
      const tables = cleanTables();
      delete tables.usage_receipts;
      return tables;
    })(),
    expectFailure: true,
    expectOutput: 'usage_receipts was not among the tables inspected',
  },
  {
    name: 'a schema module that exports no table FAILS the floor',
    tables: {},
    source: 'export const notATable = { id: 1 };\n',
    expectFailure: true,
    expectOutput: 'below the 1 floor',
  },
  {
    // The real floors, against a fixture of a few dozen tables — the shape a
    // broken barrel or a half-resolved import produces, and the one that reports
    // a clean census.
    name: 'a schema far smaller than the real one cannot pass silently',
    tables: cleanTables(),
    realFloors: true,
    expectFailure: true,
    expectOutput: 'below the 140 floor',
  },
  {
    // An unimportable schema must be loud. Unhandled, this is a stack trace that
    // reads like a bug in the guard rather than a fact about the tree — and the
    // guard would have inspected nothing.
    name: 'a schema module that throws on import FAILS loudly',
    tables: {},
    source: "throw new Error('cannot resolve @oxyhq/db');\n",
    expectFailure: true,
    expectOutput: 'could not be imported',
  },
];

let failed = 0;
for (const testCase of cases) {
  const { exitCode, output } = await runAgainst(testCase.tables, {
    realFloors: testCase.realFloors === true,
    source: testCase.source,
  });
  const didFail = exitCode !== 0;

  if (didFail !== testCase.expectFailure) {
    console.error(
      `FAIL ${testCase.name}: expected ${testCase.expectFailure ? 'a failure' : 'a pass'}, `
      + `got exit ${exitCode}\n${output}`,
    );
    failed += 1;
    continue;
  }
  if (testCase.expectOutput && !output.includes(testCase.expectOutput)) {
    console.error(
      `FAIL ${testCase.name}: failed as expected, but the message never said `
      + `"${testCase.expectOutput}"\n${output}`,
    );
    failed += 1;
    continue;
  }
  console.log(`ok   ${testCase.name}`);
}

if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} payload-persistence cases failed.`);
  process.exit(1);
}
console.log(
  `\nAll ${cases.length} payload-persistence cases passed — ${banned.length} banned patterns each `
  + `covered by a planted column, ${declared.length} declared columns and ${requiredTables.length} `
  + 'required tables, taken from the guard itself.',
);
