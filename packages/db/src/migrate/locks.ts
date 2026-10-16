/**
 * How long a migration may wait for a lock, how long one statement may run,
 * and what happens when the lock does not come.
 *
 * THE OUTAGE THIS EXISTS FOR
 *
 * On 2026-10-16 oxy-api's deploy applied seven migrations (0170–0176) in ONE
 * transaction — drizzle's `migrate()` wraps every pending migration in a single
 * `BEGIN … COMMIT`. The first of them dropped and re-added a CHECK on
 * `applications`, which takes an ACCESS EXCLUSIVE lock, and that lock was then
 * held for the 93 seconds the other six spent backfilling `files` and copying
 * rows. Every request that read `applications` — the per-request service-auth
 * lookup among them — queued behind it: 16 average active sessions on the
 * shared RDS, and every product that calls Oxy fail-closed returned 503.
 *
 * Three things together keep that from happening again:
 *
 * 1. Each migration commits on its own (see `runner.ts`), so a lock one
 *    migration takes is released when THAT migration ends, not when the last
 *    one in the batch does.
 * 2. `lock_timeout`: a statement that cannot get its lock within a few seconds
 *    gives up instead of waiting. While an ACCESS EXCLUSIVE request waits, every
 *    later reader of the table queues behind it too — the wait itself is an
 *    outage — so a short wait and a later retry is far cheaper than a long one.
 * 3. `statement_timeout`: a statement that runs long while holding locks is
 *    stopped. A migration that genuinely needs longer (a large backfill)
 *    declares it, in its own file, on one line:
 *
 *        -- oxy:statement-timeout=600s
 *
 * A lock timeout (or a deadlock) rolls the migration's transaction back
 * completely, so it is retried from the top with exponential backoff and full
 * jitter. A statement timeout is not retried: the budget would not be larger
 * the second time.
 *
 * Like `phases.ts`, the marker reader imports nothing but Node builtins, so a CI
 * gate can use the REAL reader rather than a second copy of the regex.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEADLOCK_DETECTED, sqlStateOf } from '../pgErrors';

/** Postgres `lock_not_available` — what `lock_timeout` expiring raises. */
export const LOCK_NOT_AVAILABLE = '55P03';

/**
 * How long one statement may wait for a lock. Every reader that arrives while
 * an ACCESS EXCLUSIVE request is waiting queues behind it, so this is also the
 * longest a migration's lock WAIT can stall a hot table's readers.
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 3_000;

/**
 * How long one statement may run unless its migration declares otherwise.
 * Generous for DDL and small backfills; a migration that needs more says so
 * with {@link statementTimeoutMarkerLine}.
 */
export const DEFAULT_STATEMENT_TIMEOUT_MS = 120_000;

/** The ceiling a migration's own marker may raise its statement timeout to. */
export const MAX_STATEMENT_TIMEOUT_SECONDS = 3_600;

/** Attempts per migration (the first one included) before a lock timeout is fatal. */
export const DEFAULT_LOCK_ATTEMPTS = 8;

/** First backoff ceiling; doubles per attempt up to {@link DEFAULT_LOCK_RETRY_MAX_DELAY_MS}. */
export const DEFAULT_LOCK_RETRY_BASE_DELAY_MS = 1_000;

/** Backoff ceiling for one wait between attempts. */
export const DEFAULT_LOCK_RETRY_MAX_DELAY_MS = 30_000;

/** The one accepted spelling of a statement-timeout marker. */
export function statementTimeoutMarkerLine(seconds: number): string {
  return `-- oxy:statement-timeout=${seconds}s`;
}

/** Value left unconstrained so a malformed one is reported, not ignored. */
const MARKER_LINE = /^-- oxy:statement-timeout=(.*)$/;
const MARKER_VALUE = /^([1-9][0-9]*)s$/;

/** What `readMigrationStatementTimeouts` found, and what it could not read. */
export interface MigrationTimeoutReadResult {
  /** Tag -> declared statement timeout in ms, only for migrations that declare one. */
  statementTimeoutsMs: Map<string, number>;
  /** Human-readable problems. Empty means every marker present was legible. */
  problems: string[];
}

/**
 * Read the optional statement-timeout marker out of each migration file.
 * Absent is fine (the default applies); more than one, or an illegible value,
 * is a problem.
 */
export function readMigrationStatementTimeouts(
  tags: readonly string[],
  folder: string,
): MigrationTimeoutReadResult {
  const statementTimeoutsMs = new Map<string, number>();
  const problems: string[] = [];

  for (const tag of tags) {
    let contents: string;
    try {
      contents = readFileSync(join(folder, `${tag}.sql`), 'utf8');
    } catch {
      // `readMigrationPhases` already reports an unreadable file; one report is enough.
      continue;
    }

    const values: string[] = [];
    for (const line of contents.split('\n')) {
      const match = MARKER_LINE.exec(line.replace(/\r$/, ''));
      if (match) values.push(match[1]);
    }
    if (values.length === 0) continue;
    if (values.length > 1) {
      problems.push(`${tag}: ${values.length} statement-timeout markers; at most one.`);
      continue;
    }

    const parsed = MARKER_VALUE.exec(values[0]);
    const seconds = parsed ? Number(parsed[1]) : Number.NaN;
    if (!Number.isSafeInteger(seconds) || seconds > MAX_STATEMENT_TIMEOUT_SECONDS) {
      problems.push(
        `${tag}: unrecognised statement timeout "${values[0]}". Write ` +
          `\`${statementTimeoutMarkerLine(600)}\` — whole seconds, at most ${MAX_STATEMENT_TIMEOUT_SECONDS}.`,
      );
      continue;
    }
    statementTimeoutsMs.set(tag, seconds * 1000);
  }

  return { statementTimeoutsMs, problems };
}

/**
 * Whether `error` is lock contention a fresh attempt can resolve: the lock
 * wait timed out, or Postgres broke a deadlock. Both roll the whole migration
 * transaction back, so the retry restarts the migration, never a statement.
 */
export function isLockContention(error: unknown): boolean {
  const state = sqlStateOf(error);
  return state === LOCK_NOT_AVAILABLE || state === DEADLOCK_DETECTED;
}

/**
 * The wait before retry number `attempt` (1-based): full jitter over an
 * exponentially growing ceiling, so several migrators (every Oxy app shares one
 * database) retrying the same contended table do not retry in lockstep.
 */
export function lockRetryDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * ceiling);
}
