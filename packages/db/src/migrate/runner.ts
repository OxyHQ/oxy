/**
 * Apply a consumer's drizzle migrations, in the one order that keeps the
 * three preconditions this package exists to enforce from ever being
 * skipped: the right database, an unbroken ledger, and — when the caller is
 * mid-deploy — only the migrations safe for the side of the rollout it is
 * running on.
 *
 * This is deliberately a single function rather than three call sites a
 * consumer's own entrypoint composes itself. Each precondition below was
 * added after a real outage in a consumer that DID compose them by hand and
 * got the order wrong once; putting the order here instead means there is
 * exactly one place it can be gotten right, and every consumer inherits it.
 *
 * ORDER, AND WHY IT IS NOT INTERCHANGEABLE
 *
 * 1. Read the journal and the deploy-phase marker of every migration in it —
 *    pure filesystem reads, no connection opened yet. A malformed marker or
 *    a journal entry with no `.sql` file beside it is the cheapest possible
 *    failure to report, and reporting it before anything touches a database
 *    means a broken migrations folder never gets the chance to look like a
 *    database problem.
 * 2. Open the one connection this run drives its DDL through, and immediately
 *    assert it is pointed at the expected database — the FIRST statement
 *    issued on it, because everything after this is a write or a
 *    precondition for one (see `targetDatabase.ts`). Checked after step 1
 *    specifically because step 1 opens no connection at all: there is
 *    nothing to protect yet.
 * 3. Read the applied-migration ledger and compute what is pending, refusing
 *    outright if the journal holds an entry the apply rule can never reach
 *    (see `ledger.ts`) rather than silently reporting a clean run over a
 *    migration that will never execute.
 * 4. Decide what THIS run may apply, given which side of a deploy it is
 *    running on — refusing outright if a pending migration declares no
 *    phase, or if no ordering is safe for either the image currently serving
 *    or the one about to (see `phases.ts`).
 * 5. Only once there is confirmed work to do: ensure the extensions the
 *    caller's schema depends on exist, then apply — ONE MIGRATION PER
 *    TRANSACTION, each under a short `lock_timeout` and a bounded
 *    `statement_timeout`, retried with backoff when its locks do not come
 *    (see `locks.ts` for the outage that made this the rule). Skipped
 *    entirely on a dry run and when there is nothing pending, so a caller
 *    with no extension dependencies — and possibly no database yet — never
 *    causes this step to open a connection for no reason.
 * 6. Re-read the ledger after `migrate()` returns and confirm every migration
 *    this run intended to apply is actually recorded. A migrator that reports
 *    success while leaving work pending is worse than one that fails.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It takes no lock against a second concurrent migrator. drizzle's migrator
 * itself takes none — it reads the ledger's high-water mark outside its
 * transaction, then replays everything newer inside one — so two runs
 * against the same database both read the same mark and both attempt the
 * same DDL; the loser fails on an already-applied statement after the winner
 * has committed. A caller that can run concurrently with itself (a deploy's
 * own migration step racing a manually dispatched one, for example) needs an
 * interlock of its own around its call to {@link runMigrations} — session-scoped
 * advisory locks are the mechanism postgres offers for exactly this, taken on
 * a connection held for the caller's own lifetime, not on the short-lived one
 * this function opens and closes internally.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import {
  DEFAULT_DATABASE_DRIVER,
  type DatabaseDriver,
  bunSqlMigrate,
  executeStatement,
  openOwnedConnection,
} from '../driver';
import { type RequiredExtension, ensureExtensions } from './extensions';
import {
  DEFAULT_LOCK_ATTEMPTS,
  DEFAULT_LOCK_RETRY_BASE_DELAY_MS,
  DEFAULT_LOCK_RETRY_MAX_DELAY_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  isLockContention,
  lockRetryDelayMs,
  readMigrationStatementTimeouts,
} from './locks';
import {
  type JournalEntry,
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
  pendingEntries,
  planLedgerRun,
  readAppliedMillis,
  readJournal,
  readLastAppliedMillis,
} from './ledger';
import { type MigrationRun, planMigrationRun, readMigrationPhases } from './phases';
import { assertMigrationTarget } from './targetDatabase';
import { assertAppliedMigrations, readAppliedRows, readJournalWithHashes } from './verify';

/** Seconds to wait for in-flight queries before forcing the socket shut. */
const CLOSE_TIMEOUT_SECONDS = 5;

