#!/usr/bin/env bun

/**
 * Refuse a schema in which a prompt, a completion, a chat message body or a tool
 * argument could be stored.
 *
 * ADR 0016 is the decision this enforces: **Oxy persists no inference payload,
 * and the four properties #972 section 12 asks for — explicit opt-in,
 * time-limited, encrypted with a key Oxy does not hold in PostgreSQL, audited and
 * PII-redacted — are PRECONDITIONS on introducing one, not aspirations to add
 * afterwards.** The state today is not "the feature is unbuilt": it is that the
 * feature is refused, and this file is what makes the refusal survive the next
 * person who has a reason.
 *
 * ## WHY A SCHEMA CENSUS RATHER THAN A CODE REVIEW
 *
 * A payload cannot be retained without somewhere to put it. Every table Oxy has
 * is declared in `packages/api/src/db/schema/`, re-exported from that
 * directory's barrel, and `drizzle.config.ts` generates migrations from THAT
 * BARREL — so a table missing from it gets no migration and no typed query, and a
 * census over the barrel covers exactly the set of tables that can exist. That is
 * why the table list is not written down here and is not derived from file names:
 * it is read out of the same module the migration generator reads.
 *
 * ## WHAT IS CHECKED
 *
 * The census runs over columns that could physically hold a payload — `text`,
 * `varchar`, `text[]`, `jsonb`, `json`, `bytea`, `tsvector`. A `boolean` or an
 * `integer` cannot, and that filter is structural rather than a name heuristic:
 * it is why `inference_models.supports_prompt_caching` (a capability flag) and
 * `inference_providers.retains_payloads` (a policy flag) do not have to be
 * excused by name.
 *
 * Among those columns, two things fail:
 *
 *   1. **A payload-shaped NAME** — `prompt`, `completion`, `payload`,
 *      `messageBody`, `toolArguments`, `rawResponse`, `modelOutput`, and the rest
 *      of {@link BANNED_NAME_PATTERNS}.
 *   2. **An OPEN SHAPE with no declared purpose** — every `jsonb`, `json` and
 *      `bytea` column must appear in {@link DECLARED_FREE_SHAPED_COLUMNS} saying
 *      what it holds. This is the half that a name ban cannot do: a payload
 *      column called `capture`, `blob` or `d` matches no pattern, and `jsonb` is
 *      the only shape that can hold a whole request without anyone choosing to
 *      make it possible.
 *
 * The allow-list is exact in both directions. A column that needs an entry and
 * has none fails; an entry naming a column that no longer exists fails, so it
 * cannot outlive what it described.
 *
 * ## THE RESIDUE, NAMED
 *
 * A `text` column with an innocuous name — `note`, `detail`, `value` — could hold
 * a prompt, and no static census can see that. `text` columns number over a
 * thousand here, so requiring a declaration for each would be a list nobody
 * maintains, which is worse than a named gap. What this gate guarantees is that
 * storing a payload cannot happen by ACCIDENT or by increment: it takes either a
 * name that says what it is, or a new open-shaped column, and both are refused
 * until someone edits this file and says why.
 *
 * ## HOW IT CANNOT PASS VACUOUSLY
 *
 * Three ways, and the third is the one that matters:
 *
 *   - Floors on tables and columns inspected. A schema import that resolved to an
 *     empty module reports a clean census, and "I found less" and "there is less"
 *     look identical.
 *   - REQUIRED_TABLES: the census must have REACHED the tables this policy is
 *     about — the two an inference request writes, the BYOK audit trail, and the
 *     email table that proves the traversal sees free-shaped content at all.
 *   - The allow-list's exactness: 36 declared columns must each still exist, so a
 *     traversal that stopped seeing columns fails on all 36 at once.
 *
 * `scripts/test-check-no-payload-persistence.mjs` plants a payload column in a
 * fixture schema and requires this to flag it — the positive control that a
 * clean run is a real absence.
 *
 * Needs `@oxyhq/db` and `@oxyhq/contracts` BUILT, because the schema modules
 * import them. That is why this runs in the `api-test` job after the workspace
 * builds rather than in a job of its own.
 *
 * Usage:  bun scripts/check-no-payload-persistence.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The schema module. Overridable so the fixture test can run the REAL census
 * against a schema holding a planted payload column.
 */
