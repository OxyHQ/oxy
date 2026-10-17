/**
 * The migration lock gate: fail the build when a new migration would hold a
 * lock that stalls every request reading a table.
 *
 * THE OUTAGE THIS EXISTS FOR
 *
 * 2026-10-16: oxy-api's 0170 dropped and re-added a CHECK on `applications`
 * (an ACCESS EXCLUSIVE lock), and the same deploy then spent 93 seconds
 * backfilling `files` before anything committed. Every per-request read of
 * `applications` queued behind the lock. `runMigrations` now commits each
 * migration on its own under a short `lock_timeout`, which bounds the hold to
 * ONE migration; this gate keeps one migration from being the whole outage.
 *
 * WHAT IS CHECKED (migrations numbered after `baseline` only)
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
 *   4. Every `-- oxy:statement-timeout=` marker is legible (the runner's reader).
 *
 * A migration reviewed against these rules that must break one says why in
 * its own file: `-- oxy:lock-review=<reason>`.
 *
 * Node builtins only, so the `oxy-db-check-migration-locks` bin runs with
 * nothing but this package installed.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMigrationStatementTimeouts } from './locks';

/** Every table is hot: the conservative default for an app with no curated list. */
export const ALL_TABLES_HOT = '*';

/** Which tables count as hot: a set of names, or every table. */
export type HotTables = ReadonlySet<string> | typeof ALL_TABLES_HOT;

export const LOCK_REVIEW_WAIVER = /^-- oxy:lock-review=(.+)$/m;

const IDENT = String.raw`(?:"?public"?\.)?"?([a-z0-9_]+)"?`;
const CREATE_TABLE = new RegExp(String.raw`^create table (?:if not exists )?${IDENT}`);
const ALTER_TABLE = new RegExp(String.raw`^alter table (?:if exists )?(?:only )?${IDENT}`);
const CREATE_INDEX = new RegExp(
  String.raw`^create (?:unique )?index (concurrently )?(if not exists )?(?:"?[a-z0-9_]+"? )?on (?:only )?${IDENT}`,
);
const FOREIGN_KEY = /\bforeign key\b/;
const NOT_VALID = /\bnot valid\s*;?\s*$/;
const DML = /^(update|delete from|insert into)\b/;

function isHot(hotTables: HotTables, table: string): boolean {
  return hotTables === ALL_TABLES_HOT || hotTables.has(table);
}

/** The executable statements of a migration, comments stripped, whitespace collapsed. */
function statementsOf(contents: string): string[] {
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

/** Problems with one migration's statements; empty when it is clean. Ignores the waiver. */
export function migrationLockProblems(
  tag: string,
  contents: string,
  hotTables: HotTables,
): string[] {
  const statements = statementsOf(contents);
  const created = new Set<string>();
  for (const statement of statements) {
    const match = CREATE_TABLE.exec(statement);
    if (match) created.add(match[1]);
  }

  const problems: string[] = [];
  const hotExclusive: string[] = [];
  const slow: string[] = [];

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
      if (takesExclusive && isHot(hotTables, table) && !created.has(table)) {
        hotExclusive.push(table);
      }
      continue;
    }

    const index = CREATE_INDEX.exec(statement);
    if (index) {
      const [, concurrently, ifNotExists, table] = index;
      if (!created.has(table)) {
        if (!concurrently) slow.push(`index build on existing table "${table}"`);
        if (isHot(hotTables, table) && !ifNotExists) {
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

export interface CheckMigrationLocksOptions {
  /** The drizzle output folder (holding `meta/_journal.json` and the `.sql` files). */
  folder: string;
  /** The last migration number already applied everywhere; later ones are checked. */
  baseline: number;
  /** Tables read on (nearly) every request. Defaults to every table. */
  hotTables?: HotTables;
}

export interface CheckMigrationLocksResult {
  /** How many migrations after the baseline were looked at. */
  checked: number;
  /** Human-readable problems; empty means the gate passes. */
  problems: string[];
}

/** Run the gate over a drizzle migrations folder. */
export function checkMigrationLocks({
  folder,
  baseline,
  hotTables = ALL_TABLES_HOT,
}: CheckMigrationLocksOptions): CheckMigrationLocksResult {
  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries?: { tag?: string }[];
  };
  const tags = (journal.entries ?? [])
    .map((entry) => entry?.tag)
    .filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
  if (tags.length === 0) {
    return {
      checked: 0,
      problems: [`No migration tags in ${join(folder, 'meta', '_journal.json')}.`],
    };
  }

  const problems = [...readMigrationStatementTimeouts(tags, folder).problems];
  let checked = 0;
  for (const tag of tags) {
    if (Number.parseInt(tag.slice(0, 4), 10) <= baseline) continue;
    const contents = readFileSync(join(folder, `${tag}.sql`), 'utf8');
    checked += 1;
    if (LOCK_REVIEW_WAIVER.test(contents)) continue;
    problems.push(...migrationLockProblems(tag, contents, hotTables));
  }
  return { checked, problems };
}
