/**
 * Move a branch's migrations after the ones `main` gained since the branch was
 * cut: the fix for every problem `journalGate.ts` reports.
 *
 * Two branches cut from the same base both generate migration N. When one
 * lands, the other's N collides with it, its journal entry is older than
 * main's, and its snapshot diffs against a schema that no longer exists.
 * Fixing that by hand is six steps and each is easy to get subtly wrong; this
 * does all of them:
 *
 *   1. The migrations the branch added are the journal entries it has that the
 *      merge base with `onto` does not. Their SQL and snapshots are read from
 *      the branch ref, so a conflicted working tree does not matter.
 *   2. The folder is reset to `onto`'s, then each branch migration is written
 *      back under the next free number, its journal entry newer than the one
 *      before it and its snapshot's `prevId` chained to the previous snapshot.
 *   3. The LAST branch migration's snapshot is regenerated: its entry is held
 *      out, `drizzle-kit generate` diffs the merged schema against `onto`'s
 *      newest snapshot, the generated snapshot is kept and the hand-written
 *      SQL put back. Whether drizzle-kit's SQL matches it is reported, since a
 *      mismatch means the SQL does not do what the schema now says.
 *
 * Run it after `git merge <onto>` with the code conflicts resolved (during a
 * merge HEAD is still the branch tip), or on a branch already merged with
 * `onto`. The folder's tracked files are rewritten (untracked ones refuse the
 * run) and the result is staged; nothing is committed.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { migrationNumber, snapshotFileFor } from './journalGate';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
  [key: string]: unknown;
}

interface Journal {
  entries: JournalEntry[];
  [key: string]: unknown;
}

interface Snapshot {
  id: string;
  prevId: string;
  [key: string]: unknown;
}

export interface RebaseMigrationsOptions {
  /** The drizzle folder, absolute or relative to the working directory. */
  migrationsFolder: string;
  /** The ref the branch's migrations go after (e.g. `origin/main`). */
  onto: string;
  /** The ref holding the branch's migrations. Default `HEAD`. */
  branch?: string;
  /**
   * The command that runs `drizzle-kit generate` for this folder (`--name` is
   * appended). `null` skips regenerating the last snapshot.
   */
  generateCommand: string | null;
  /** Where progress goes. Default `console.log`. */
  log?: (line: string) => void;
}

export interface RebasedMigration {
  from: string;
  to: string;
  when: number;
}

export interface RebaseMigrationsResult {
  moved: RebasedMigration[];
  /**
   * For the last migration: `match` when drizzle-kit generated the same SQL,
   * `differs` when it did not (review it), `no-schema-change` when the
   * migration changes data only, `skipped` without a generate command.
   */
  generated: 'match' | 'differs' | 'no-schema-change' | 'skipped' | 'nothing-to-do';
}

