/**
 * Verifying, by IDENTITY, which migrations a database has actually applied.
 *
 * ## This is a DIFFERENT question from what gets applied
 *
 * `pendingEntries` in `ledger.ts` remains the ONLY authority on what a run
 * applies, and this module must never become the input to that decision. That
 * rule is a high-water filter — drizzle applies a migration when its journal
 * timestamp is strictly newer than the newest recorded one — while this module
 * asks a set question: which journal entries have no ledger row, and which
 * ledger rows have no journal entry. The two disagree on exactly the input
 * `unreachableEntries` already names, and that disagreement is the point of
 * both functions. A report that answered a different question than the apply
 * path does would eventually contradict it, and `ledger.ts` says plainly why
 * that is worse than no report at all. Do not "unify" them.
 *
 * ## Why the hash, when `ledger.ts` deliberately declines it
 *
 * `readAppliedMillis` keys on `created_at` alone, and its docblock states the
 * reason: the timestamp is the value the apply rule itself compares, and it is
 * the only one derivable from the journal without reimplementing drizzle's
 * hashing. That reasoning is correct FOR THE APPLY PATH and this module does
 * not disturb it.
 *
 * Verification has a different requirement. Two counts agreeing is not
 * identity: "seven ledger rows, seven journal entries" reads exactly like a
 * ledger carrying seven rows from a superseded journal, and a timestamp-only
 * comparison cannot tell those apart. Two independent keys agreeing on every
 * row can. So this module DOES reimplement drizzle's content hash —
 * `sha256` over the raw bytes of each `.sql`, matching
 * `drizzle-orm/migrator`'s `readMigrationFiles` — and that coupling is stated
 * here rather than inherited silently.
 *
 * The coupling is pinned in two places, because a drizzle change that altered
 * the algorithm would otherwise turn the second key into either a permanent
 * false mismatch or a vacuous match, and BOTH look like this tool working:
 *
 * - `__tests__/verify.test.ts` asserts {@link readJournalWithHashes} agrees
 *   with drizzle's own `readMigrationFiles` on the same folder. No database,
 *   so it runs everywhere this package's suite runs — it is the layer that
 *   catches a drizzle bump.
 * - `__tests__/verify.live.test.ts` asserts the hash a real `migrate()` WRITES
 *   to a real ledger equals the one computed here, which is the only claim the
 *   first test cannot make. It needs Postgres and skips without it.
 *
 * If the first test ever fails after a drizzle upgrade, the fix is to follow
 * drizzle's new algorithm here — never to delete the assertion.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';
import { MIGRATIONS_SCHEMA, MIGRATIONS_TABLE, type JournalEntry, readJournal } from './ledger';

/**
 * One journal entry plus the content hash drizzle would record for it.
 *
 * `when` is carried through unchanged from the journal so the primary key of
 * the comparison stays the value the apply rule compares.
 */
export interface JournalEntryWithHash extends JournalEntry {
  /** `sha256` of the migration file's raw bytes, hex-encoded. */
  readonly hash: string;
}

/**
 * One ledger row's identity: the two independently-derived keys, and nothing
 * else. `id` is deliberately absent — it is a serial assigned by insertion
 * order and says nothing about WHICH migration a row records.
 */
export interface AppliedMigrationRow {
  readonly hash: string;
  /** The row's `created_at`, which drizzle writes from the journal's `when`. */
  readonly whenMillis: number;
}

/** A ledger row and journal entry that agree on `when` and disagree on `hash`. */
export interface LedgerHashMismatch {
  readonly tag: string;
  readonly whenMillis: number;
  readonly journalHash: string;
  readonly ledgerHash: string;
}

/**
 * The full answer, with both residuals ALWAYS present — empty arrays rather
 * than omitted keys.
 *
 * `journalCount` and `ledgerCount` are returned rather than left for the
 * caller to recompute because they are the vacuity floor: every residual here
 * is empty when the comparison is correct AND when it read nothing at all, and
 * the counts are what separate those. A caller gating on this must assert both
 * are non-zero; {@link formatLedgerComparison} always prints them.
 */
export interface LedgerComparison {
  readonly journalCount: number;
  readonly ledgerCount: number;
  /** In the journal, with no ledger row. The dangerous direction. */
  readonly unapplied: readonly JournalEntryWithHash[];
  /** In the ledger, with no journal entry — applied then deleted or renamed. */
  readonly unknownToJournal: readonly AppliedMigrationRow[];
  /** Matched on `when`, disagreeing on content. */
  readonly hashMismatches: readonly LedgerHashMismatch[];
}

/**
 * The journal, with each entry's content hash computed from its `.sql`.
 *
 * Reads the file as BYTES and hashes those bytes. Decoding to a string first
 * would make the result depend on this process's decoding of any invalid byte
 * sequence, which is not something drizzle's own hash depends on.
 *
 * @throws {Error} When the journal is missing or malformed (via
 *   {@link readJournal}), or when a `.sql` named by the journal is absent —
 *   the latter loudly, because a journal entry with no file is exactly the
 *   state a half-finished rebase leaves behind, and answering "no hash" for it
 *   would let this report call that database current.
 */
