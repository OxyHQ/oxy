#!/usr/bin/env bun

/**
 * Exercises check-migration-journal-order.mjs against mutated copies of the REAL
 * journal it guards.
 *
 * Fixtures are copies, not hand-written miniatures, for the same reason the
 * phases gate's fixtures are: a synthetic journal drifts away from
 * `packages/api/drizzle/` and starts proving something about the fixture. Each
 * case copies the real directory into a temp root, breaks exactly one thing, and
 * asserts the gate goes red AND names the offending migration — a gate that
 * fails without naming which entry to restamp is one nobody can act on.
 *
 * `swapped-when` and `regenerated-below-predecessor` are the two shapes actually
 * shipped: the first is the deliberate reordering the issue asks to be
 * mutation-tested, the second is `ce0eccc8` verbatim, where a regenerate stamped
 * `0038` below the `0037` above it in the same file.
 *
 * The last two mutation cases keep the gate's own vacuity guards honest: each is
 * built so the guard it targets is the ONLY thing that fires, and therefore each
 * exits 0 if that guard is deleted. Isolating them is not cosmetic — a truncated
 * journal also orphans every `.sql` file, so a naive truncation case would stay
 * red with the count floor removed and prove nothing about it.
 *
 * `no-node-modules` is not a mutation but a property test: the CI job runs this
 * gate WITHOUT `bun install`, like the three gates beside it, so it must resolve
 * with an empty dependency tree.
 *
 * Offline. Fixtures are created under the OS temp dir.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkScript = join(repoRoot, 'scripts', 'check-migration-journal-order.mjs');

const DRIZZLE = join('packages', 'api', 'drizzle');
const JOURNAL = join(DRIZZLE, 'meta', '_journal.json');
const GATE = join('scripts', 'check-migration-journal-order.mjs');

const fixturePrefix = join(tmpdir(), 'oxy-migration-journal-order-');
const createdFixtures = [];
const failures = [];

function createFixture() {
  const root = mkdtempSync(fixturePrefix);
  createdFixtures.push(root);
  cpSync(join(repoRoot, DRIZZLE), join(root, DRIZZLE), { recursive: true });
  return root;
}

function readJournal(root) {
  return JSON.parse(readFileSync(join(root, JOURNAL), 'utf8'));
}

function writeJournal(root, journal) {
  writeFileSync(join(root, JOURNAL), `${JSON.stringify(journal, null, 2)}\n`);
}

/**
 * Rewrite a fixture's journal, failing loudly if the edit changed nothing. A
 * mutation that never applied is indistinguishable from one the gate survived.
 */
function mutateJournal(root, caseName, mutate) {
  const before = readFileSync(join(root, JOURNAL), 'utf8');
  const journal = JSON.parse(before);
  mutate(journal);
  const after = `${JSON.stringify(journal, null, 2)}\n`;
  if (after === before) {
    failures.push(
      `${caseName}: the fixture edit changed nothing — the mutation never happened, so the case proves nothing.`
    );
    return;
  }
  writeFileSync(join(root, JOURNAL), after);
}

