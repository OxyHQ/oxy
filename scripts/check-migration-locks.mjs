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
 * The rules themselves are `@oxy.so/db`'s (`packages/db/src/migrate/lockGate.ts`,
 * the same code apps run as `oxy-db-check-migration-locks`); this file supplies
 * oxy-api's folder, baseline and hot tables. Imports nothing but node builtins
 * and that dependency-free module, so it runs before `bun install` like the
 * gates beside it. Paths are
 * resolved from the working directory, so `scripts/test-check-migration-locks.mjs`
 * can run it against a mutated copy of the real migrations.
 */

import { join } from 'node:path';
import { checkMigrationLocks } from '../packages/db/src/migrate/lockGate.ts';

const DRIZZLE_FOLDER = join('packages', 'api', 'drizzle');

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

function main() {
  const { checked, problems } = checkMigrationLocks({
    migrationsFolder: DRIZZLE_FOLDER,
    after: BASELINE,
    hotTables: HOT_TABLES,
  });

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
