/**
 * The migration journal on disk and the applied-migration ledger in the
 * database — the two things a migration runner compares to decide what is
 * pending.
 *
 * Split out from any entrypoint so this logic can be tested without importing
 * a module whose top level connects to a database and sets a non-zero exit
 * code.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';

/**
 * Where the applied-migration ledger lives. These are drizzle's own defaults,
 * restated as constants and passed EXPLICITLY to `migrate()` so the pending
 * report and the apply path can never read different tables.
 */
export const MIGRATIONS_SCHEMA = 'drizzle';
export const MIGRATIONS_TABLE = '__drizzle_migrations';

/** One `drizzle/meta/_journal.json` entry: a migration file and when it was generated. */
export interface JournalEntry {
  tag: string;
  when: number;
}

function isJournalEntry(value: unknown): value is JournalEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.tag === 'string' && typeof entry.when === 'number';
}

/**
 * What is structurally wrong with a parsed journal that failed validation —
 * named precisely enough that the thrown message says what was actually
 * wrong, rather than a single catch-all phrase covering every shape of
 * failure.
 */
function describeJournalStructureProblem(parsed: unknown): string {
  if (typeof parsed !== 'object' || parsed === null) {
    return `the parsed JSON is ${parsed === null ? 'null' : `a ${typeof parsed}`}, not an object`;
  }
  const entries = (parsed as Record<string, unknown>).entries;
  if (entries === undefined) {
    return 'the parsed JSON has no `entries` field';
  }
  if (!Array.isArray(entries)) {
    return `\`entries\` is a ${typeof entries}, not an array`;
  }
  const badIndex = entries.findIndex((entry) => !isJournalEntry(entry));
  return `entries[${badIndex}] is missing a string \`tag\` or a numeric \`when\``;
}

/**
 * The migration journal, in generation order.
 *
 * `folder` is a required argument rather than a discovered default: this
 * package ships no migration files of its own — those belong to whichever
 * application owns the drizzle schema — so there is no location this module
 * could search for on its own that would not risk resolving to the wrong
 * place once installed (a walk from this module's own file would resolve
 * inside `node_modules`, not the caller's `drizzle/` directory). The caller
 * states where its own migrations directory is.
 *
 * A successfully parsed journal whose `entries` array is EMPTY is not one of
 * the failures below — it is answered `[]`. That is the correct report for a
 * project that has wired its migrator before writing its first schema: the
 * file exists, parses, and says unambiguously "zero migrations." Refusing
 * that case would conflate it with the failure this function actually exists
 * to catch — a journal that is missing, unparseable, or structurally wrong,
 * where reporting "nothing to do" would be a silent lie about a migrator
 * pointed at the wrong (or missing) migrations directory.
 *
 * @throws {Error} When the journal file is missing or unparseable, or when it
 *   parses but its `entries` field is absent, not an array, or contains an
 *   entry without a readable `tag`/`when`. The message names which of these
 *   it was.
 */
export function readJournal(folder: string): JournalEntry[] {
  const path = join(folder, 'meta', '_journal.json');

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read the migration journal at ${path}: \
${error instanceof Error ? error.message : String(error)}. \
The migrations directory must be shipped next to the compiled migrator \
and its path passed to readJournal explicitly.`
    );
  }

  const entries =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>).entries
      : undefined;

  if (!Array.isArray(entries) || !entries.every(isJournalEntry)) {
    throw new Error(
      `The migration journal at ${path} does not have a usable \`entries\` \
array: ${describeJournalStructureProblem(parsed)}. The migrations directory \
must be shipped next to the compiled migrator and its path passed to \
readJournal explicitly.`
    );
  }

  // Reached only once `entries` is confirmed to be an array where every
  // element is a valid JournalEntry — including the zero-length case, which
  // is a genuine answer, not a read failure. See the doc comment above.
  return entries;
}

/**
 * Journal entries the ledger has not recorded.
 *
 * Mirrors drizzle's own rule exactly (`drizzle-orm/pg-core/dialect` `migrate`):
 * a migration runs when there is no ledger row at all, or when its journal
 * timestamp is strictly newer than the newest recorded one. Deliberately NOT a
 * per-hash set comparison — that would answer a different question than the
 * apply path does, and a report that disagrees with the action is worse than no
 * report.
 */