const schemaModulePath = process.env.PAYLOAD_PERSISTENCE_SCHEMA
  ? resolve(process.env.PAYLOAD_PERSISTENCE_SCHEMA)
  : resolve(repositoryRoot, 'packages/api/src/db/schema/index.ts');

/** Fixture schemas hold a handful of tables, so the real floors are lowered — never removed. */
const fixtureFloors = process.env.PAYLOAD_PERSISTENCE_FIXTURE_FLOORS === '1';

/**
 * SQL types a payload could physically live in. Anything else is excluded
 * structurally: a `boolean` cannot hold a prompt however it is named.
 *
 * Matched on the LEADING word of `getSQLType()` with any array dimensions
 * stripped, so `character varying(255)`, `numeric(30, 12)` and `text[]` all
 * classify correctly. The stripping is not cosmetic: drizzle renders an array as
 * `<base>[]`, so a classification keyed on the raw leading word skipped every
 * array column — 38 of them here — while this file claimed to cover `text[]`.
 * Found in review of PR #1029.
 */
const FREE_SHAPED_TYPES = new Set([
  'text',
  'character',
  'varchar',
  'jsonb',
  'json',
  'bytea',
  'tsvector',
]);

/** The subset that can hold an arbitrary STRUCTURE, and therefore a whole request. */
const OPEN_SHAPED_TYPES = new Set(['jsonb', 'json', 'bytea']);

/**
 * Names that say the column holds an inference payload.
 *
 * Matched against the column name with separators removed and lowercased, so
 * `prompt_text`, `promptText` and `PROMPTTEXT` are one pattern. Deliberately
 * specific: a bare `body` or `content` ban would fire on an email body, an app
 * review and a reminder, and a gate that fires on the product gets deleted.
 */
const BANNED_NAME_PATTERNS = [
  { pattern: /prompt/, holds: 'a prompt' },
  { pattern: /completion/, holds: 'a completion' },
  { pattern: /payload/, holds: 'a request or response payload' },
  { pattern: /transcript|chatlog/, holds: 'a conversation transcript' },
  { pattern: /toolarg|toolcall|toolinput|tooloutput/, holds: "a tool call's arguments or result" },
  { pattern: /rawrequest|requestbody|requestjson|requesttext/, holds: 'a raw request' },
  { pattern: /rawresponse|responsebody|responsejson|responsetext/, holds: 'a raw response' },
  { pattern: /messagebody|messagetext|messagecontent|^messages$/, holds: 'chat message content' },
  { pattern: /modeloutput|generatedtext|generationtext|inputtext|outputtext/, holds: 'model output' },
  { pattern: /debugcapture|debugpayload|debugtrace|capturedbody|capturedpayload/, holds: 'a debug capture' },
];

/**
 * Every open-shaped column in the schema, and every column whose NAME matches a
 * banned pattern, with what it actually holds.
 *
 * This list is the schema's own answer to "where could a payload go", written
 * down once so the next open-shaped column is a decision rather than a diff
 * nobody reads. It is exact in both directions — see the header.
 *
 * Nothing here is an inference payload. Where a column holds a customer's own
 * content (an email, a review, an app's key/value entry) the entry says so: that
 * content is the product, and the epic's invariant is about prompts and
 * completions Oxy would be storing on its own initiative.
 */