export interface RunMigrationsOptions {
  readonly databaseUrl: string;
  /**
   * The client every connection this run opens goes through — the DDL
   * connection, the target check, the ledger reads and `ensureExtensions`.
   * Default `postgres-js`. `bun-sql` (Bun only) drives the same steps in the
   * same order through `Bun.SQL` and `drizzle-orm/bun-sql/migrator`, which
   * applies migrations with the same `PgDialect.migrate` and writes the same
   * ledger table and rows; the one difference is that `Bun.SQL` has no NOTICE
   * hook, so `logger.debug` receives no server notices.
   */
  readonly driver?: DatabaseDriver;
  /** Absolute path to the drizzle migrations folder in the CALLER's own package. */
  readonly migrationsFolder: string;
  /** The extensions the caller's schema depends on. `[]` for none. */
  readonly extensions: readonly RequiredExtension[];
  /** Which side of the deploy this invocation is. */
  readonly run: MigrationRun;
  /**
   * The database name this connection must resolve to, from
   * `readTargetDatabase(argv)` — OPTIONAL, and deliberately so.
   *
   * A guard is a capability a caller ADOPTS, not a tax this package levies:
   * `assertMigrationTarget` is a real safety improvement (see
   * `targetDatabase.ts` for the outage it prevents), but a consumer that has
   * never carried it should not be forced to invent a `--target-database`
   * value — and thread it through every invocation site (a deploy script, a
   * manual-dispatch workflow, a test harness, every developer's local
   * command) — just to adopt `runMigrations`. That is a behaviour change
   * with no narrower shape than "everyone's workflow changes today," and this
   * package does not get to impose it as a side effect of being adopted.
   *
   * Omitted, `assertMigrationTarget` does not run at all — not a no-op check
   * against an inferred value, an absent one. Deriving a default from
   * `options.databaseUrl`'s own pathname would check the URL against itself
   * and could never fail, which is worse than not checking: it would look
   * like protection and provide none.
   *
   * A future caller should not "tidy" this back to required. Leave it
   * optional; let each consumer decide for itself, on its own schedule.
   */
  readonly expectedDatabase?: string;
  /**
   * Report what this run WOULD apply and write nothing — not even the
   * ledger table. The caller decides how this is triggered (an env var, a
   * flag); this function only acts on the resolved boolean.
   */
  readonly dryRun: boolean;
  /** Exact migration identities that must already be applied before planning. */
  readonly requiredAppliedTags?: readonly string[];
  /**
   * How long one statement may wait for a lock, in ms. Default
   * {@link DEFAULT_LOCK_TIMEOUT_MS}. While an ACCESS EXCLUSIVE request waits,
   * every later reader of that table waits behind it, so keep this short.
   */
  readonly lockTimeoutMs?: number;
  /**
   * How long one statement may run, in ms, for a migration that declares no
   * `-- oxy:statement-timeout=<n>s` marker of its own. Default
   * {@link DEFAULT_STATEMENT_TIMEOUT_MS}.
   */
  readonly statementTimeoutMs?: number;
  /**
   * Retries after a lock timeout or deadlock. `attempts` counts the first try;
   * the wait before retry `n` is full jitter over `min(maxDelayMs,
   * baseDelayMs * 2^(n-1))`. Defaults: {@link DEFAULT_LOCK_ATTEMPTS},
   * {@link DEFAULT_LOCK_RETRY_BASE_DELAY_MS}, {@link DEFAULT_LOCK_RETRY_MAX_DELAY_MS}.
   */
  readonly lockRetry?: {
    readonly attempts?: number;
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
  };
  readonly logger: {
    info(message: string): void;
    debug(message: string): void;
  };
}