export function pendingEntries(
  entries: JournalEntry[],
  lastAppliedMillis: number | null
): JournalEntry[] {
  if (lastAppliedMillis === null) return [...entries];
  return entries.filter((entry) => lastAppliedMillis < entry.when);
}

/**
 * A journal entry the high-water rule can never reach.
 *
 * Thrown by {@link planLedgerRun} instead of being reported, because the whole
 * defect is that the condition is currently INVISIBLE: it presents as
 * `No pending Postgres migrations` and exit 0.
 */
export class UnreachableMigrationError extends Error {
  /** The entries that will never be applied, in journal order. */
  readonly entries: readonly JournalEntry[];

  constructor(entries: readonly JournalEntry[], highWaterMillis: number) {
    super(
      `${entries.length} migration(s) in this image can never be applied: \
${entries.map((entry) => `${entry.tag} (when=${entry.when})`).join(', ')}. \
The applied-migration ledger has reached ${highWaterMillis}, and both this \
migrator and drizzle-kit apply a migration only when its journal timestamp \
is strictly NEWER than the newest recorded one — so these are skipped in \
silence and the run reports success. This happens when a migration is \
generated on a branch that was created before another branch's migration \
landed. Fix it by regenerating the affected migration(s) so their \`when\` \
is newer than every applied one (rename the file and its \
drizzle/meta/_journal.json entry), NEVER by editing the ledger.`
    );
    this.name = 'UnreachableMigrationError';
    this.entries = entries;
  }
}

/**
 * The newest `created_at` in the ledger, or `null` when nothing is recorded.
 *
 * Split from {@link readAppliedMillis} so the high-water rule has ONE
 * definition: `pendingEntries` and `unreachableEntries` both key off this, and
 * `Math.max` over an empty list returning `-Infinity` is exactly the sort of
 * silent wrong answer this file exists to refuse.
 */
export function highWaterMillis(appliedMillis: readonly number[]): number | null {
  return appliedMillis.length === 0 ? null : Math.max(...appliedMillis);
}

/**
 * Journal entries that are NOT recorded in the ledger and sit at or below its
 * high-water mark — the ones the apply rule steps over without a word.
 *
 * ## Why this is a separate question from `pendingEntries`
 *
 * `pendingEntries` mirrors the APPLY rule, and must keep doing so (see its own
 * docblock). But that rule is a high-water filter rather than a set difference,
 * so the two disagree on exactly one input: an entry the ledger has never
 * recorded whose `when` is not newer than the newest recorded one. `pendingEntries`
 * says "not pending" — truthfully, since it will never be applied — and the
 * migrator therefore reports a clean run over a migration that did not happen.
 *
 * This function names that set. It does not change what gets applied; it makes
 * the difference between the two rules SAYABLE, which is the whole defect.
 *
 * ## This shape is easy to introduce and easy to miss
 *
 * A migration generated on a long-lived branch can carry a `when` timestamp
 * older than another branch's migration that merges — and is applied —
 * elsewhere first. On a database migrated from empty this is invisible: drizzle
 * reads the ledger ONCE before its loop, so `!lastDbMigration` holds for every
 * entry in that run and the whole journal applies regardless of order. It only
 * strands a migration on a database that had already progressed partway through
 * the journal when the branch merged. Reading the journal top to bottom does
 * not reveal the hazard either: the stranding entry can sit several entries
 * before the one that strands it.
 *
 * ## Identity is the timestamp, not the hash
 *
 * The ledger stores drizzle's own content hash and `created_at`; only the second
 * is derivable from the journal without reimplementing drizzle's hashing, and it
 * is the value the apply rule itself compares. Two migrations generated in the
 * same millisecond would be indistinguishable here — noted rather than guarded,
 * because the collision makes this check MISS a skip (it never invents one).
 */