const DECLARED_FREE_SHAPED_COLUMNS = [
  // ---- OTA updates ------------------------------------------------------------
  { table: 'app_updates', column: 'extra', holds: 'the Expo manifest `extra` block, embedded verbatim in the signed manifest' },
  { table: 'app_updates', column: 'metadata', holds: 'the string->string Expo manifest metadata dictionary' },

  // ---- audit trails -----------------------------------------------------------
  { table: 'application_credential_audit_events', column: 'metadata', holds: 'per-event credential audit detail (which field changed, which grace window)' },
  {
    table: 'inference_provider_connection_audit_events',
    column: 'metadata',
    holds:
      'per-event BYOK connection audit detail. The only open-shaped column in the BYOK feature, '
      + 'and therefore the one place a credential leak would land — asserted against a real '
      + 'plaintext in inferenceProviderConnection.service.test.ts',
  },
  { table: 'security_activities', column: 'metadata', holds: 'per-event security detail; carries no IP in any form, per the platform invariant' },
  { table: 'reputation_transactions', column: 'metadata', holds: 'the reason and source of a reputation award or correction' },

  // ---- delegated agency -------------------------------------------------------
  {
    table: 'app_capability_catalog_registrations',
    column: 'catalog',
    holds: 'a schema-validated app capability catalog: tool metadata and JSON Schemas, never an invocation or its data',
  },
  {
    table: 'capability_audit_events',
    column: 'event',
    holds: 'a schema-validated authority decision and bounded result status; the contract has no tool input or output field',
  },
  {
    table: 'capability_execution_authorizations',
    column: 'limits',
    holds: 'schema-validated scalar grant limits for one authorized tool, never tool arguments',
  },
  {
    table: 'delegation_limits',
    column: 'value',
    holds: 'one schema-validated scalar or string-list grant limit, never tool arguments',
  },

  // ---- email: the customer's own mailbox --------------------------------------
  { table: 'email_outbox', column: 'payload', holds: "a queued outbound email the USER composed — their mail, not an inference payload" },
  { table: 'email_saved_searches', column: 'filters', holds: 'a saved mailbox search: labels, senders, date bounds' },
  { table: 'messages', column: 'headers', holds: 'the RFC 5322 headers of a received email, as received' },
  { table: 'messages', column: 'cardData', holds: 'the extracted rich card for an email (flight, order, event); shape differs per card type' },
  { table: 'messages', column: 'highlights', holds: 'display-only search highlight chips for an email' },

  // ---- files ------------------------------------------------------------------
  { table: 'files', column: 'metadata', holds: 'uploaded-file metadata: dimensions, duration, checksum' },
  { table: 'file_variants', column: 'metadata', holds: 'per-variant metadata of a derived image or video rendition' },

  // ---- the follow graph -------------------------------------------------------
  { table: 'follow_events', column: 'payload', holds: 'bounded extra detail on a follow event; never required to interpret the event' },
  { table: 'follow_targets', column: 'capabilities', holds: 'what a follow target supports (notifications, contexts)' },
  { table: 'follow_target_kinds', column: 'capabilities', holds: 'the capability template for a kind of follow target' },
  { table: 'follow_targets', column: 'metadataSnapshot', holds: 'bounded display metadata of a target: name, handle, icon, deep link' },

  // ---- reputation and civic validation ---------------------------------------
  { table: 'reporter_reputation_profiles', column: 'confirmedByFamily', holds: 'per-report-family confirmation counts' },
  { table: 'reporter_reputation_profiles', column: 'rejectedByFamily', holds: 'per-report-family rejection counts' },
  { table: 'reviewer_reputation_profiles', column: 'categoryReliability', holds: 'per-category reviewer reliability scores' },
  { table: 'reviewer_reputation_profiles', column: 'languageReliability', holds: 'per-language reviewer reliability scores' },
  { table: 'validation_requests', column: 'payload', holds: 'the civic claim body jurors inspect — a DNI validation claim, not a model request' },
  { table: 'validation_requests', column: 'payloadHash', holds: 'the SHA-256 the signed juror verdict binds to; a hash cannot hold what it hashes' },
  { table: 'validation_requests', column: 'candidateSnapshot', holds: 'the `{userId, weight}` juror pool at selection time; audit only' },
  { table: 'validation_votes', column: 'envelope', holds: "a juror's signed vote envelope, verbatim" },

  // ---- identity ---------------------------------------------------------------
  { table: 'signed_records', column: 'envelope', holds: 'a signed identity record envelope, verbatim' },
  { table: 'verifiable_credentials', column: 'claims', holds: 'the claims of a verifiable credential' },
  { table: 'webauthn_credentials', column: 'credentialPublicKey', holds: 'the COSE public key of a passkey — a public key, and the only `bytea` in the schema' },

  // ---- misc -------------------------------------------------------------------
  { table: 'topics', column: 'translations', holds: 'per-locale topic labels' },
  { table: 'user_analytics', column: 'demographicsCountries', holds: 'aggregate audience counts per country; no per-user location and no IP' },
  { table: 'user_analytics', column: 'demographicsLanguages', holds: 'aggregate audience counts per language' },
  {
    table: 'user_app_data',
    column: 'value',
    holds:
      "whatever an application stored under its own namespace and key. Shape-less by design and "
      + "the application is its controller; no Oxy inference path writes here, which is what keeps "
      + 'it out of this policy',
  },
];

