#!/usr/bin/env bun

/**
 * Exercises check-migration-phases.mjs against mutated copies of the REAL files
 * it guards.
 *
 * Fixtures are copies, not hand-written miniatures: a synthetic journal would
 * drift away from `packages/api/drizzle/` and start proving something about the
 * fixture instead of about the migrations. Each case copies the real files into
 * a temp root, breaks exactly one thing, and asserts the gate goes red AND names
 * the offending migration or step — a gate that fails without naming what to fix
 * is a gate nobody can act on, which is the failure mode this whole mechanism is
 * an instance of.
 *
 * The `undeclared-new-migration` case is the one that matters most: it is the
 * 2026-08-02 shape, a migration landing with the deploy having no idea which
 * side of the rollout it belongs on.
 *
 * The last three cases keep the gate's own guards honest: each passes (exit 0)
 * if the guard it targets is deleted, so none can rot into decoration.
 *
 * `no-node-modules` is not a mutation but a property test: the CI job runs this
 * gate WITHOUT `bun install`, exactly like the two gates beside it, so the gate
 * and the parser it imports must resolve with an empty dependency tree.
 *
 * Offline. Fixtures are created under the OS temp dir.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkScript = join(repoRoot, "scripts", "check-migration-phases.mjs");

const DRIZZLE = join("packages", "api", "drizzle");
const JOURNAL = join(DRIZZLE, "meta", "_journal.json");
const WORKFLOW = join(".github", "workflows", "deploy-aws.yml");
const DEPLOY_SCRIPT = join(".github", "scripts", "deploy-ecs-image.sh");
const PARSER = join("packages", "db", "src", "migrate", "phases.ts");
const GATE = join("scripts", "check-migration-phases.mjs");

const fixturePrefix = join(tmpdir(), "oxy-migration-phases-");
const createdFixtures = [];
const failures = [];

function createFixture() {
  const root = mkdtempSync(fixturePrefix);
  createdFixtures.push(root);
  cpSync(join(repoRoot, DRIZZLE), join(root, DRIZZLE), { recursive: true });
  for (const relative of [WORKFLOW, DEPLOY_SCRIPT]) {
    mkdirSync(join(root, dirname(relative)), { recursive: true });
    cpSync(join(repoRoot, relative), join(root, relative));
  }
  return root;
}

/** Rewrite a fixture file, failing loudly if the edit matched nothing. */
function edit(root, relative, caseName, replacer) {
  const path = join(root, relative);
  const before = readFileSync(path, "utf8");
  const after = replacer(before);
  if (after === before) {
    failures.push(
      `${caseName}: the fixture edit changed nothing — the mutation never happened, so the case proves nothing.`,
    );
    return;
  }
  writeFileSync(path, after);
}

