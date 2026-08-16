#!/usr/bin/env bun
/**
 * Fail the build when the migration journal is in an order that cannot apply.
 *
 * THE HAZARD THIS EXISTS FOR
 *
 * Both this repository's migrator and drizzle-kit apply a migration only when
 * its `_journal.json` `when` value is strictly NEWER than the newest `created_at`
 * already recorded in the target database. `drizzle-kit generate` stamps `when`
 * from the wall clock of whichever machine ran it, so a regenerate-after-rebase
 * routinely produces a value BELOW a sibling migration that already pushed the
 * ledger forward on `main`. That migration is then unreachable: on raw drizzle it
 * is stepped over in silence and the run reports success.
 *
 * It has happened twice in one day. `ce0eccc8` is the shape, and it is visible
 * with no database at all — `0038_inbox_snapshot_sync` carried `when=1786836140383`
 * while `0037_inbox_delivery_and_search`, one entry ABOVE it in the same file,
 * carried `1786900000000`. The fix renamed the migration and restamped it. PR #997
 * reproduced it a few hours later and was corrected by hand before merge.
 *
 * WHY THE RUNTIME GUARD IS NOT ENOUGH, AND WHAT THIS ADDS
 *
 * `@oxyhq/db`'s `planLedgerRun` (`packages/db/src/migrate/ledger.ts`) already
 * refuses this: it computes `unreachableEntries` against the LIVE ledger and
 * throws `UnreachableMigrationError` rather than reporting a clean run. That
 * guard is real and must stay — it is the only thing that can see the database.
 *
 * But it can only fire where the database is, which is the pre-deploy migration
 * one-shot in production, after the pull request has merged. At that point the
 * defect is a BLOCKED RELEASE needing an emergency regenerate, and the same
 * change has already gone green through every check on the pull request. It also
 * cannot see the case where both new migrations still sit above today's
 * high-water: the journal is already wrong, the deploy succeeds anyway, and the
 * stranding waits for whichever migration merges next.
 *
 * This gate answers the half that lives in the repository, needs no database, and
 * runs on the pull request: within one journal, `when` must ascend with `idx`.
 * That alone catches both occurrences, because in both the offending entry sat
 * below one already in the same file.
 *
 * WHAT IS CHECKED
 *
 *   1. Entries are in ascending `idx` order. The array order IS the apply order,
 *      so "ascending with `idx`" is only a meaningful claim once this holds.
 *   2. `when` ascends STRICTLY with `idx`. Equal values are refused too: the
 *      apply rule is `>`, so a tie is skipped exactly like an inversion, and
 *      `unreachableEntries` documents a same-millisecond collision as the one
 *      input that makes it MISS a real skip.
 *   3. The journal and `packages/api/drizzle/*.sql` describe the same set of
 *      migrations, both directions. A `.sql` file with no journal entry is the
 *      mirror-image failure — it is applied by nothing, ever, and no other check
 *      in this repository looks for it.
 *
 * WHAT IS NOT CHECKED, DELIBERATELY
 *
 * Whether any `when` sits below PRODUCTION's high-water mark. That is the
 * stronger question and it needs the ledger, which lives on a private VPC address
 * a pull-request check must never hold credentials for. It is already answered at
 * migration time by `planLedgerRun`, inside the VPC, against the real ledger.
 *
 * Paths are resolved from the working directory, so the fixture tests in
 * `scripts/test-check-migration-journal-order.mjs` can run this against a mutated
 * copy of the real journal.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DRIZZLE_FOLDER = join('packages', 'api', 'drizzle');
const JOURNAL_PATH = join(DRIZZLE_FOLDER, 'meta', '_journal.json');

/**
 * Vacuity guards, in the shape `check-migration-phases.mjs` uses them. A journal
 * this gate cannot read would otherwise compare zero pairs and report zero
 * problems — a path typo and a correct journal produce the same output. The
 * sentinel is the first migration ever written, the one tag that can never
 * legitimately leave the journal, and it catches a parse that landed on a
 * DIFFERENT array of acceptable length, which a count floor cannot see.
 */
const MINIMUM_JOURNAL_ENTRIES = 10;
const JOURNAL_SENTINEL = '0000_groovy_colossus';

const problems = [];

function fail(message) {
  problems.push(message);
}

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    console.error(`Cannot read ${path}: ${error.message}`);
    process.exit(1);
  }
}