const TEMP_NAME = 'oxy_rebase_tmp';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function gitShow(cwd: string, ref: string, path: string): string | undefined {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown, trailingNewline: boolean): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}${trailingNewline ? '\n' : ''}`);
}

function normalizeSql(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--') || line.includes('statement-breakpoint'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Renumber the branch's migrations after `onto`'s. See the module comment. */
export function rebaseMigrations(options: RebaseMigrationsOptions): RebaseMigrationsResult {
  const log = options.log ?? ((line: string) => console.log(line));
  const folder = resolve(options.migrationsFolder);
  const branch = options.branch ?? 'HEAD';
  const root = git(folder, ['rev-parse', '--show-toplevel']).trim();
  const rel = relative(root, folder).split('\\').join('/');
  const journalRel = `${rel}/meta/_journal.json`;

  const readJournalAt = (ref: string): Journal => {
    const raw = gitShow(root, ref, journalRel);
    if (raw === undefined) throw new Error(`${ref} has no ${journalRel}.`);
    return JSON.parse(raw) as Journal;
  };

  const ontoRaw = gitShow(root, options.onto, journalRel);
  if (ontoRaw === undefined) throw new Error(`${options.onto} has no ${journalRel}.`);
  const onto = JSON.parse(ontoRaw) as Journal;
  const ontoTags = new Set(onto.entries.map((entry) => entry.tag));
  const mergeBase = git(root, ['merge-base', options.onto, branch]).trim();
  const baseTags = new Set(readJournalAt(mergeBase).entries.map((entry) => entry.tag));
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '--', rel]).trim();
  if (untracked) {
    throw new Error(
      `Untracked files in ${rel} would be swept into the rebase; commit or move them first:\n${untracked}`,
    );
  }
  const branchEntries = readJournalAt(branch).entries.filter(
    (entry) => !baseTags.has(entry.tag) && !ontoTags.has(entry.tag),
  );
  if (branchEntries.length === 0) {
    log(`No migrations on ${branch} that ${options.onto} lacks — nothing to rebase.`);
    return { moved: [], generated: 'nothing-to-do' };
  }

  // Read everything the branch added before the folder is touched.
  const added = branchEntries.map((entry) => {
    const sql = gitShow(root, branch, `${rel}/${entry.tag}.sql`);
    if (sql === undefined) throw new Error(`${branch} has no ${rel}/${entry.tag}.sql.`);
    const snapshotRaw = gitShow(root, branch, `${rel}/meta/${snapshotFileFor(entry.tag)}`);
    return {
      entry,
      sql,
      snapshot: snapshotRaw === undefined ? undefined : (JSON.parse(snapshotRaw) as Snapshot),
    };
  });

  // Reset the folder to onto's: drop the branch's files, then check onto's out.
  for (const { entry } of added) {
    rmSync(join(folder, `${entry.tag}.sql`), { force: true });
    rmSync(join(folder, 'meta', snapshotFileFor(entry.tag)), { force: true });
  }
  git(root, ['checkout', options.onto, '--', rel]);

  const ontoSnapshotIds = new Set<string>();
  let previousSnapshotId: string | undefined;
  for (const entry of onto.entries) {
    const raw = gitShow(root, options.onto, `${rel}/meta/${snapshotFileFor(entry.tag)}`);
    if (raw === undefined) continue;
    const { id } = JSON.parse(raw) as Snapshot;
    ontoSnapshotIds.add(id);
    previousSnapshotId = id;
  }

  const last = onto.entries[onto.entries.length - 1];
  const width = last ? last.tag.indexOf('_') : 4;
  let number = last ? migrationNumber(last.tag) + 1 : 0;
  let previousWhen = last?.when ?? 0;
  const journal: Journal = { ...onto, entries: [...onto.entries] };
  const moved: RebasedMigration[] = [];
  const written: { tag: string; sql: string }[] = [];

  for (const { entry, sql, snapshot } of added) {
    const tag = `${String(number).padStart(width, '0')}${entry.tag.slice(entry.tag.indexOf('_'))}`;
    const when = Math.max(previousWhen + 1, entry.when);
    journal.entries.push({ ...entry, idx: journal.entries.length, when, tag });
    writeFileSync(join(folder, `${tag}.sql`), sql);
    if (snapshot) {
      const id = ontoSnapshotIds.has(snapshot.id) ? randomUUID() : snapshot.id;
      writeJson(
        join(folder, 'meta', snapshotFileFor(tag)),
        { ...snapshot, id, prevId: previousSnapshotId ?? snapshot.prevId },
        false,
      );
      previousSnapshotId = id;
    }
    moved.push({ from: entry.tag, to: tag, when });
    written.push({ tag, sql });
    log(`${entry.tag} → ${tag} (when=${when})`);
    previousWhen = when;
    number += 1;
  }

  const trailingNewline = ontoRaw.endsWith('\n');
  const journalPath = join(folder, 'meta', '_journal.json');
  writeJson(journalPath, journal, trailingNewline);

  let generated: RebaseMigrationsResult['generated'] = 'skipped';
  const target = written[written.length - 1];
  if (options.generateCommand !== null && target) {
    generated = regenerateLastSnapshot({
      folder,
      journal,
      journalPath,
      trailingNewline,
      target,
      command: options.generateCommand,
      log,
    });
  } else if (target) {
    log(
      `${target.tag}'s snapshot still describes the branch's old base; regenerate it ` +
        'before the next drizzle-kit generate.',
    );
  }

  git(root, ['add', '-A', '--', rel]);
  return { moved, generated };
}

function regenerateLastSnapshot(input: {
  folder: string;
  journal: Journal;
  journalPath: string;
  trailingNewline: boolean;
  target: { tag: string; sql: string };
  command: string;
  log: (line: string) => void;
}): RebaseMigrationsResult['generated'] {
  const { folder, journal, journalPath, trailingNewline, target, log } = input;
  const sqlPath = join(folder, `${target.tag}.sql`);
  const snapshotPath = join(folder, 'meta', snapshotFileFor(target.tag));

  // Hold the last migration out so drizzle-kit diffs the merged schema
  // against the newest snapshot before it.
  rmSync(sqlPath, { force: true });
  rmSync(snapshotPath, { force: true });
  writeJson(journalPath, { ...journal, entries: journal.entries.slice(0, -1) }, trailingNewline);

  log(`Regenerating ${target.tag}'s snapshot: ${input.command} --name ${TEMP_NAME}`);
  const run = spawnSync(`${input.command} --name ${TEMP_NAME}`, {
    shell: true,
    stdio: 'inherit',
  });

  const generatedFile = readdirSync(folder).find((file) => file.endsWith(`_${TEMP_NAME}.sql`));
  const generatedSql =
    generatedFile === undefined ? undefined : readFileSync(join(folder, generatedFile), 'utf8');
  if (generatedFile !== undefined) rmSync(join(folder, generatedFile));

  // Put the hand-written migration and the full journal back, whatever happened.
  writeFileSync(sqlPath, target.sql);
  writeJson(journalPath, journal, trailingNewline);

  if (run.status !== 0) {
    throw new Error(
      `${input.command} exited ${run.status ?? run.signal}; ${target.tag}'s snapshot was not regenerated.`,
    );
  }
  if (generatedSql === undefined) {
    if (existsSync(snapshotPath)) rmSync(snapshotPath);
    log(`${target.tag} changes no schema; it keeps no snapshot.`);
    return 'no-schema-change';
  }
  if (!existsSync(snapshotPath)) {
    throw new Error(
      `drizzle-kit wrote ${generatedFile} but no meta/${snapshotFileFor(target.tag)}.`,
    );
  }
  if (normalizeSql(generatedSql) === normalizeSql(target.sql)) {
    log(`${target.tag}: drizzle-kit generates the same SQL.`);
    return 'match';
  }
  log(
    `${target.tag}: drizzle-kit generates DIFFERENT SQL from the hand-written file (kept). ` +
      `Review it — this is what the merged schema implies:\n${generatedSql}`,
  );
  return 'differs';
}