function expectVerdict(
  caseName,
  root,
  expectedCode,
  expectedFragment,
  script = checkScript,
) {
  let code = 0;
  let output = "";
  try {
    output = execFileSync("bun", [script], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    code = error.status ?? 1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  if (code !== expectedCode) {
    failures.push(
      `${caseName}: expected exit ${expectedCode}, got ${code}.\n${output}`,
    );
    return;
  }
  if (!output.includes(expectedFragment)) {
    failures.push(
      `${caseName}: output does not contain ${JSON.stringify(expectedFragment)}.\n${output}`,
    );
  }
}

/** Append a journal entry plus its `.sql` file to a fixture. */
function addMigration(root, tag, body) {
  const journalPath = join(root, JOURNAL);
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  const last = journal.entries[journal.entries.length - 1];
  journal.entries.push({
    idx: last.idx + 1,
    version: last.version,
    when: last.when + 1000,
    tag,
    breakpoints: true,
  });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  writeFileSync(join(root, DRIZZLE, `${tag}.sql`), body);
}

// The real files must pass, or nothing below means anything.
expectVerdict(
  "unchanged",
  createFixture(),
  0,
  "Migration deploy phases are sound",
);

// ── The 2026-08-02 shape: a migration lands, nothing says when to apply it ──
const undeclared = createFixture();
addMigration(
  undeclared,
  "0014_users_drop_organization_category",
  'ALTER TABLE "users" DROP COLUMN "organization_category";\n',
);
expectVerdict(
  "undeclared-new-migration",
  undeclared,
  1,
  "0014_users_drop_organization_category: no deploy-phase marker",
);

// A marker stripped from an existing migration is the same hole, arriving by
// edit rather than by addition.
const markerRemoved = createFixture();
edit(
  markerRemoved,
  join(DRIZZLE, "0013_users_account_categories.sql"),
  "marker-removed",
  (text) => text.replace("-- oxy:deploy-phase=pre\n", ""),
);
expectVerdict(
  "marker-removed",
  markerRemoved,
  1,
  "0013_users_account_categories: no deploy-phase marker",
);

// Two markers do not average out — the file does not say which side it is on.
const twoMarkers = createFixture();
edit(
  twoMarkers,
  join(DRIZZLE, "0012_users_name_display.sql"),
  "two-markers",
  (text) => `${text}\n-- oxy:deploy-phase=post\n`,
);
expectVerdict(
  "two-markers",
  twoMarkers,
  1,
  "0012_users_name_display: 2 deploy-phase markers",
);

// A misspelled phase must be reported as a misspelling. Matching only
// `(pre|post)` would make this indistinguishable from a file with no marker,
// and "you wrote no phase" sends the reader looking in the wrong place.
const unknownPhase = createFixture();
edit(
  unknownPhase,
  join(DRIZZLE, "0011_account_kind_channel.sql"),
  "unknown-phase",
  (text) =>
    text.replace("-- oxy:deploy-phase=pre", "-- oxy:deploy-phase=after"),
);
expectVerdict(
  "unknown-phase",
  unknownPhase,
  1,
  '0011_account_kind_channel: unrecognised deploy phase "after"',
);

// A journal tag whose file is gone must be a problem, never "nothing declared,
// nothing to do" — that is how an image shipped without its migrations reads.
const missingFile = createFixture();
rmSync(join(missingFile, DRIZZLE, "0010_icy_madame_hydra.sql"));
expectVerdict(
  "missing-migration-file",
  missingFile,
  1,
  "0010_icy_madame_hydra: cannot read",
);

// ── The deploy step itself ─────────────────────────────────────────────────
//
// Deleting one line from the workflow reproduces the outage exactly, with a
// green deploy and no other symptom anywhere.
const noRunMigrations = createFixture();
edit(noRunMigrations, WORKFLOW, "run-migrations-removed", (text) =>
  text.replace(/^\s+RUN_MIGRATIONS:\s*["']true["']\s*\n/m, ""),
);
expectVerdict(
  "run-migrations-removed",
  noRunMigrations,
  1,
  "no longer sets `RUN_MIGRATIONS: 'true'` on the deploy step",
);

// A pre-deploy migrator without `--phase=pre` either refuses to run (red deploy,
// no explanation) or, with the wrong phase, applies a DROP against the image
// still serving.
const noPhaseFlag = createFixture();
edit(noPhaseFlag, DEPLOY_SCRIPT, "pre-phase-flag-removed", (text) =>
  text.replace(',"--phase=pre"', ""),
);
expectVerdict(
  "pre-phase-flag-removed",
  noPhaseFlag,
  1,
  'no longer passes "--phase=pre"',
);

// The workflow decides whether to run a post-rollout migration task from a grep.
// A pattern that no longer matches the marker syntax skips that task silently,
// and the destructive migration is then applied by nothing at all.
const driftedGrep = createFixture();
edit(driftedGrep, WORKFLOW, "post-grep-drifted", (text) =>
  text.replace(
    /\^-- oxy:deploy-phase=post\$/g,
    "^-- oxy:migration-phase=post$",
  ),
);
expectVerdict(
  "post-grep-drifted",
  driftedGrep,
  1,
  "does not grep for ^-- oxy:deploy-phase=post$",
);

// ── The gate's own guards, each with a case that goes GREEN without it ──────
//
// A journal parse landing on a SHORTER array checks a handful of migrations,
// finds nothing wrong with them, and reports success. Delete
// MINIMUM_JOURNAL_ENTRIES and this case exits 0.
const truncatedJournal = createFixture();
edit(truncatedJournal, JOURNAL, "truncated-journal", (text) => {
  const journal = JSON.parse(text);
  return JSON.stringify(
    { ...journal, entries: journal.entries.slice(0, 2) },
    null,
    2,
  );
});
expectVerdict(
  "truncated-journal",
  truncatedJournal,
  1,
  "migration tag(s) parsed out of",
);

// And a parse landing on a DIFFERENT array of acceptable size is invisible to a
// count floor: every tag below is a real, correctly marked migration, so every
// other check passes. Only the sentinel notices the first migration vanished.
// Delete JOURNAL_SENTINEL and this case exits 0.
const wrongJournalArray = createFixture();
edit(wrongJournalArray, JOURNAL, "sentinel-absent", (text) => {
  const journal = JSON.parse(text);
  return JSON.stringify(
    { ...journal, entries: journal.entries.slice(1) },
    null,
    2,
  );
});
expectVerdict(
  "sentinel-absent",
  wrongJournalArray,
  1,
  "was not among the parsed journal tags",
);

// ── Property: the gate resolves with no dependency tree ────────────────────
//
// The CI job runs this gate without `bun install`, like the two beside it. Copy
// the gate AND the parser it imports into a fixture that has no `node_modules`
// at any level, and run the COPY — running the real script would resolve against
// the real repository's tree and prove nothing.
const isolated = createFixture();
for (const relative of [PARSER, GATE]) {
  mkdirSync(join(isolated, dirname(relative)), { recursive: true });
  cpSync(join(repoRoot, relative), join(isolated, relative));
}
expectVerdict(
  "no-node-modules",
  isolated,
  0,
  "Migration deploy phases are sound",
  join(isolated, GATE),
);

for (const fixture of createdFixtures) {
  if (fixture.startsWith(fixturePrefix))
    rmSync(fixture, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error("Migration phase check tests failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Migration phase check discriminated ${createdFixtures.length} fixture case(s).`,
);