export function unreachableEntries(
  entries: JournalEntry[],
  appliedMillis: readonly number[]
): JournalEntry[] {
  const highWater = highWaterMillis(appliedMillis);
  // Nothing recorded: drizzle's `!lastDbMigration` branch applies the whole
  // journal regardless of order, so no entry is unreachable on a fresh database.
  if (highWater === null) return [];
  const applied = new Set(appliedMillis);
  // `<=` states the apply rule faithfully (drizzle applies when `lastApplied <
  // when`, so `when <= lastApplied` is skipped). It is EQUIVALENT to `<` here
  // and cannot be tested apart from it: `highWater` is `Math.max(appliedMillis)`
  // and is therefore always a member of `appliedMillis`, so `entry.when ===
  // highWater` implies `applied.has(entry.when)` and the second clause rejects
  // it either way. That is an argument, not a test result, and it cannot be
  // made into one: an assertion that the two operators agree passes for every
  // possible input, so it would prove nothing about this function — which is
  // why `src/__tests__/ledger.test.ts` checks THIS implementation against a
  // hand-written reference on random input instead. Kept as `<=` because it
  // says what the rule is; do not "fix" either direction expecting a behaviour
  // change.
  return entries.filter((entry) => entry.when <= highWater && !applied.has(entry.when));
}

/**
 * What this run should apply — or a refusal, when the journal holds an entry the
 * apply rule cannot reach.
 *
 * The check is INSIDE the function that produces the pending list, not beside
 * it, so a caller cannot obtain the plan without it having run. That is the
 * difference between a guard and a comment: removing this one means rewriting
 * the call site to ask a different function, rather than deleting a line.
 *
 * @throws {UnreachableMigrationError} When any journal entry sits at or below
 *   the ledger's high-water mark without a row of its own.
 */
export function planLedgerRun(
  entries: JournalEntry[],
  appliedMillis: readonly number[]
): JournalEntry[] {
  const unreachable = unreachableEntries(entries, appliedMillis);
  const highWater = highWaterMillis(appliedMillis);
  if (unreachable.length > 0 && highWater !== null) {
    throw new UnreachableMigrationError(unreachable, highWater);
  }
  return pendingEntries(entries, highWater);
}

/**
 * A row's `created_at`, coerced to the millisecond number every rule in this
 * file compares — dropping rows this package cannot make sense of rather than
 * guessing a value for them.
 *
 * Pulled out of {@link readAppliedMillis} and {@link readLastAppliedMillis} so
 * this coercion is ONE rule both round trips call, not two copies that could
 * drift: `readLastAppliedMillis` reduces to `toAppliedMillis(rows)[0] ?? null`
 * on the same query shape, and reusing the array version there means there is
 * only one place a future edit could get the NULL handling below wrong.
 *
 * Exported for direct unit testing, but NOT part of `@oxyhq/db/migrate`'s
 * public surface — `migrate/index.ts` does not re-export it, and the package
 * has no wildcard `exports` entry a consumer could reach it through. Its two
 * callers are in this file.
 *
 * Two things this collapses on purpose:
 *
 * - `bigint` arrives as a STRING from postgres.js, so every `created_at` must
 *   pass through `Number(...)` before it is comparable to anything numeric —
 *   returning the raw string would make every high-water comparison silently
 *   false (`'2000' < 3000` is `true`, but string-vs-number equality never is).
 * - A NULL `created_at` is DROPPED, never coerced: `Number(null)` is `0`,
 *   which reads as a row applied at the Unix epoch and would drag the whole
 *   ledger's high-water mark down to it — the exact way a migration that
 *   really did run would look, wrongly, like it never had.
 */
export function toAppliedMillis(rows: { created_at: string | null }[]): number[] {
  return rows
    .map((row) => row.created_at)
    .filter((value): value is string => value !== null)
    .map(Number);
}

/**
 * Every `created_at` the ledger has recorded, or `[]` when the ledger table does
 * not exist yet (a database no migration has ever touched).
 *
 * The empty array and the absent table collapse deliberately: both mean "no
 * migration is recorded", which is the one input on which every rule here agrees.
 *
 * Reads only — calling it against a fresh database creates nothing, which is
 * what lets the dry run stay genuinely read-only.
 */
