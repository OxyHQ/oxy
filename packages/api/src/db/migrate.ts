/**
 * Apply the SQL migrations in `drizzle/` to `DATABASE_URL`.
 *
 * This is the ONE migration mechanism in this package. `bun run db:migrate`
 * runs it, the jest harness (`src/db/testDatabase.ts`) shells out to that same
 * script, CI runs the same script, and production runs its COMPILED form
 * (`dist/db/migrate.js`) as a one-shot ECS task — twice per deploy at most, on
 * either side of the rollout (`.github/scripts/deploy-ecs-image.sh`), plus the
 * manual escape hatch (`.github/workflows/run-postgres-migrations.yml`).
 * Nothing applies a migration by any other route.
 *
 * The actual apply — journal read, ledger read, phase planning, extension
 * setup, `migrate()`, the post-apply re-check — is `runMigrations` from
 * `@oxyhq/db/migrate`; see its own doc comment for the full ordering and why
 * each step comes where it does. This file supplies everything that
 * mechanism needs from THIS package (its migrations folder, its required
 * extensions, its `--phase` argument) and keeps the ONE thing `runMigrations`
 * deliberately does not own: the cross-process advisory lock below.
 *
 * `--phase` IS REQUIRED, and says which side of a deployment this run stands
 * on. `@oxyhq/db/migrate`'s `phases.ts` explains the marker each migration
 * carries and the incident that put it there; the short version:
 *
 *   --phase=pre    the PREVIOUS image is still serving. Applies additive
 *                  migrations only, and stops at the first destructive one.
 *   --phase=post   the NEW image is live. Applies what `pre` deferred.
 *   --phase=all    nothing to protect — a developer's database, the jest
 *                  harness, the manual dispatch. Applies everything pending.
 *
 * There is no default. A run that does not say which side it is on would have
 * to guess, and guessing "pre" silently strands a drop while guessing "all"
 * silently runs one against a live previous image.
 *
 * `runMigrations`'s `expectedDatabase` option (the target-database affirmative
 * check — see its own doc comment in `@oxyhq/db/migrate`'s `runner.ts`) is
 * DELIBERATELY NOT wired here. Adopting it would newly require a
 * `--target-database` argument on every invocation of this file — the
 * package.json script, this jest harness, every developer's local command,
 * and both production deploy paths — which is a real behaviour change, not a
 * call-site adaptation, and out of scope for porting this file onto the
 * shared package unchanged. Wiring it is a deliberate follow-up, decided on
 * its own merits (including where the production database name comes from),
 * not a side effect of this port.
 *
 * WHY NOT `drizzle-kit migrate`
 *
 * drizzle-kit is a CLI that cannot reach production. `Dockerfile` builds the
 * runtime image with `bun install --production`, and that flag is exactly what
 * keeps `esbuild` OUT of the shipped image — `esbuild`'s arm64/alpine
 * postinstall is a known hard failure for this image (PR #261).
 * `drizzle-kit@0.31.10` declares `esbuild: ^0.25.4` as a direct dependency, so
 * promoting drizzle-kit to `dependencies` to make migrations reachable would
 * drag esbuild straight back in. A separate migration image would sidestep
 * that, but then migrations would be applied by different bytes than the
 * service runs.
 *
 * `drizzle-orm` — already a runtime dependency — ships the migrator itself. So
 * the migrator compiles into the SAME image the service runs, adds no
 * dependency at all, and the one-shot ECS task can reuse the LIVE task
 * definition with only `command` overridden (the pattern
 * `.github/workflows/seed-oxy-applications.yml` documents).
 *
 * drizzle-kit stays a devDependency for `db:generate`, which only ever runs on
 * a developer's machine and never opens a database.
 *
 * BOTH TOOLS SHARE ONE LEDGER. `drizzle-kit migrate` and `drizzle-orm`'s
 * `migrate()` read the same `meta/_journal.json`, write the same
 * `drizzle.__drizzle_migrations` rows, and apply the same "everything newer
 * than the newest recorded `created_at`" rule — so a database migrated by
 * either is understood by the other.
 *
 * ONE MIGRATOR AT A TIME. drizzle's migrator takes no lock of any kind: it
 * reads the newest ledger row OUTSIDE its transaction, then opens one and
 * replays everything newer. Two of them against one database both read the same
 * high-water mark and both replay the same DDL, so the loser fails on an
 * already-applied statement — after the winner has committed, and with a
 * duplicate ledger row left behind. Verified against a real Postgres 17. This
 * matters more now than it used to: a deploy runs the migrator on its own, so a
 * deploy and a manual dispatch can overlap, and their two workflows sit in
 * different GitHub concurrency groups and cannot see each other. Hence the
 * session advisory lock below, which is the only interlock both paths share.
 * `runMigrations` takes no lock of its own for exactly this reason (see its own
 * doc comment): a caller that can run concurrently with itself needs one held
 * on a connection it owns for its own lifetime, not on the short-lived
 * connection that function opens and closes internally.
 *
 * DRY RUN. `DRY_RUN=true` reports what this phase WOULD apply and writes
 * nothing — not even the ledger table.
 */

import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { type MigrationRun, MIGRATION_RUNS, runMigrations } from '@oxyhq/db/migrate';
import { ConfigurationError } from '../config/env';
import { logger } from '../utils/logger';
import { REQUIRED_EXTENSIONS } from './extensions';
import { MIGRATIONS_FOLDER } from './migrationsFolder';

