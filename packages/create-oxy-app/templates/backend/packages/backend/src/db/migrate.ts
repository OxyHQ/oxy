/**
 * Apply the SQL migrations in `packages/backend/drizzle/` to `DATABASE_URL`.
 *
 * This is the ONE migration mechanism for this package. `bun run db:migrate`
 * runs it, and production runs its COMPILED form (`dist/src/db/migrate.js`) as a
 * one-shot task before the new image rolls out. Nothing applies a migration by
 * any other route.
 *
 * ## Why not `drizzle-kit migrate`
 *
 * drizzle-kit is a devDependency and the shipped image installs production
 * dependencies only, so the CLI cannot reach production at all. `drizzle-orm` —
 * a runtime dependency — ships the migrator itself, so the migrator compiles
 * into the SAME image the service runs and adds no dependency.
 *
 * Both tools share ONE ledger: `drizzle-kit migrate` and drizzle's own
 * `migrate()` read the same `meta/_journal.json` and write the same
 * `drizzle.__drizzle_migrations` rows. drizzle-kit stays a devDependency for
 * `db:generate`, which only ever runs on a developer's machine.
 *
 * ## `--target-database=<name>` is REQUIRED, on every run including a dry run
 *
 * `expectedDatabase` is optional in `@oxyhq/db` so an existing consumer can
 * adopt the package without changing every invocation site. A new app adopts it
 * from day one, because this is the guard whose absence does not fail loudly:
 * pointed at the wrong database a migrator finds an empty ledger, applies the
 * entire journal, logs `Applied N` and exits 0 — leaving the real database
 * untouched while the operator reads a success line.
 *
 *     bun run db:migrate --target-database={{APP_SCHEME}}_dev
 *
 * ## `--phase=pre|post|all`, default `all`
 *
 * Every generated `.sql` file must carry `-- oxy:deploy-phase=pre` or
 * `-- oxy:deploy-phase=post` on its own line. There is no default and an
 * unmarked migration is a hard failure here, before any DDL runs — a default
 * would quietly pick a side for a migration whose author never considered the
 * question.
 *
 *   `pre`  — additive only (new table, new defaulted column, widened CHECK).
 *            Correct against the image still serving AND the one arriving, so
 *            it is applied BEFORE the rollout.
 *   `post` — anything that takes something away (DROP, RENAME, narrowed
 *            constraint). Applied early it is an outage on the image still
 *            serving, so it runs AFTER the new image is live.
 *
 * The default is `all` because a developer's own database has no previous image
 * to protect. A deploy workflow passes `pre` and `post` explicitly.
 *
 * ## `DRY_RUN`
 *
 * `DRY_RUN=true` reports what WOULD be applied and writes nothing — not even the
 * ledger table.
 */

import {
  MIGRATION_RUNS,
  readTargetDatabase,
  runMigrations,
  type MigrationRun,
  type RequiredExtension,
} from '@oxyhq/db/migrate';
import { logger } from '../utils/logger';
import { MIGRATIONS_FOLDER } from './migrationsFolder';

/**
 * The Postgres extensions this app's schema depends on, ensured before any
 * migration is applied rather than inside a numbered one.
 *
 * Empty for a fresh scaffold, and `ensureExtensions([])` opens no connection at
 * all, so this costs nothing until something is added.
 *
 * Add an entry the moment a column names an extension-provided type — PostGIS's
 * `geography` is the usual one. A migration naming such a type fails outright on
 * a database where the extension is absent, and only on a FRESH one: the shape
 * that passes on a warm developer machine and then fails in CI or on a newly
 * provisioned database. Making it a precondition of the MIGRATOR means the
 * ordering cannot be got wrong by renumbering, squashing or regenerating.
 *
 * Two things this does NOT do. `IF NOT EXISTS` short-circuits BEFORE the
 * privilege check, so it is a no-op for an unprivileged application role on an
 * already-prepared database — but it will not install an extension where one is
 * missing. A new managed database still needs a privileged role (`rds_superuser`
 * on RDS) to run `CREATE EXTENSION` once; see oxy-infra
 * `docs/runbooks/30-postgres-database-provisioning.md`. And a local Postgres
 * image must actually ship the extension: swap `docker-compose.postgres.yml` to
 * `postgis/postgis:17-3.5` before adding PostGIS here.
 */
const REQUIRED_EXTENSIONS: readonly RequiredExtension[] = [];

/** Whether `DRY_RUN` asks for a report instead of an apply. */
function isDryRun(): boolean {
  const value = (process.env.DRY_RUN ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * Read `--phase=<pre|post|all>` out of an argument list, defaulting to `all`.
 *
 * An unrecognised value throws rather than falling back: silently running `all`
 * for someone who typed `--phase=pre-deploy` is exactly the drop-applied-too-early
 * outage the phases exist to prevent.
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
    extensions: REQUIRED_EXTENSIONS,
    run,
    expectedDatabase,
    dryRun: isDryRun(),
    logger,
  });
}

main().catch((error: unknown) => {
  logger.error('Postgres migration failed', error);
  process.exitCode = 1;
});
