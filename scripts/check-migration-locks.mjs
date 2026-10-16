#!/usr/bin/env bun
/**
 * Fail the build when a new migration would hold a lock that stalls every
 * request reading a hot table.
 *
 * THE OUTAGE THIS EXISTS FOR
 *
 * 2026-10-16: 0170 dropped and re-added a CHECK on `applications` (an ACCESS
 * EXCLUSIVE lock), and the same deploy then spent 93 seconds backfilling
 * `files` before anything committed. The per-request service-auth read of
 * `applications` queued behind the lock — 16 AAS on the shared RDS, and every
 * product that calls Oxy fail-closed returned 503. `@oxy.so/db` now commits each
 * migration on its own under a short `lock_timeout`, which bounds the hold to
 * ONE migration; this gate keeps one migration from being the whole outage
 * again. The rules are in packages/api/src/db/MIGRATION-CONTRACT.md
 * ("Every migration keeps its locks short").
 *
 * WHAT IS CHECKED (migrations after BASELINE only; earlier ones are applied)
 *
 *   1. A FOREIGN KEY added to a table that already exists is `NOT VALID`; it is
 *      validated by `ALTER TABLE … VALIDATE CONSTRAINT` in a later migration.
 *   2. A migration that takes an ACCESS EXCLUSIVE lock on a HOT table (any
 *      ALTER TABLE other than a NOT VALID foreign key or a VALIDATE) does
 *      nothing slow in the same file: no UPDATE/DELETE/INSERT…SELECT, and no
 *      index build on a table the file did not create.
 *   3. An index on an existing HOT table is `CREATE INDEX IF NOT EXISTS`, so it
 *      can be built `CONCURRENTLY` out of band first (drizzle runs every
 *      migration inside a transaction, where CONCURRENTLY is impossible).
 *   4. Every `-- oxy:statement-timeout=` marker is legible (the runner's own reader).
 *
 * A migration that has been reviewed against these rules and must break one
 * says why, in its own file: `-- oxy:lock-review=<reason>`.
 *
 * Imports nothing but node builtins and @oxy.so/db's dependency-free marker
 * reader, so it runs before `bun install` like the gates beside it. Paths are
 * resolved from the working directory, so `scripts/test-check-migration-locks.mjs`
 * can run it against a mutated copy of the real migrations.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMigrationStatementTimeouts } from '../packages/db/src/migrate/locks.ts';

const DRIZZLE_FOLDER = join('packages', 'api', 'drizzle');
const JOURNAL_PATH = join(DRIZZLE_FOLDER, 'meta', '_journal.json');

/** The last migration applied before this gate existed. Later ones are checked. */
const BASELINE = 179;

/**
 * Tables read on (nearly) every request. An ACCESS EXCLUSIVE lock on one of
 * these is an outage for as long as it is held or waited for.
 */
export const HOT_TABLES = new Set([
  'account_closure_fences',
  'application_credentials',
  'application_workload_identities',
  'applications',
  'device_credentials',
  'device_sessions',
  'files',
  'organization_profiles',
  'sessions',
  'supervision_profiles',
  'users',
]);

const WAIVER = /^-- oxy:lock-review=(.+)$/m;
const IDENT = String.raw`(?:"?public"?\.)?"?([a-z0-9_]+)"?`;
const CREATE_TABLE = new RegExp(String.raw`^create table (?:if not exists )?${IDENT}`);
const ALTER_TABLE = new RegExp(String.raw`^alter table (?:if exists )?(?:only )?${IDENT}`);
const CREATE_INDEX = new RegExp(
  String.raw`^create (?:unique )?index (concurrently )?(if not exists )?(?:"?[a-z0-9_]+"? )?on (?:only )?${IDENT}`,
);
const FOREIGN_KEY = /\bforeign key\b/;
const NOT_VALID = /\bnot valid\s*;?\s*$/;
const DML = /^(update|delete from|insert into)\b/;