export function readJournalWithHashes(folder: string): JournalEntryWithHash[] {
  return readJournal(folder).map((entry) => {
    const path = join(folder, `${entry.tag}.sql`);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      throw new Error(
        `Migration journal lists ${entry.tag} but ${path} cannot be read: \
${error instanceof Error ? error.message : String(error)}. A journal entry \
without its .sql is a half-applied rename or an interrupted rebase, not a \
migration that can be verified.`
      );
    }
    return { ...entry, hash: createHash('sha256').update(bytes).digest('hex') };
  });
}

/**
 * Every ledger row's two identity keys, or `[]` when the ledger table does not
 * exist yet.
 *
 * The absent table and the empty table collapse here exactly as they do in
 * `readAppliedMillis`, for the same reason: both mean "no migration is
 * recorded". Rows with a NULL `created_at` are DROPPED rather than coerced,
 * also matching `readAppliedMillis` — `toAppliedMillis`'s docblock has the
 * argument, which is that `Number(null)` is `0` and would read as a migration
 * applied at the Unix epoch.
 *
 * Reads only.
 */
export async function readAppliedRows(client: postgres.Sql): Promise<AppliedMigrationRow[]> {
  const [ledger] = await client<{ present: boolean }[]>`
    select to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`}) is not null as present
  `;
  if (!ledger?.present) return [];

  const rows = await client<{ hash: string; created_at: string | null }[]>`
    select hash, created_at
    from ${client(MIGRATIONS_SCHEMA)}.${client(MIGRATIONS_TABLE)}
    order by created_at asc
  `;

  return rows
    .filter((row): row is { hash: string; created_at: string } => row.created_at !== null)
    .map((row) => ({ hash: row.hash, whenMillis: Number(row.created_at) }));
}

/**
 * Compare a journal against a ledger on both keys.
 *
 * Pure: no IO, so the residual logic can be mutation-tested without a database.
 *
 * Matching is on `whenMillis` — the apply rule's own key — with `hash` checked
 * as a second, independent key on every row that matched. A row whose hash
 * disagrees is reported as a mismatch rather than as both an unapplied entry
 * and an unknown row, because the two keys disagreeing about the SAME
 * migration is a different finding from a migration being absent.
 *
 * Two journal entries generated in the same millisecond would be
 * indistinguishable to the primary key, exactly as they are to the apply rule
 * (`unreachableEntries` notes the same collision). It is recorded rather than
 * guarded because the collision can only make this comparison MISS a
 * difference; it never invents one.
 */
export function compareLedger(
  entries: readonly JournalEntryWithHash[],
  rows: readonly AppliedMigrationRow[]
): LedgerComparison {
  const rowsByWhen = new Map(rows.map((row) => [row.whenMillis, row]));
  const entriesByWhen = new Map(entries.map((entry) => [entry.when, entry]));

  const unapplied = entries.filter((entry) => !rowsByWhen.has(entry.when));
  const unknownToJournal = rows.filter((row) => !entriesByWhen.has(row.whenMillis));

  const hashMismatches: LedgerHashMismatch[] = [];
  for (const entry of entries) {
    const row = rowsByWhen.get(entry.when);
    if (row && row.hash !== entry.hash) {
      hashMismatches.push({
        tag: entry.tag,
        whenMillis: entry.when,
        journalHash: entry.hash,
        ledgerHash: row.hash,
      });
    }
  }

  return {
    journalCount: entries.length,
    ledgerCount: rows.length,
    unapplied,
    unknownToJournal,
    hashMismatches,
  };
}

/**
 * Read both sides and compare them.
 *
 * Reads only — safe against production, which is the case this exists for.
 */
export async function verifyMigrationLedger(
  client: postgres.Sql,
  migrationsFolder: string
): Promise<LedgerComparison> {
  const entries = readJournalWithHashes(migrationsFolder);
  const rows = await readAppliedRows(client);
  return compareLedger(entries, rows);
}

/**
 * A fixed-shape report of a comparison.
 *
 * This exists so the reporting DISCIPLINE lives in one place rather than being
 * re-derived per caller: both residuals are printed even when empty, and both
 * set sizes are always printed. A caller that formatted only its non-empty
 * residuals would produce output in which "I found no differences" and "I
 * compared nothing" are the same text, which is the failure this whole module
 * is meant to make impossible.
 */
export function formatLedgerComparison(comparison: LedgerComparison): string {
  const lines = [
    `journal entries : ${comparison.journalCount}`,
    `ledger rows     : ${comparison.ledgerCount}`,
    '',
    `UNAPPLIED (in journal, not in ledger): ${comparison.unapplied.length}`,
    ...(comparison.unapplied.length === 0
      ? ['  (none)']
      : comparison.unapplied.map((entry) => `  ${entry.tag}  when=${entry.when}`)),
    '',
    `UNKNOWN TO JOURNAL (in ledger, not in journal): ${comparison.unknownToJournal.length}`,
    ...(comparison.unknownToJournal.length === 0
      ? ['  (none)']
      : comparison.unknownToJournal.map((row) => `  when=${row.whenMillis} hash=${row.hash}`)),
    '',
    `HASH MISMATCHES on matched rows: ${comparison.hashMismatches.length}`,
    ...(comparison.hashMismatches.length === 0
      ? ['  (none)']
      : comparison.hashMismatches.map(
          (m) => `  ${m.tag}\n    journal ${m.journalHash}\n    ledger  ${m.ledgerHash}`
        )),
  ];
  return lines.join('\n');
}
