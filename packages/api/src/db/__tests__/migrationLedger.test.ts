/**
 * The migration journal reader and the pending calculation, plus the ledger read
 * against a REAL Postgres.
 *
 * Two things are worth pinning here. First, `pendingEntries` must answer the
 * SAME question drizzle's own migrator asks, or the dry run in
 * `.github/workflows/run-postgres-migrations.yml` would advertise a plan the
 * apply does not follow. Second, an unreadable journal must THROW: an image
 * shipped without `drizzle/` would otherwise report a clean, successful no-op
 * run while applying nothing at all.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import {
  MIGRATIONS_SCHEMA,
  MIGRATIONS_TABLE,
  pendingEntries,
  readJournal,
  readLastAppliedMillis,
} from '@oxyhq/db/migrate';
import { MIGRATIONS_FOLDER } from '../migrationsFolder';

/** Write a `drizzle/meta/_journal.json` into a throwaway directory. */
function journalFolder(contents: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'oxy-journal-'));
  mkdirSync(join(folder, 'meta'), { recursive: true });
  writeFileSync(join(folder, 'meta', '_journal.json'), contents);
  return folder;
}

const throwawayFolders: string[] = [];

afterAll(() => {
  for (const folder of throwawayFolders) rmSync(folder, { recursive: true, force: true });
});

describe('readJournal', () => {
  it('reads the real journal that ships with the package', () => {
    const entries = readJournal(MIGRATIONS_FOLDER);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(typeof entry.tag).toBe('string');
      expect(typeof entry.when).toBe('number');
    }
  });

  it('throws when the journal is missing — never reports "nothing to do"', () => {
    expect(() => readJournal(join(tmpdir(), 'oxy-journal-does-not-exist'))).toThrow(/Cannot read/);
  });

  it('returns [] for a journal that parses with a genuinely empty entries array', () => {
    // A parsed journal saying "zero entries" is a successful read, not the
    // failure this module's guard exists to catch — that failure is a
    // journal that is missing, unparseable, or structurally wrong (see the
    // cases below). Conflating the two would refuse a legitimate run for a
    // project with no migrations yet.
    const folder = journalFolder(JSON.stringify({ version: '7', dialect: 'postgresql', entries: [] }));
    throwawayFolders.push(folder);
    expect(readJournal(folder)).toEqual([]);
  });

  it('throws on entries missing the fields the pending calculation needs', () => {
    const folder = journalFolder(JSON.stringify({ entries: [{ tag: '0000_x' }] }));
    throwawayFolders.push(folder);
    expect(() => readJournal(folder)).toThrow(/entries\[0\] is missing/);
  });

  it('throws on an unparseable journal rather than treating it as empty', () => {
    const folder = journalFolder('{ not json');
    throwawayFolders.push(folder);
    expect(() => readJournal(folder)).toThrow(/Cannot read/);
  });
});

describe('pendingEntries', () => {
  const entries = [
    { tag: '0000_first', when: 100 },
    { tag: '0001_second', when: 200 },
    { tag: '0002_third', when: 300 },
  ];

  it('treats an absent ledger as "everything is pending"', () => {
    expect(pendingEntries(entries, null).map((entry) => entry.tag)).toEqual([
      '0000_first',
      '0001_second',
      '0002_third',
    ]);
  });

  it('returns only entries strictly newer than the newest recorded one', () => {
    expect(pendingEntries(entries, 200).map((entry) => entry.tag)).toEqual(['0002_third']);
  });

  it('is empty once the newest entry is recorded', () => {
    expect(pendingEntries(entries, 300)).toEqual([]);
  });

  it('does not mutate the journal it was handed', () => {
    const original = [...entries];
    pendingEntries(entries, null).pop();
    expect(entries).toEqual(original);
  });
});

describe('readLastAppliedMillis', () => {
  /** Seconds the throwaway admin connection waits before closing. */
  const CLOSE_TIMEOUT_SECONDS = 5;
  let client: postgres.Sql;

  beforeAll(() => {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is unset; the jest harness should have published it.');
    client = postgres(url, { max: 1 });
  });

  afterAll(async () => {
    await client.end({ timeout: CLOSE_TIMEOUT_SECONDS });
  });

  it('finds the ledger drizzle itself wrote', async () => {
    const [row] = await client<{ present: boolean }[]>`
      select to_regclass(${`${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}`}) is not null as present
    `;
    expect(row?.present).toBe(true);
  });

  it('reports the newest applied migration of the migrated test database', async () => {
    // The jest harness builds this database by shelling out to `bun run
    // db:migrate`, so this is the end-to-end proof that the migrator ran and
    // recorded itself where the pending calculation reads.
    const lastApplied = await readLastAppliedMillis(client);
    const journal = readJournal(MIGRATIONS_FOLDER);

    expect(lastApplied).toBe(Math.max(...journal.map((entry) => entry.when)));
    expect(pendingEntries(journal, lastApplied)).toEqual([]);
  });
});