function expectVerdict(caseName, root, expectedCode, expectedFragment, script = checkScript) {
  let code = 0;
  let output = '';
  try {
    output = execFileSync('bun', [script], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    code = error.status ?? 1;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  if (code !== expectedCode) {
    failures.push(`${caseName}: expected exit ${expectedCode}, got ${code}.\n${output}`);
    return;
  }
  if (!output.includes(expectedFragment)) {
    failures.push(`${caseName}: output does not contain ${JSON.stringify(expectedFragment)}.\n${output}`);
  }
}

// The real files must pass, or nothing below means anything.
expectVerdict('unchanged', createFixture(), 0, 'Migration journal order is sound');

/*
 * The last two entries of the REAL journal, read once.
 *
 * The mutation cases below assert on the exact sentence the gate produces, tags
 * and timestamps included — but those tags are derived here rather than written
 * in, because the tail of this journal moves every time a migration lands and a
 * hardcoded tag turns this file red on somebody else's unrelated change. That is
 * not circular: the values come from the PRISTINE journal plus the mutation this
 * file applied, never from the gate's own comparison, so a gate that named the
 * wrong pair — or nothing at all — still fails here.
 */
const journalTail = (() => {
  const entries = JSON.parse(readFileSync(join(repoRoot, JOURNAL), 'utf8')).entries;
  if (entries.length < 2) {
    failures.push('the real journal has fewer than 2 entries; every case below is vacuous.');
    return null;
  }
  return { previous: entries[entries.length - 2], last: entries[entries.length - 1] };
})();

// ── The issue's own mutation: two `when` values swapped ────────────────────
if (journalTail) {
  const swapped = createFixture();
  mutateJournal(swapped, 'swapped-when', (journal) => {
    const last = journal.entries.length - 1;
    const previous = journal.entries[last - 1];
    const final = journal.entries[last];
    [previous.when, final.when] = [final.when, previous.when];
  });
  expectVerdict(
    'swapped-when',
    swapped,
    1,
    `${journalTail.last.tag} has when=${journalTail.previous.when}, which is not newer than ` +
    `${journalTail.previous.tag}'s when=${journalTail.last.when}`
  );
}

// ── `ce0eccc8` verbatim: a regenerate stamped below the entry above it ─────
//
// The real one was `0038_inbox_snapshot_sync` at when=1786836140383 sitting
// under `0037_inbox_delivery_and_search` at when=1786900000000, and this is the
// timestamp PR #997's regenerate produced a few hours later. Applied to the
// current tail, since the journal has since moved past those two.
const REGENERATED_WHEN = 1786854625174;
if (journalTail) {
  const regenerated = createFixture();
  mutateJournal(regenerated, 'regenerated-below-predecessor', (journal) => {
    journal.entries[journal.entries.length - 1].when = REGENERATED_WHEN;
  });
  expectVerdict(
    'regenerated-below-predecessor',
    regenerated,
    1,
    `${journalTail.last.tag} has when=${REGENERATED_WHEN}, which is not newer than ` +
    `${journalTail.previous.tag}'s when=${journalTail.previous.when}`
  );
}

// A TIE is skipped by exactly the same rule as an inversion — the apply
// comparison is `>`, not `>=`. Matching only on "strictly less" would let the
// one input `unreachableEntries` documents as its blind spot through.
const tied = createFixture();
mutateJournal(tied, 'equal-when', (journal) => {
  const last = journal.entries.length - 1;
  journal.entries[last].when = journal.entries[last - 1].when;
});
expectVerdict('equal-when', tied, 1, 'which is not newer than');

// Journal order IS apply order, so "ascends with `idx`" is only a claim worth
// making once the array itself ascends.
const reordered = createFixture();
mutateJournal(reordered, 'idx-out-of-order', (journal) => {
  const last = journal.entries.length - 1;
  [journal.entries[last - 1], journal.entries[last]] = [
    journal.entries[last],
    journal.entries[last - 1],
  ];
});
expectVerdict(
  'idx-out-of-order',
  reordered,
  1,
  'so the journal is not in ascending `idx` order'
);

// ── The mirror-image failure: a migration nothing will ever read ───────────
// Deliberately numbered far past anything real, so this fixture cannot collide
// with whatever index the next migration takes.
const ORPHAN_TAG = '9999_orphan_no_journal_entry';
const orphanFile = createFixture();
writeFileSync(
  join(orphanFile, DRIZZLE, `${ORPHAN_TAG}.sql`),
  '-- oxy:deploy-phase=pre\nALTER TABLE "users" ADD COLUMN "orphan" text;\n'
);
expectVerdict('orphan-sql-file', orphanFile, 1, `${ORPHAN_TAG}.sql has no entry in`);

// …and its converse. The phases gate reports this as "cannot read"; here it is
// reported as what it costs, which is a migrator that fails in production.
const missingFile = createFixture();
rmSync(join(missingFile, DRIZZLE, '0030_browser_hub_handle.sql'));
expectVerdict(
  'journal-entry-without-file',
  missingFile,
  1,
  'names 0030_browser_hub_handle but'
);

// ── The gate's own guards, each with a case that goes GREEN without it ─────
//
// A parse landing on a SHORTER array compares a handful of pairs, finds nothing
// wrong, and reports success. The `.sql` files of the dropped entries are removed
// too, so the file-set check stays satisfied and the count floor is the ONLY
// thing that can fire. Delete MINIMUM_JOURNAL_ENTRIES and this case exits 0.
const truncated = createFixture();
const truncatedKeep = 2;
{
  const journal = readJournal(truncated);
  const dropped = journal.entries.slice(truncatedKeep);
  writeJournal(truncated, { ...journal, entries: journal.entries.slice(0, truncatedKeep) });
  for (const entry of dropped) rmSync(join(truncated, DRIZZLE, `${entry.tag}.sql`));
}
expectVerdict('truncated-journal', truncated, 1, 'journal entr(y/ies) parsed out of');

// And a parse landing on a DIFFERENT array of acceptable length is invisible to
// a count floor: every remaining entry is real, ordered, and has its file. Only
// the sentinel notices the first migration ever written has vanished. Delete
// JOURNAL_SENTINEL and this case exits 0.
const sentinelAbsent = createFixture();
{
  const journal = readJournal(sentinelAbsent);
  const [first, ...rest] = journal.entries;
  writeJournal(sentinelAbsent, { ...journal, entries: rest });
  rmSync(join(sentinelAbsent, DRIZZLE, `${first.tag}.sql`));
}
expectVerdict('sentinel-absent', sentinelAbsent, 1, 'was not among the parsed journal entries');

// ── Property: the gate resolves with no dependency tree ────────────────────
//
// The CI job runs this gate without `bun install`, like the gates beside it.
// Copy it into a fixture with no `node_modules` at any level and run the COPY —
// running the real script would resolve against the real repository's tree and
// prove nothing.
const isolated = createFixture();
mkdirSync(join(isolated, dirname(GATE)), { recursive: true });
cpSync(join(repoRoot, GATE), join(isolated, GATE));
expectVerdict(
  'no-node-modules',
  isolated,
  0,
  'Migration journal order is sound',
  join(isolated, GATE)
);

for (const fixture of createdFixtures) {
  if (fixture.startsWith(fixturePrefix)) rmSync(fixture, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('Migration journal order check tests failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Migration journal order check discriminated ${createdFixtures.length} fixture case(s).`);
