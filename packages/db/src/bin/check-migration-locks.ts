#!/usr/bin/env node
/**
 * `oxy-db-check-migration-locks` — the migration lock gate as a CI step.
 *
 *   oxy-db-check-migration-locks --migrations=packages/backend/drizzle \
 *     --after=0012 --hot-tables=users,sessions
 *
 * `--migrations` is the drizzle folder (default `drizzle`, resolved from the
 * working directory). `--after` is the last migration applied before the app
 * adopted the gate (required: an app states its own baseline). `--hot-tables`
 * lists the tables read on (nearly) every request (may be empty). Exits 1 with
 * every problem listed; see `migrate/lockGate.ts` for the rules.
 */

import { resolve } from 'node:path';
import { checkMigrationLocks } from '../migrate/lockGate';

function flag(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length).trim();
}

function main(argv: readonly string[]): number {
  const folder = resolve(flag(argv, 'migrations') ?? 'drizzle');
  const afterFlag = flag(argv, 'after');
  const after = afterFlag === undefined ? Number.NaN : Number.parseInt(afterFlag, 10);
  if (!Number.isSafeInteger(after) || after < -1) {
    console.error('--after=<n> is required: the last migration number the gate does not check.');
    return 2;
  }
  const hotTables = (flag(argv, 'hot-tables') ?? '')
    .split(',')
    .map((table) => table.trim())
    .filter((table) => table.length > 0);

  const { checked, problems } = checkMigrationLocks({ migrationsFolder: folder, after, hotTables });
  if (problems.length > 0) {
    console.error(`Migration lock check failed (${problems.length}):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      '\nEvery migration keeps its locks short (oxy MIGRATION-CONTRACT.md). A reviewed ' +
        'exception says why in its own file: -- oxy:lock-review=<reason>',
    );
    return 1;
  }
  console.log(`Migration lock check passed (${checked} migration(s) after ${after} checked).`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
