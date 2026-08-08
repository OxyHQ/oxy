import {
  MIGRATION_RUNS,
  readTargetDatabase,
  runMigrations,
  type MigrationRun,
} from '@oxyhq/db/migrate';
import { MIGRATIONS_FOLDER } from './migrationsFolder';
import { logger } from '../utils/logger';

/**
 * Apply the SQL migrations in `drizzle/` to `DATABASE_URL`.
 *
 * This is the ONE migration mechanism for {{APP_NAME}}. `bun run db:migrate` runs
 * it in development, and the built image runs its compiled form
 * (`dist/src/db/migrate.js`) as a one-shot task before a release goes live.
 *
 * ## Why not `drizzle-kit migrate`
 *
 * drizzle-kit is a devDependency, and the runtime image installs production
 * dependencies only — so the CLI could never apply a migration in production.
 * `drizzle-orm` is a runtime dependency and ships the migrator itself, so the
 * migrator compiles into the SAME image the service runs and adds no dependency
 * at all. Both tools share one ledger (`drizzle.__drizzle_migrations`), so a
 * database migrated by either is understood by the other. drizzle-kit stays for
 * `db:generate`, which only ever runs on a developer's machine.
 *
 * ## Do not call this from `server.ts`
 *
 * Migrating on boot looks convenient and is a race: every task in a scaled
 * service runs it at once, drizzle's migrator takes no lock, and the losers fail
 * on DDL the winner already applied. It also defeats the deploy phases below,
 * whose whole purpose is to put some migrations BEFORE the rollout and some
 * AFTER. Run it as a separate step.
 *
 * ## `--target-database=<name>` is required, on every run including a dry run
 *
 * This is the guard whose absence does not fail loudly. Pointed at the wrong
 * database a migrator finds an empty ledger, applies the entire journal, logs
 * `Applied N` and exits 0 — leaving the real database untouched while the
 * operator reads a success line. `@oxyhq/db` checks the named target against
 * `current_database()` as the first statement on the connection.
 *
 * ## `--phase=pre|post|all`, default `all`
 *
 * Every `.sql` file in `drizzle/` must carry exactly one marker line:
 *
 *     -- oxy:deploy-phase=pre     additive (new table, new defaulted column,
 *                                 widened CHECK). Correct against the image still
 *                                 serving AND the one arriving, so it is applied
 *                                 BEFORE the rollout.
 *     -- oxy:deploy-phase=post    anything that takes something away (DROP,
 *                                 RENAME, narrowed constraint). Applied early it
 *                                 is an outage on the image still serving, so it
 *                                 runs AFTER the new image is live.
 *
 * drizzle-kit cannot add the marker — add it by hand after every `db:generate`.
 * There is no default and an unmarked migration is a hard failure here, before
 * any DDL runs: a default would quietly pick a side for a migration whose author
 * never considered the question, which is the exact shape of the outage the
 * markers exist to prevent.
 *
 * `all` is the default because the callers that exist on day one — a developer's
 * own database, a test harness — have no previous image to protect. A deploy
 * pipeline passes `pre` and `post` explicitly.
 *
 * ## `DRY_RUN`
 *
 * `DRY_RUN=true` reports what WOULD be applied and writes nothing, not even the
 * ledger table.
 */

/** Whether `DRY_RUN` asks for a report instead of an apply. */
function isDryRun(): boolean {
  const value = (process.env.DRY_RUN ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * Read `--phase=<pre|post|all>`, defaulting to `all`.
 *
 * An unrecognised value throws rather than falling back: silently running `all`
 * for someone who typed `--phase=pre-deploy` applies the drop they were trying to
 * hold back, which is the outage rather than a typo.
 */
function readPhase(argv: readonly string[]): MigrationRun {
  const prefix = '--phase=';
  const flag = argv.find((arg) => arg.startsWith(prefix));
  if (!flag) return 'all';

  const value = flag.slice(prefix.length).trim();
  if (!(MIGRATION_RUNS as readonly string[]).includes(value)) {
    throw new Error(
      `Unrecognised --phase=${JSON.stringify(value)}. Use one of: ${MIGRATION_RUNS.join(', ')}.`,
    );
  }
  return value as MigrationRun;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Before DATABASE_URL, and before anything opens a socket: an operator who
  // forgot the flag should learn it instantly rather than after a connection.
  const expectedDatabase = readTargetDatabase(argv);
  const run = readPhase(argv);

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Start a local Postgres with: ' +
        'docker compose -f docker-compose.postgres.yml up -d postgres',
    );
  }

  await runMigrations({
    databaseUrl,
    migrationsFolder: MIGRATIONS_FOLDER,
    // No extensions are required by the starter schema. Add an entry here — for
    // example `{ name: 'postgis', reason: '…' }` — the moment a migration names a
    // type an extension provides. It runs BEFORE any migration is applied, on
    // every run, so the ordering cannot be got wrong by renumbering or squashing
    // the sequence. Note that on a managed database a privileged role must have
    // run `CREATE EXTENSION` once already: `IF NOT EXISTS` short-circuits before
    // the privilege check, so this is a no-op afterwards and a hard failure on an
    // unprepared database, never a fallback that installs it for you.
    extensions: [],
    run,
    expectedDatabase,
    dryRun: isDryRun(),
    logger: {
      info: (message) => logger.info(message),
      debug: (message) => logger.info(message),
    },
  });
}

main().catch((error: unknown) => {
  logger.error('Postgres migration failed', error);
  process.exitCode = 1;
});
