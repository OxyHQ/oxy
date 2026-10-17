/**
 * The CI gate that keeps one migration from holding a lock that stalls every
 * request reading a hot table.
 *
 * `runMigrations` bounds a lock to ONE migration (each commits on its own,
 * under `lock_timeout`; see `locks.ts`). This gate keeps that one migration
 * short. It is the same check oxy-api runs (`scripts/check-migration-locks.mjs`)
 * and every app runs through the `oxy-db-check-migration-locks` bin; the rules
 * are in oxy's `packages/api/src/db/MIGRATION-CONTRACT.md` ("Every migration
 * keeps its locks short"):
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
 *   4. Every `-- oxy:statement-timeout=` marker is legible.
 *
 * Which tables are hot is the app's to say: the ones read on (nearly) every
 * request. A migration reviewed against these rules that must break one says
 * why in its own file: `-- oxy:lock-review=<reason>`.
 *
 * Imports nothing but Node builtins and the dependency-free marker reader, so
 * a gate can run it before `bun install`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMigrationStatementTimeouts } from './locks';

/** The waiver a reviewed migration carries, with its reason. */
export const LOCK_REVIEW_WAIVER = /^-- oxy:lock-review=(.+)$/m;

const IDENT = String.raw`(?:"?public"?\.)?"?([a-z0-9_]+)"?`;
const CREATE_TABLE = new RegExp(String.raw`^create table (?:if not exists )?${IDENT}`);
const ALTER_TABLE = new RegExp(String.raw`^alter table (?:if exists )?(?:only )?${IDENT}`);
const CREATE_INDEX = new RegExp(
  String.raw`^create (?:unique )?index (concurrently )?(if not exists )?(?:"?[a-z0-9_]+"? )?on (?:only )?${IDENT}`,
);
const FOREIGN_KEY = /\bforeign key\b/;
const DML = /^(update|delete from|insert into)\b/;

/**
 * Whether a (whitespace-collapsed) statement ends `NOT VALID`. A string test,
 * not a trailing-whitespace regex: the input is a migration file, and
 * `\s*;?\s*$` backtracks polynomially on a long run of spaces.
 */
function endsNotValid(statement: string): boolean {
  const body = statement.endsWith(';') ? statement.slice(0, -1).trimEnd() : statement;
  return body === 'not valid' || body.endsWith(' not valid');
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

/**
 * Lock problems in one migration's SQL; empty when it is clean. Does not look
 * at the waiver: {@link checkMigrationLocks} does.
 */
export function migrationLockProblems(
  tag: string,
  contents: string,
  hotTables: ReadonlySet<string>,
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
      if (isForeignKey && !created.has(table) && !endsNotValid(statement)) {
        problems.push(
          `${tag}: foreign key on existing table "${table}" is validated in place — add it ` +
            `NOT VALID and VALIDATE CONSTRAINT in a later migration: ${short}`,
        );
      }
      const takesExclusive =
        !(isForeignKey && endsNotValid(statement)) && !/\bvalidate constraint\b/.test(statement);
      if (takesExclusive && hotTables.has(table) && !created.has(table)) {
        hotExclusive.push(table);
      }
      continue;
    }

    const index = CREATE_INDEX.exec(statement);
    if (index) {
      const [, concurrently, ifNotExists, table] = index;
      if (!created.has(table)) {
        if (!concurrently) slow.push(`index build on existing table "${table}"`);
        if (hotTables.has(table) && !ifNotExists) {
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
  /** The drizzle folder (the one holding `meta/_journal.json`). */
  migrationsFolder: string;
  /**
   * Migrations whose numeric tag prefix is at or below this are already
   * applied everywhere and are not checked (their statement-timeout markers
   * still are). `-1` checks every migration.
   */
  after: number;
  /** Tables read on (nearly) every request. */
  hotTables: Iterable<string>;
}

export interface CheckMigrationLocksResult {
  /** How many migrations after the baseline were checked (waived ones included). */
  checked: number;
  /** Human-readable problems. Empty means the gate passes. */
  problems: string[];
}

/** Run the gate over a drizzle folder. Throws only when the journal cannot be read. */
export function checkMigrationLocks(
  options: CheckMigrationLocksOptions,
): CheckMigrationLocksResult {
  const journalPath = join(options.migrationsFolder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries?: Array<{ tag?: unknown }>;
  };
  const tags = (journal.entries ?? [])
    .map((entry) => entry?.tag)
    .filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
  if (tags.length === 0) {
    throw new Error(`No migration tags in ${journalPath}.`);
  }

  const hotTables = new Set(options.hotTables);
  const problems = [...readMigrationStatementTimeouts(tags, options.migrationsFolder).problems];
  let checked = 0;
  for (const tag of tags) {
    const index = Number.parseInt(tag, 10);
    if (Number.isSafeInteger(index) && index <= options.after) continue;
    let contents: string;
    try {
      contents = readFileSync(join(options.migrationsFolder, `${tag}.sql`), 'utf8');
    } catch {
      problems.push(`${tag}: listed in the journal but ${tag}.sql cannot be read.`);
      continue;
    }
    checked += 1;
    if (LOCK_REVIEW_WAIVER.test(contents)) continue;
    problems.push(...migrationLockProblems(tag, contents, hotTables));
  }
  return { checked, problems };
}
