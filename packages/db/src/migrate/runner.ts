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
 *    caller's schema depends on exist, then apply. Skipped entirely on a dry
 *    run and when there is nothing pending, so a caller with no extension
 *    dependencies — and possibly no database yet — never causes this step to
 *    open a connection for no reason.
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
import postgres from 'postgres';
import { type RequiredExtension, ensureExtensions } from './extensions';
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

/** Seconds to wait for in-flight queries before forcing the socket shut. */
const CLOSE_TIMEOUT_SECONDS = 5;

export interface RunMigrationsOptions {
  readonly databaseUrl: string;
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
 * `@oxyhq/db/migrate`'s public surface — `migrate/index.ts` does not
 * re-export it. It has exactly one caller, {@link runMigrations}.
 *
 * @returns The temporary folder. The caller owns it and must remove it.
 */
export function materializeJournalPrefix(
  entries: readonly JournalEntry[],
  count: number,
  sourceFolder: string
): string {
  const retained = entries.slice(0, count);

  const folder = mkdtempSync(join(tmpdir(), 'oxydb-migrate-prefix-'));
  mkdirSync(join(folder, 'meta'), { recursive: true });

  const journal = JSON.parse(
    readFileSync(join(sourceFolder, 'meta', '_journal.json'), 'utf8')
  ) as Record<string, unknown>;
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: retained })
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
  const entries = readJournal(options.migrationsFolder);
  const { phases, problems } = readMigrationPhases(
    entries.map((entry) => entry.tag),
    options.migrationsFolder
  );
  if (problems.length > 0) {
    throw new Error(
      `${problems.length} migration(s) do not declare which side of a deploy they belong on:
${problems.map((problem) => `  - ${problem}`).join('\n')}`
    );
  }

  const client = postgres(options.databaseUrl, {
    max: 1,
    onnotice: (notice) => options.logger.debug(`Postgres notice: ${notice.message}`),
  });
  let prefixFolder: string | null = null;

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
    const pending = planLedgerRun(entries, await readAppliedMillis(client));

    const plan = planMigrationRun(pending, phases, options.run);
    if (plan.blocked) {
      throw new Error(plan.blocked);
    }

    if (plan.deferred.length > 0) {
      options.logger.info(
        `Leaving ${plan.deferred.length} migration(s) for a later phase (phase=${options.run}): ${plan.deferred.map((entry) => entry.tag).join(', ')}`
      );
    }

    if (plan.apply.length === 0) {
      options.logger.info(
        `No migrations to apply (phase=${options.run}, journal entries=${entries.length})`
      );
      return;
    }

    const tags = plan.apply.map((entry) => entry.tag);

    if (options.dryRun) {
      options.logger.info(
        `DRY RUN — ${plan.apply.length} migration(s) would be applied; nothing was written: ${tags.join(', ')}`
      );
      return;
    }

    // Only once there is confirmed work to do, and only after the target has
    // been verified: creating an extension on the wrong database is exactly
    // the mistake `assertMigrationTarget` exists to catch, and this call
    // opens its OWN connection to the same URL rather than reusing `client`.
    await ensureExtensions(options.databaseUrl, options.extensions);

    options.logger.info(`Applying ${plan.apply.length} migration(s): ${tags.join(', ')}`);

    // A phase that stops short points the migrator at a folder ending where
    // it stops; a phase applying everything pending uses the real one, so the
    // common path is byte for byte what it always was.
    let migrationsFolder = options.migrationsFolder;
    if (plan.deferred.length > 0) {
      const lastAppliedTag = plan.apply[plan.apply.length - 1].tag;
      const count = entries.findIndex((entry) => entry.tag === lastAppliedTag) + 1;
      prefixFolder = materializeJournalPrefix(entries, count, options.migrationsFolder);
      migrationsFolder = prefixFolder;
    }

    // No `schema`/`casing` here on purpose: `migrate()` only executes the raw
    // SQL text of the migration files, so it never builds a query from the
    // caller's schema definitions and stays independent of them.
    await migrate(drizzle(client), {
      migrationsFolder,
      migrationsSchema: MIGRATIONS_SCHEMA,
      migrationsTable: MIGRATIONS_TABLE,
    });

    // A migrator that reports success while leaving work pending is worse
    // than one that fails, so re-read the ledger rather than trusting the
    // call. Measured against what THIS run undertook — anything it
    // deliberately deferred is still pending on purpose.
    const stillPending = pendingEntries(entries, await readLastAppliedMillis(client));
    const remaining = plan.apply.filter((entry) =>
      stillPending.some((pendingEntry) => pendingEntry.tag === entry.tag)
    );
    if (remaining.length > 0) {
      throw new Error(
        `Migration reported success but ${remaining.length} migration(s) are still ` +
          `pending: ${remaining.map((entry) => entry.tag).join(', ')}`
      );
    }

    options.logger.info(`Applied ${plan.apply.length} migration(s): ${tags.join(', ')}`);
  } finally {
    if (prefixFolder) rmSync(prefixFolder, { recursive: true, force: true });
    await client.end({ timeout: CLOSE_TIMEOUT_SECONDS });
  }
}