/** The executable statements of a migration, comments stripped, whitespace collapsed. */
function statementsOf(contents) {
  return contents
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase(),
    )
    .filter((statement) => statement.length > 0);
}

/** Problems with one migration's statements; empty when it is clean. */
export function lockProblems(tag, contents) {
  const statements = statementsOf(contents);
  const created = new Set();
  for (const statement of statements) {
    const match = CREATE_TABLE.exec(statement);
    if (match) created.add(match[1]);
  }

  const problems = [];
  const hotExclusive = [];
  const slow = [];

  for (const statement of statements) {
    const short = statement.length > 140 ? `${statement.slice(0, 140)}…` : statement;

    const alter = ALTER_TABLE.exec(statement);
    if (alter) {
      const table = alter[1];
      const isForeignKey = FOREIGN_KEY.test(statement) && /\badd constraint\b/.test(statement);
      if (isForeignKey && !created.has(table) && !NOT_VALID.test(statement)) {
        problems.push(
          `${tag}: foreign key on existing table "${table}" is validated in place — add it ` +
            `NOT VALID and VALIDATE CONSTRAINT in a later migration: ${short}`,
        );
      }
      const takesExclusive =
        !(isForeignKey && NOT_VALID.test(statement)) && !/\bvalidate constraint\b/.test(statement);
      if (takesExclusive && HOT_TABLES.has(table) && !created.has(table)) {
        hotExclusive.push(table);
      }
      continue;
    }

    const index = CREATE_INDEX.exec(statement);
    if (index) {
      const [, concurrently, ifNotExists, table] = index;
      if (!created.has(table)) {
        if (!concurrently) slow.push(`index build on existing table "${table}"`);
        if (HOT_TABLES.has(table) && !ifNotExists) {
          problems.push(
            `${tag}: index on hot table "${table}" without IF NOT EXISTS — build it ` +
              'CONCURRENTLY out of band first and make the migration a no-op over it: ' +
              short,
          );
        }
      }
      continue;
    }

    const dml = DML.exec(statement);
    if (dml) {
      const isInsertValues = dml[1] === 'insert into' && !/\bselect\b/.test(statement);
      if (!isInsertValues) slow.push(`${dml[1].split(' ')[0].toUpperCase()} (${short})`);
    }
  }

  if (hotExclusive.length > 0 && slow.length > 0) {
    problems.push(
      `${tag}: takes an ACCESS EXCLUSIVE lock on hot table(s) ` +
        `${[...new Set(hotExclusive)].join(', ')} and holds it while it runs ` +
        `${slow.join('; ')}. Put the hot-table DDL in its own migration.`,
    );
  }
  return problems;
}

function main() {
  const journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf8'));
  const tags = (journal?.entries ?? []).map((entry) => entry?.tag).filter(Boolean);
  if (tags.length < 10) {
    console.error(`Only ${tags.length} migration tag(s) parsed out of ${JOURNAL_PATH}.`);
    process.exit(1);
  }

  const problems = [...readMigrationStatementTimeouts(tags, DRIZZLE_FOLDER).problems];
  let checked = 0;
  for (const tag of tags) {
    if (Number.parseInt(tag.slice(0, 4), 10) <= BASELINE) continue;
    const contents = readFileSync(join(DRIZZLE_FOLDER, `${tag}.sql`), 'utf8');
    checked += 1;
    if (WAIVER.test(contents)) continue;
    problems.push(...lockProblems(tag, contents));
  }

  if (problems.length > 0) {
    console.error(`Migration lock check failed (${problems.length}):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      '\nSee packages/api/src/db/MIGRATION-CONTRACT.md. A reviewed exception says why in ' +
        'its own file: -- oxy:lock-review=<reason>',
    );
    process.exit(1);
  }
  console.log(`Migration lock check passed (${checked} migration(s) after ${BASELINE} checked).`);
}

if (import.meta.main) main();