/** Seconds to wait for in-flight queries before forcing the socket shut. */
const CLOSE_TIMEOUT_SECONDS = 5;

/**
 * The advisory-lock namespace. Hashed into a key rather than written as a magic
 * number so the value cannot be mistyped and the string says what it protects.
 */
const MIGRATION_LOCK_NAMESPACE = 'oxy-api:drizzle-migrations';

/**
 * How long to wait for another migrator to finish before giving up. A deploy's
 * pre-rollout task and a manual dispatch legitimately overlap; a real migration
 * against this database takes seconds, so a wait this long means the other
 * holder is stuck rather than busy, and failing is better than a one-shot task
 * that never stops.
 */
const LOCK_WAIT_MS = 10 * 60 * 1000;

/** How often to retry the lock while waiting. */
const LOCK_POLL_MS = 2_000;

/** Whether `DRY_RUN` asks for a report instead of an apply. */
function isDryRun(): boolean {
  const value = (process.env.DRY_RUN ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

/** The `--phase=<run>` argument. */
function readRun(argv: readonly string[]): MigrationRun {
  const flags = argv.filter((argument) => argument.startsWith('--phase='));

  if (flags.length === 0) {
    throw new ConfigurationError(
      `--phase is required. Use one of: ${MIGRATION_RUNS.map((run) => `--phase=${run}`).join(', ')}. ` +
      'See the header of src/db/migrate.ts for which one a given caller wants; ' +
      '`--phase=all` is the right answer for a developer database or a manual dispatch.'
    );
  }
  if (flags.length > 1) {
    throw new ConfigurationError(`--phase was given ${flags.length} times: ${flags.join(' ')}.`);
  }

  const value = flags[0].slice('--phase='.length);
  if (!(MIGRATION_RUNS as readonly string[]).includes(value)) {
    throw new ConfigurationError(
      `Unrecognised --phase=${value}. Use one of: ${MIGRATION_RUNS.join(', ')}.`
    );
  }
  return value as MigrationRun;
}

/** A stable signed 64-bit advisory-lock key for `name`. */
function advisoryLockKey(name: string): bigint {
  return createHash('sha256').update(name).digest().readBigInt64BE(0);
}

/**
 * Hold the migration advisory lock for the life of `client`'s session.
 *
 * The lock lives on its OWN connection, not on the pool `runMigrations`
 * migrates through: a session-level advisory lock belongs to the connection
 * that took it, so sharing one with the migrator would silently drop the lock
 * if postgres.js ever reconnected mid-run. Released when the session ends,
 * which `main`'s `finally` guarantees even when the process is killed.
 */
async function acquireMigrationLock(client: postgres.Sql): Promise<void> {
  const key = advisoryLockKey(MIGRATION_LOCK_NAMESPACE).toString();
  const deadline = Date.now() + LOCK_WAIT_MS;
  let waited = false;

  for (;;) {
    const [row] = await client<{ locked: boolean }[]>`
      select pg_try_advisory_lock(${key}::bigint) as locked
    `;
    if (row?.locked) {
      if (waited) logger.info('Acquired the migration lock');
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Another migration has held the ${MIGRATION_LOCK_NAMESPACE} advisory lock for ` +
        `${Math.round(LOCK_WAIT_MS / 1000)}s. Refusing to migrate alongside it: drizzle's ` +
        'migrator takes no lock of its own, so two concurrent runs replay the same DDL. ' +
        'Find the other run before retrying.'
      );
    }

    if (!waited) {
      waited = true;
      logger.warn('Another migration holds the migration lock; waiting', {
        waitSeconds: Math.round(LOCK_WAIT_MS / 1000),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

async function main(): Promise<void> {
  // Argument validation first, and before DATABASE_URL: it is the cheapest and
  // most local failure, and it lets the deploy workflow prove an image
  // understands `--phase` without handing it a database
  // (`run-postgres-migrations.yml`, "Assert the image can actually migrate").
  const run = readRun(process.argv.slice(2));

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new ConfigurationError(
      'DATABASE_URL is not set. See packages/api/.env.example, or start a local ' +
      'Postgres with: docker compose -f docker-compose.dev.yml up -d postgres'
    );
  }

  // The lock's own connection, taken before `runMigrations` reads anything, so
  // the pending calculation inside it cannot be invalidated by another
  // migrator between its read and its apply.
  const lockClient = postgres(url, { max: 1 });

  try {
    await acquireMigrationLock(lockClient);

    await runMigrations({
      databaseUrl: url,
      migrationsFolder: MIGRATIONS_FOLDER,
      extensions: REQUIRED_EXTENSIONS,
      run,
      // expectedDatabase intentionally omitted — see this file's header.
      dryRun: isDryRun(),
      logger,
    });
  } finally {
    // Ends the lock's session, which is what releases the advisory lock.
    await lockClient.end({ timeout: CLOSE_TIMEOUT_SECONDS });
  }
}

main().catch((error: unknown) => {
  logger.error('Migration failed', error);
  // Not `process.exit`: the pino transport used in development writes from a
  // worker thread, and exiting here would truncate the very message that says
  // what went wrong. The event loop is already free once the pool is closed.
  process.exitCode = 1;
});