export async function readAppliedMillis(client: postgres.Sql): Promise<number[]> {
  const [ledger] = await client<{ present: boolean }[]>`
    select to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`}) is not null as present
  `;
  if (!ledger?.present) return [];

  const rows = await client<{ created_at: string | null }[]>`
    select created_at
    from ${client(MIGRATIONS_SCHEMA)}.${client(MIGRATIONS_TABLE)}
  `;

  return toAppliedMillis(rows);
}

/**
 * The newest `created_at` in the ledger, or `null` when the ledger table does
 * not exist yet (a database no migration has ever touched).
 *
 * Reads only — calling it against a fresh database creates nothing, which is
 * what lets the dry run stay genuinely read-only.
 */
export async function readLastAppliedMillis(client: postgres.Sql): Promise<number | null> {
  const [ledger] = await client<{ present: boolean }[]>`
    select to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`}) is not null as present
  `;
  if (!ledger?.present) return null;

  const rows = await client<{ created_at: string | null }[]>`
    select created_at
    from ${client(MIGRATIONS_SCHEMA)}.${client(MIGRATIONS_TABLE)}
    order by created_at desc
    limit 1
  `;

  // A NULL row and an empty result set both mean "nothing usable" — the same
  // rule `toAppliedMillis` already states, so this asks it rather than
  // restating "undefined or null" separately.
  return toAppliedMillis(rows)[0] ?? null;
}

/**
 * Raised by {@link assertPostgresMigrationsCurrent} when the database is behind
 * the migrations shipped in this image.
 *
 * A named class rather than a bare `Error` because of WHERE this one is
 * thrown. Its two siblings here — {@link UnreachableMigrationError} and
 * `WrongMigrationTargetError` — abort a migration run, where any throw is
 * fatal and the message is read by a human. This one lands on a BOOT path that
 * has to decide something: refuse to listen, retry while the one-shot
 * finishes, report unhealthy but stay up. A caller distinguishing "schema is
 * behind" from any other startup failure could otherwise only match on the
 * message text, which is not a contract anything guarantees.
 */
export class MigrationsNotCurrentError extends Error {
  /** The journal entries with no ledger row, in journal order. */
  readonly pending: readonly JournalEntry[];

  constructor(pending: readonly JournalEntry[]) {
    super(
      `Postgres schema is not current: ${pending.length} migration(s) shipped in \
this image have not been applied: ${pending.map((entry) => entry.tag).join(', ')}. \
Apply them with the deployment migration one-shot before this task can \
serve traffic.`
    );
    this.name = 'MigrationsNotCurrentError';
    this.pending = pending;
  }
}

/**
 * Refuse to serve when the database is BEHIND the migrations in this image.
 *
 * The failure this exists to prevent lands after the point of no return. A
 * deploy that applies migrations in a one-shot task, then starts serving
 * tasks: if that one-shot did not run — or ran against the wrong database —
 * the serving tasks still start, still connect, still answer a health check,
 * and then fail every query against a schema that is not there. By then
 * traffic has already been routed to them. A task that cannot serve correctly
 * must not be able to say that it can, so this is meant to be checked during
 * boot, before a process starts listening.
 *
 * The comparison is `pendingEntries` — the SAME rule the migrator itself
 * applies, from the same journal and the same ledger table. A gate that asked a
 * different question than the apply path answers would eventually disagree with
 * it, and the disagreement would surface as a task that refuses to boot against
 * a database that is in fact current.
 *
 * The message NAMES the missing tags. "Schema is not current" sends whoever is
 * holding a frozen deploy to go and diff two things by hand; the tags tell them
 * immediately whether the one-shot never ran (all of them) or died partway
 * (some of them).
 *
 * @param entries The journal entries shipped in this image, typically
 *   `readJournal(folder)` for the caller's own migrations directory. Required,
 *   not defaulted: this package has no folder of its own to fall back to.
 * @throws {MigrationsNotCurrentError} When any journal entry has no ledger row.
 */
export async function assertPostgresMigrationsCurrent(
  client: postgres.Sql,
  entries: JournalEntry[]
): Promise<void> {
  const pending = pendingEntries(entries, await readLastAppliedMillis(client));
  if (pending.length === 0) return;

  throw new MigrationsNotCurrentError(pending);
}