/**
 * Tables the census must have REACHED. This is the positive control: the floors
 * below catch a traversal that found nothing, and these catch one that found
 * plenty while missing the part the policy is about.
 *
 * Not the table list — the table list comes from the module. These four are named
 * because each proves something different: the two an inference request writes,
 * the BYOK audit trail, and `messages`, which is where free-shaped customer
 * content actually lives.
 */
const REQUIRED_TABLES = [
  'inference_usage_events',
  'usage_receipts',
  'inference_provider_connection_audit_events',
  'messages',
];

const MINIMUM_TABLES = fixtureFloors ? 1 : 140;
const MINIMUM_COLUMNS = fixtureFloors ? 1 : 1700;

/**
 * The fixture test builds its planted-column cases from the same patterns and the
 * same declared list, so a pattern added here is covered automatically.
 */
if (process.env.PAYLOAD_PERSISTENCE_EMIT_POLICY === '1') {
  console.log(
    JSON.stringify({
      banned: BANNED_NAME_PATTERNS.map((entry) => ({ source: entry.pattern.source, holds: entry.holds })),
      declared: DECLARED_FREE_SHAPED_COLUMNS.map((entry) => ({ table: entry.table, column: entry.column })),
      requiredTables: REQUIRED_TABLES,
    }),
  );
  process.exit(0);
}

let schema;
try {
  schema = await import(pathToFileURL(schemaModulePath).href);
} catch (error) {
  console.error(
    `The schema module ${schemaModulePath} could not be imported, so no column was inspected:\n`
    + `${error.message}\n\n`
    + 'It imports @oxyhq/db and @oxyhq/contracts, which resolve into their built `dist/`. Run\n'
    + '`bun run --filter @oxyhq/contracts build` and `bun run --filter @oxyhq/db build` first.',
  );
  process.exit(1);
}

const problems = [];
const findings = [];

/** Separators removed and lowercased, so one pattern covers every spelling. */
const normalise = (name) => name.replace(/[^A-Za-z0-9]/g, '').toLowerCase();

const seenTables = new Set();
const seenColumns = new Set();
let columnsInspected = 0;
let freeShapedInspected = 0;