/**
 * A throwaway migrations folder holding only the first `count` journal
 * entries and their `.sql` files.
 *
 * WHY THIS EXISTS. drizzle's migrator reads its own folder and applies every
 * entry newer than the newest one the ledger records; there is no public way
 * to hand it a subset. A `pre`-phase run that must stop before a `post`
 * migration therefore points the migrator at a folder that ends there. The
 * `.sql` files are copied byte for byte, so the `hash` drizzle records is
 * identical to the one a full-folder run would have recorded — a later full
 * run cannot tell the difference.
 *
 * Deliberately NOT `db.dialect.migrate(subset, ...)`, which would reach past
 * the public `migrate()` helper: drizzle marks `dialect` and `session`
 * `@internal` and does not declare them on `PgDatabase`, so reaching them needs
 * a cast this repository does not permit.
 *
 * Exported for direct unit testing (it needs no database), but NOT part of
 * `@oxy.so/db/migrate`'s public surface — `migrate/index.ts` does not
 * re-export it. It has exactly one caller, {@link runMigrations}.
 *
 * @returns The temporary folder. The caller owns it and must remove it.
 */
export function materializeJournalPrefix(
  entries: readonly JournalEntry[],
  count: number,
  sourceFolder: string,
): string {
  const retained = entries.slice(0, count);

  const folder = mkdtempSync(join(tmpdir(), 'oxydb-migrate-prefix-'));
  mkdirSync(join(folder, 'meta'), { recursive: true });

  const journal = JSON.parse(
    readFileSync(join(sourceFolder, 'meta', '_journal.json'), 'utf8'),
  ) as Record<string, unknown>;
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: retained }),
  );
  for (const entry of retained) {
    copyFileSync(join(sourceFolder, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }

  return folder;
}

/**
 * Apply pending migrations to `options.databaseUrl`, in the order described
 * in this module's header.
 *
 * @throws {Error} When `options.expectedDatabase` is supplied and the
 *   connected database is not it, when the journal holds an unreachable
 *   entry, when a pending migration's deploy phase cannot be resolved safely
 *   for `options.run`, when an extension the schema depends on cannot be
 *   ensured, or when `migrate()` reports success but the ledger disagrees.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<void> {
  // Pure filesystem reads, no connection opened yet — the cheapest possible
  // failure, and it must be reported before anything below could be mistaken
  // for a database problem instead of a migrations-folder one.
  const fullEntries = readJournal(options.migrationsFolder);
  const { phases, problems } = readMigrationPhases(
    fullEntries.map((entry) => entry.tag),
    options.migrationsFolder,
  );
  if (problems.length > 0) {
    throw new Error(
      `${problems.length} migration(s) do not declare which side of a deploy they belong on:
${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    );
  }
  const timeouts = readMigrationStatementTimeouts(
    fullEntries.map((entry) => entry.tag),
    options.migrationsFolder,
  );
  if (timeouts.problems.length > 0) {
    throw new Error(
      `${timeouts.problems.length} migration(s) carry an illegible statement-timeout marker:
${timeouts.problems.map((problem) => `  - ${problem}`).join('\n')}`,
    );
  }
  const limits = resolveLockLimits(options);

  const entries = fullEntries;

  const driver = options.driver ?? DEFAULT_DATABASE_DRIVER;
  // The defaults ride in the startup packet so they hold for every statement
  // on this connection — the ledger reads, and a transparent reconnect —
  // before the per-migration `SET`s below narrow or widen them.
  const connection = openOwnedConnection(
    options.databaseUrl,
    driver,
    (message) => options.logger.debug(`Postgres notice: ${message}`),
    {
      lock_timeout: `${limits.lockTimeoutMs}ms`,
      statement_timeout: `${limits.statementTimeoutMs}ms`,
    },
  );
  const { client } = connection;

  try {
    // FIRST statement on this connection, when the caller opted in — see
    // targetDatabase.ts for why everything below must come after it. A
    // caller that did not supply `expectedDatabase` gets no check at all,
    // not a check against a guessed value (see the option's own doc comment
    // for why no default is safe).
    if (options.expectedDatabase !== undefined) {
      await assertMigrationTarget(client, options.expectedDatabase);
    }

    // Refuses outright rather than reporting a clean run over a migration the
    // apply rule can never reach.
    const appliedMillis = await readAppliedMillis(client);
    if (options.requiredAppliedTags && options.requiredAppliedTags.length > 0) {
      assertAppliedMigrations(
        readJournalWithHashes(options.migrationsFolder),
        await readAppliedRows(client),
        options.requiredAppliedTags,
      );
      options.logger.info(
        `Verified required applied migrations: ${options.requiredAppliedTags.join(', ')}`,
      );
    }
    const pending = planLedgerRun(entries, appliedMillis);

    const plan = planMigrationRun(pending, phases, options.run);
    if (plan.blocked) {
      throw new Error(plan.blocked);
    }

    if (plan.deferred.length > 0) {
      options.logger.info(
        `Leaving ${plan.deferred.length} migration(s) for a later phase (phase=${options.run}): ${plan.deferred.map((entry) => entry.tag).join(', ')}`,
      );
    }

    if (plan.apply.length === 0) {
      options.logger.info(
        `No migrations to apply (phase=${options.run}, journal entries=${entries.length})`,
      );
      return;
    }

    const tags = plan.apply.map((entry) => entry.tag);

    if (options.dryRun) {
      options.logger.info(
        `DRY RUN — ${plan.apply.length} migration(s) would be applied; nothing was written: ${tags.join(', ')}`,
      );
      return;
    }

    // Only once there is confirmed work to do, and only after the target has
    // been verified: creating an extension on the wrong database is exactly
    // the mistake `assertMigrationTarget` exists to catch, and this call
    // opens its OWN connection to the same URL rather than reusing `client`.
    await ensureExtensions(options.databaseUrl, options.extensions, { driver });

    options.logger.info(
      `Applying ${plan.apply.length} migration(s), one transaction each ` +
        `(lock_timeout=${limits.lockTimeoutMs}ms): ${tags.join(', ')}`,
    );

    // ONE MIGRATION PER TRANSACTION. drizzle's `migrate()` applies everything
    // newer than the ledger's newest row in a single transaction, so handing it
    // the whole folder would hold the first migration's locks until the last
    // one commits — the 2026-10-16 outage (`locks.ts`). Handing it a folder
    // that ENDS at the next pending migration applies exactly that one and
    // commits it. Each prefix is a byte-for-byte copy (`materializeJournalPrefix`),
    // so the ledger rows are identical to a whole-folder run's.
    for (const entry of plan.apply) {
      const index = entries.findIndex((candidate) => candidate.tag === entry.tag);
      const prefixFolder =
        index === entries.length - 1
          ? null
          : materializeJournalPrefix(entries, index + 1, options.migrationsFolder);
      try {
        await applyOneMigration({
          tag: entry.tag,
          migrationsFolder: prefixFolder ?? options.migrationsFolder,
          statementTimeoutMs:
            timeouts.statementTimeoutsMs.get(entry.tag) ?? limits.statementTimeoutMs,
          limits,
          connection,
          logger: options.logger,
        });
      } finally {
        if (prefixFolder) rmSync(prefixFolder, { recursive: true, force: true });
      }
    }

    // A migrator that reports success while leaving work pending is worse
    // than one that fails, so re-read the ledger rather than trusting the
    // call. Measured against what THIS run undertook — anything it
    // deliberately deferred is still pending on purpose.
    const stillPending = pendingEntries(entries, await readLastAppliedMillis(client));
    const remaining = plan.apply.filter((entry) =>
      stillPending.some((pendingEntry) => pendingEntry.tag === entry.tag),
    );
    if (remaining.length > 0) {
      throw new Error(
        `Migration reported success but ${remaining.length} migration(s) are still ` +
          `pending: ${remaining.map((entry) => entry.tag).join(', ')}`,
      );
    }

    options.logger.info(`Applied ${plan.apply.length} migration(s): ${tags.join(', ')}`);
  } finally {
    await connection.close(CLOSE_TIMEOUT_SECONDS);
  }
}

interface LockLimits {
  readonly lockTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

function resolveLockLimits(options: RunMigrationsOptions): LockLimits {
  const limits: LockLimits = {
    lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    statementTimeoutMs: options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    attempts: options.lockRetry?.attempts ?? DEFAULT_LOCK_ATTEMPTS,
    baseDelayMs: options.lockRetry?.baseDelayMs ?? DEFAULT_LOCK_RETRY_BASE_DELAY_MS,
    maxDelayMs: options.lockRetry?.maxDelayMs ?? DEFAULT_LOCK_RETRY_MAX_DELAY_MS,
  };
  // Zero means "no limit" to Postgres, which is exactly what this exists to
  // prevent, so it is refused rather than passed through.
  for (const [name, value] of Object.entries(limits)) {
    const minimum = name === 'baseDelayMs' || name === 'maxDelayMs' ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`runMigrations: ${name} must be an integer >= ${minimum}, got ${value}.`);
    }
  }
  return limits;
}

/**
 * Apply the single pending migration at the end of `migrationsFolder` in its
 * own transaction, retrying the whole migration when it loses a lock race.
 */
async function applyOneMigration(step: {
  readonly tag: string;
  readonly migrationsFolder: string;
  readonly statementTimeoutMs: number;
  readonly limits: LockLimits;
  readonly connection: ReturnType<typeof openOwnedConnection>;
  readonly logger: RunMigrationsOptions['logger'];
}): Promise<void> {
  const { tag, limits, connection } = step;
  // No `schema`/`casing` here on purpose: `migrate()` only executes the raw
  // SQL text of the migration files, so it never builds a query from the
  // caller's schema definitions and stays independent of them.
  const migrationConfig = {
    migrationsFolder: step.migrationsFolder,
    migrationsSchema: MIGRATIONS_SCHEMA,
    migrationsTable: MIGRATIONS_TABLE,
  };

  for (let attempt = 1; ; attempt += 1) {
    const startedAt = Date.now();
    try {
      // Session-level, on the one connection the migration's transaction runs
      // on. Set every attempt: a reconnect would otherwise fall back to the
      // startup defaults and silently drop a migration's declared timeout.
      await executeStatement(connection.client, `set lock_timeout = '${limits.lockTimeoutMs}ms'`);
      await executeStatement(
        connection.client,
        `set statement_timeout = '${step.statementTimeoutMs}ms'`,
      );
      if (connection.driver === 'bun-sql') {
        await bunSqlMigrate(connection.client, migrationConfig);
      } else {
        await migrate(drizzle(connection.client), migrationConfig);
      }
      step.logger.info(`Applied ${tag} in ${Date.now() - startedAt}ms`);
      return;
    } catch (error) {
      if (!isLockContention(error)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      if (attempt >= limits.attempts) {
        throw new Error(
          `${tag}: could not take its locks within ${limits.lockTimeoutMs}ms on any of ` +
            `${limits.attempts} attempts (last: ${reason}). Nothing of ${tag} was applied; ` +
            'something holds a conflicting lock on a table it alters — find it ' +
            '(pg_locks / pg_stat_activity) before retrying.',
        );
      }
      const delayMs = lockRetryDelayMs(attempt, limits.baseDelayMs, limits.maxDelayMs);
      step.logger.info(
        `${tag}: lock not available within ${limits.lockTimeoutMs}ms (attempt ` +
          `${attempt}/${limits.attempts}: ${reason}); rolled back, retrying in ${delayMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
