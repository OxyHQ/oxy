/**
 * The CI gate that keeps a drizzle migrations folder applyable: the journal,
 * the SQL files and the snapshots agree, and every new entry is newer than the
 * one before it.
 *
 * Two branches that each add a migration from the same base both take the next
 * number and a `when` from the moment they were generated. Git merges the two
 * journals without a conflict when the second branch is rebased by hand, and
 * what lands is a folder the migrator walks wrongly:
 *
 *   - a `when` older than the entry before it is skipped in silence on every
 *     database that applied the newer one (drizzle applies only entries newer
 *     than the newest recorded; `ledger.ts` explains, and `planLedgerRun`
 *     refuses at deploy, after the image is built);
 *   - two files with one number, or a snapshot whose `prevId` is not the
 *     newest snapshot before it, make the next `drizzle-kit generate` diff against the
 *     wrong schema.
 *
 * This finds all of it in the pull request. `oxy-db-rebase-migrations` fixes
 * it. Entries at or below the app's baseline (`after`) are history and are
 * not held to the rules; the first checked entry is compared with the last
 * baseline one.
 *
 * Imports nothing but Node builtins, so a gate can run it before `bun install`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

interface RawJournalEntry {
  idx?: unknown;
  tag?: unknown;
  when?: unknown;
}

/** The number a migration tag starts with (`0113_foo` → 113), or NaN. */
export function migrationNumber(tag: string): number {
  const match = /^(\d+)_/.exec(tag);
  return match ? Number.parseInt(match[1], 10) : Number.NaN;
}

/** The snapshot file drizzle-kit writes for a tag: `meta/<prefix>_snapshot.json`. */
export function snapshotFileFor(tag: string): string {
  return `${tag.slice(0, tag.indexOf('_'))}_snapshot.json`;
}

function readSnapshotIds(
  path: string,
): { id: string; prevId: string } | { error: string } | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { id?: unknown; prevId?: unknown };
    if (typeof parsed.id !== 'string' || typeof parsed.prevId !== 'string') {
      return { error: 'has no string `id`/`prevId`' };
    }
    return { id: parsed.id, prevId: parsed.prevId };
  } catch (error) {
    return { error: `cannot be parsed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Problems in a drizzle folder's journal, files and snapshot chain; empty when
 * it is sound. `after` is the app's baseline migration number (`-1` checks
 * everything). Throws only when the journal cannot be read.
 */
export function migrationJournalProblems(folder: string, after: number): string[] {
  const journalPath = join(folder, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries?: unknown };
  if (!Array.isArray(journal.entries)) {
    throw new Error(`${journalPath} has no \`entries\` array.`);
  }
  const entries = journal.entries as RawJournalEntry[];
  const problems: string[] = [];
  const rebaseHint =
    "Rebase the branch's migrations onto main: `oxy-db-rebase-migrations --onto=origin/main`.";

  const tags = new Set<string>();
  let previous: { tag: string; when: number } | undefined;
  let previousSnapshotId: string | undefined;

  entries.forEach((entry, position) => {
    const tag = typeof entry.tag === 'string' ? entry.tag : '';
    const number = migrationNumber(tag);
    const checked = !(Number.isSafeInteger(number) && number <= after);

    if (!tag || !Number.isSafeInteger(number)) {
      problems.push(
        `entries[${position}]: tag ${JSON.stringify(entry.tag)} is not <number>_<name>.`,
      );
      return;
    }
    if (tags.has(tag)) problems.push(`${tag}: listed twice in the journal.`);
    tags.add(tag);

    const when = typeof entry.when === 'number' ? entry.when : Number.NaN;
    const snapshotPath = join(folder, 'meta', snapshotFileFor(tag));
    const snapshot = readSnapshotIds(snapshotPath);

    if (checked) {
      if (entry.idx !== position) {
        problems.push(`${tag}: idx is ${JSON.stringify(entry.idx)}, its position is ${position}.`);
      }
      if (number !== position) {
        problems.push(
          `${tag}: number ${number} is not its journal position ${position} (a number taken twice, or a gap). ${rebaseHint}`,
        );
      }
      if (!Number.isFinite(when)) {
        problems.push(`${tag}: \`when\` is not a number.`);
      } else if (previous && when <= previous.when) {
        problems.push(
          `${tag}: when=${when} is not newer than ${previous.tag} (when=${previous.when}), so every database that applied ${previous.tag} skips it in silence. ${rebaseHint}`,
        );
      }
      if (!existsSync(join(folder, `${tag}.sql`))) {
        problems.push(`${tag}: listed in the journal but ${tag}.sql is missing.`);
      }
      // A hand-written migration (a seed, a backfill) may have no snapshot;
      // drizzle-kit diffs against the newest one there is.
      if (snapshot !== undefined && 'error' in snapshot) {
        problems.push(`${tag}: meta/${snapshotFileFor(tag)} ${snapshot.error}.`);
      } else if (
        snapshot !== undefined &&
        previousSnapshotId !== undefined &&
        snapshot.prevId !== previousSnapshotId
      ) {
        problems.push(
          `${tag}: its snapshot's prevId is ${snapshot.prevId}, not the previous snapshot's id ${previousSnapshotId}; the next drizzle-kit generate would diff against the wrong schema. ${rebaseHint}`,
        );
      }
    }

    if (Number.isFinite(when)) previous = { tag, when };
    if (snapshot !== undefined) {
      previousSnapshotId = 'error' in snapshot ? undefined : snapshot.id;
    }
  });

  for (const file of readdirSync(folder)) {
    if (!file.endsWith('.sql')) continue;
    const tag = file.slice(0, -'.sql'.length);
    const number = migrationNumber(tag);
    if (Number.isSafeInteger(number) && number > after && !tags.has(tag)) {
      problems.push(`${file}: not in the journal, so it never runs.`);
    }
  }
  return problems;
}