for (const exported of Object.values(schema)) {
  if (!is(exported, PgTable)) continue;
  const table = getTableName(exported);
  seenTables.add(table);

  for (const column of Object.values(getTableColumns(exported))) {
    columnsInspected += 1;
    const sqlType = column.getSQLType();
    // Array dimensions stripped before the lookup — see FREE_SHAPED_TYPES. An
    // array of prompts is a list of prompts, and `jsonb[]` can hold an entire
    // request just as `jsonb` can.
    const leadingType = sqlType.split(/[\s(]/)[0].replace(/(?:\[\])+$/, '');
    if (!FREE_SHAPED_TYPES.has(leadingType)) continue;
    freeShapedInspected += 1;

    const normalised = normalise(column.name);
    const key = `${table}.${column.name}`;
    const openShaped = OPEN_SHAPED_TYPES.has(leadingType);
    const banned = BANNED_NAME_PATTERNS.find((entry) => entry.pattern.test(normalised));

    if (openShaped || banned !== undefined) {
      seenColumns.add(key);
      const declared = DECLARED_FREE_SHAPED_COLUMNS.some(
        (entry) => entry.table === table && entry.column === column.name,
      );
      if (!declared) {
        findings.push({
          key,
          sqlType,
          why:
            banned !== undefined
              ? `its name says it holds ${banned.holds}`
              : `it is \`${sqlType}\`, which can hold an entire request`,
        });
      }
    }
  }
}

// ── The allow-list is exact in the other direction too ─────────────────────
for (const entry of DECLARED_FREE_SHAPED_COLUMNS) {
  const key = `${entry.table}.${entry.column}`;
  if (seenColumns.has(key)) continue;
  problems.push(
    `DECLARED_FREE_SHAPED_COLUMNS names ${key}, which this census did not find as an open-shaped `
    + 'or payload-named column. The column was dropped, renamed, or narrowed to a closed type — '
    + 'delete the entry, so the list keeps describing the schema.',
  );
}

// ── Vacuity floors and the positive control ───────────────────────────────
if (seenTables.size < MINIMUM_TABLES) {
  problems.push(
    `${seenTables.size} table(s) inspected is below the ${MINIMUM_TABLES} floor. The barrel or the `
    + 'traversal is broken, and a census that inspected nothing reports exactly what a clean '
    + 'schema reports.',
  );
}
if (columnsInspected < MINIMUM_COLUMNS) {
  problems.push(
    `${columnsInspected} column(s) inspected is below the ${MINIMUM_COLUMNS} floor. Tables were `
    + 'found but their columns were not being read.',
  );
}
for (const table of REQUIRED_TABLES) {
  if (seenTables.has(table)) continue;
  problems.push(
    `${table} was not among the tables inspected. It is one of the tables this policy is ABOUT, `
    + 'so a census that misses it can report a clean result while never looking at the place a '
    + 'payload would go.',
  );
}

// ── Verdict ───────────────────────────────────────────────────────────────
if (findings.length > 0 || problems.length > 0) {
  console.error('Payload-persistence guard FAILED:\n');
  for (const finding of findings) {
    console.error(`  ${finding.key} (${finding.sqlType}) — ${finding.why}\n`);
  }
  for (const problem of problems) console.error(`  ${problem}\n`);
  if (findings.length > 0) {
    console.error(
      '  Oxy persists no prompt, completion, chat message body or tool argument. That is ADR\n'
      + '  0016 and docs/inference/data-policy.md, and #972 section 12 requires any future debug\n'
      + '  capture to be explicit opt-in, time-limited, encrypted with a key Oxy does not hold in\n'
      + '  PostgreSQL, audited and PII-redacted BEFORE it exists — not afterwards. No secret\n'
      + '  backend is wired in this deployment (ADR 0013), so the encryption precondition cannot\n'
      + '  be met today and a capture table cannot honestly land.\n\n'
      + '  If the column above holds something else, add a DECLARED_FREE_SHAPED_COLUMNS entry in\n'
      + '  scripts/check-no-payload-persistence.mjs saying what it holds, in the same commit as\n'
      + '  the column.\n',
    );
  }
  process.exit(1);
}

console.log(
  `Payload-persistence guard passed — ${seenTables.size} tables / ${columnsInspected} columns `
  + `inspected, ${freeShapedInspected} of them free-shaped; `
  + `${DECLARED_FREE_SHAPED_COLUMNS.length} declared open-shaped or payload-named columns all still `
  + `present; ${REQUIRED_TABLES.length} required tables reached.`,
);
