#!/usr/bin/env node
/**
 * oxy-db-check-migration-locks — the migration lock gate for any Oxy app.
 *
 *   oxy-db-check-migration-locks --folder <drizzle dir> --baseline <N> [--hot-tables a,b|'*']
 *
 * Checks every migration numbered after N in <drizzle dir>/meta/_journal.json
 * against the rules in `@oxy.so/db/migrate`'s lockGate (validated foreign keys,
 * hot-table DDL beside slow work, plain index builds on hot tables, illegible
 * statement-timeout markers). `--hot-tables` defaults to every table. A
 * reviewed exception says why in its own file: `-- oxy:lock-review=<reason>`.
 * Exits 1 with one line per problem, 0 when clean, 2 on bad arguments.
 */

import { createRequire } from 'node:module';

// The CommonJS build: the package declares no `type`, so Node would have to
// re-parse the ESM build (with a warning) to load it from here.
const { checkMigrationLocks } = createRequire(import.meta.url)('../dist/cjs/migrate/lockGate.js');

const USAGE =
  "Usage: oxy-db-check-migration-locks --folder <drizzle dir> --baseline <N> [--hot-tables a,b|'*']";

function readArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    if (!['--folder', '--baseline', '--hot-tables'].includes(flag)) {
      throw new Error(`Unknown argument ${argv[i]}`);
    }
    const value = inline ?? argv[++i];
    if (value === undefined || value === '') throw new Error(`${flag} needs a value`);
    args[flag.slice(2)] = value;
  }
  if (!args.folder) throw new Error('--folder is required');
  if (!/^\d+$/.test(args.baseline ?? '')) throw new Error('--baseline must be a migration number');
  return {
    folder: args.folder,
    baseline: Number(args.baseline),
    hotTables:
      args['hot-tables'] === undefined || args['hot-tables'] === '*'
        ? '*'
        : new Set(
            args['hot-tables']
              .split(',')
              .map((table) => table.trim())
              .filter(Boolean),
          ),
  };
}

let options;
try {
  options = readArgs(process.argv.slice(2));
} catch (error) {
  console.error(`${error.message}\n${USAGE}`);
  process.exit(2);
}

const { checked, problems } = checkMigrationLocks(options);
if (problems.length > 0) {
  console.error(`Migration lock check failed (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nEvery migration keeps its locks short: validate foreign keys NOT VALID + VALIDATE later, ' +
      'keep hot-table DDL apart from backfills and index builds, and build hot-table indexes ' +
      'CONCURRENTLY out of band behind CREATE INDEX IF NOT EXISTS. A reviewed exception says ' +
      'why in its own file: -- oxy:lock-review=<reason>',
  );
  process.exit(1);
}
console.log(
  `Migration lock check passed (${checked} migration(s) after ${options.baseline} checked).`,
);