/** Journal entries carrying a usable `idx`, `when` and `tag`, in journal order. */
function parseJournalEntries() {
  let parsed;
  try {
    parsed = JSON.parse(read(JOURNAL_PATH));
  } catch (error) {
    fail(`${JOURNAL_PATH} is not readable JSON (${error.message}); the gate cannot see any migration.`);
    return [];
  }

  const entries = parsed?.entries;
  if (!Array.isArray(entries)) {
    fail(`${JOURNAL_PATH} has no \`entries\` array; the gate cannot see any migration.`);
    return [];
  }

  const usable = [];
  for (const [position, entry] of entries.entries()) {
    if (
      typeof entry?.idx !== 'number' ||
      typeof entry?.when !== 'number' ||
      typeof entry?.tag !== 'string'
    ) {
      // Not a shape this gate can order. Reported rather than skipped: an entry
      // with no `when` is not applied on a schedule anybody can reason about.
      fail(
        `${JOURNAL_PATH} entries[${position}] is missing a numeric \`idx\`, a numeric \`when\` or a ` +
        'string `tag`, so its place in the apply order cannot be checked.'
      );
      continue;
    }
    usable.push(entry);
  }
  return usable;
}

const entries = parseJournalEntries();

// ── Vacuity guards ─────────────────────────────────────────────────────────
if (entries.length > 0 && entries.length < MINIMUM_JOURNAL_ENTRIES) {
  fail(
    `Only ${entries.length} journal entr(y/ies) parsed out of ${JOURNAL_PATH} (expected at least ` +
    `${MINIMUM_JOURNAL_ENTRIES}). The parse is broken, not the source.`
  );
}
if (entries.length > 0 && !entries.some((entry) => entry.tag === JOURNAL_SENTINEL)) {
  fail(
    `${JOURNAL_SENTINEL} was not among the parsed journal entries — the gate is reading the wrong ` +
    `array in ${JOURNAL_PATH}.`
  );
}

// ── 1/2. The apply order ascends, and `when` ascends with it ───────────────
for (let position = 1; position < entries.length; position += 1) {
  const previous = entries[position - 1];
  const entry = entries[position];

  if (previous.idx >= entry.idx) {
    fail(
      `${entry.tag} (idx=${entry.idx}) is listed after ${previous.tag} (idx=${previous.idx}), so the ` +
      'journal is not in ascending `idx` order. Journal order is apply order; sort the entries before ' +
      'anything else can be said about them.'
    );
  }

  if (previous.when >= entry.when) {
    fail(
      `${entry.tag} has when=${entry.when}, which is not newer than ${previous.tag}'s ` +
      `when=${previous.when}. A migration is applied only when its \`when\` is strictly newer than ` +
      'the newest already recorded, so once a database has applied ' +
      `${previous.tag} this one is unreachable: raw drizzle steps over it in silence, and @oxyhq/db's ` +
      'migrator refuses the whole run. Regenerate it (rename the file and its journal entry) with a ' +
      '`when` above every entry before it — never edit the ledger.'
    );
  }
}

// ── 3. The journal and the directory describe the same migrations ──────────
let migrationFiles;
try {
  migrationFiles = readdirSync(DRIZZLE_FOLDER)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => name.slice(0, -'.sql'.length));
} catch (error) {
  console.error(`Cannot list ${DRIZZLE_FOLDER}: ${error.message}`);
  process.exit(1);
}

const journalTags = new Set(entries.map((entry) => entry.tag));
for (const file of migrationFiles) {
  if (!journalTags.has(file)) {
    fail(
      `${join(DRIZZLE_FOLDER, `${file}.sql`)} has no entry in ${JOURNAL_PATH}, so nothing will ever ` +
      'apply it — neither drizzle-kit nor the deploy migrator reads the directory. Add its journal ' +
      'entry, or delete the file.'
    );
  }
}

const filesOnDisk = new Set(migrationFiles);
for (const entry of entries) {
  if (!filesOnDisk.has(entry.tag)) {
    fail(
      `${JOURNAL_PATH} names ${entry.tag} but ${join(DRIZZLE_FOLDER, `${entry.tag}.sql`)} does not ` +
      'exist, so the migrator fails at apply time — in production, after the release has merged.'
    );
  }
}

if (problems.length > 0) {
  console.error('The migration journal is in an UNAPPLIABLE order:\n');
  for (const problem of problems) console.error(`- ${problem}`);
  console.error(
    '\nA migration whose `when` sits below one already applied is not run and not reported. On raw' +
    '\ndrizzle the deploy is green and the tables simply never appear; here the pre-deploy migrator' +
    '\nrefuses the entire run, which blocks the release in production rather than on this branch.'
  );
  process.exit(1);
}

console.log(
  `Migration journal order is sound: ${entries.length} entr(y/ies) ascend strictly by \`when\`, and ` +
  `the journal and ${DRIZZLE_FOLDER} name the same ${migrationFiles.length} migration(s).`
);
