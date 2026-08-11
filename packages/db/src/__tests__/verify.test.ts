/**
 * `verify.ts` without a database.
 *
 * The load-bearing test here is `agrees with drizzle's own readMigrationFiles`.
 * Everything else checks this package's own logic against itself; that one
 * checks the ONE thing `verify.ts` reimplements from another package, and it is
 * the layer that runs in CI (the live counterpart needs Postgres and skips).
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import {
  type AppliedMigrationRow,
  type JournalEntryWithHash,
  compareLedger,
  formatLedgerComparison,
  readJournalWithHashes,
} from '../migrate/verify';

/** A migrations folder on disk, shaped exactly as drizzle-kit emits one. */
function writeMigrationsFolder(files: { tag: string; when: number; sql: string }[]): string {
  const folder = mkdtempSync(join(tmpdir(), 'oxydb-verify-'));
  mkdirSync(join(folder, 'meta'));
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: files.map((file, idx) => ({
        idx,
        version: '7',
        when: file.when,
        tag: file.tag,
        breakpoints: true,
      })),
    })
  );
  for (const file of files) writeFileSync(join(folder, `${file.tag}.sql`), file.sql);
  return folder;
}

const FIXTURE = [
  {
    tag: '0000_first',
    when: 1_700_000_000_000,
    sql: '-- oxy:deploy-phase=pre\nCREATE TABLE "a" ("id" text PRIMARY KEY);',
  },
  {
    tag: '0001_second',
    when: 1_700_000_001_000,
    sql: '-- oxy:deploy-phase=pre\nCREATE TABLE "b" ("id" text PRIMARY KEY);',
  },
];

describe('readJournalWithHashes', () => {
  let folder: string;
  beforeAll(() => {
    folder = writeMigrationsFolder(FIXTURE);
  });
  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('carries the journal `when` through unchanged', () => {
    expect(readJournalWithHashes(folder).map((e) => [e.tag, e.when])).toEqual([
      ['0000_first', 1_700_000_000_000],
      ['0001_second', 1_700_000_001_000],
    ]);
  });

  /**
   * THE COUPLING TEST. `verify.ts` reimplements drizzle's content hash; this
   * asserts the reimplementation still agrees with drizzle itself, on a folder
   * both read. A drizzle release that changed the algorithm fails here — which
   * is the only place it would be caught before the second key silently became
   * a permanent false mismatch (or, worse, a vacuous match).
   *
   * If this goes red after a drizzle upgrade, follow drizzle's new algorithm in
   * `verify.ts`. Never delete this assertion.
   */
  it("agrees with drizzle's own readMigrationFiles on every entry", () => {
    const ours = readJournalWithHashes(folder);
    const theirs = readMigrationFiles({ migrationsFolder: folder });

    // Positive control: if drizzle read nothing, "every hash agrees" would be
    // vacuously true over an empty zip.
    expect(theirs).toHaveLength(FIXTURE.length);
    expect(ours).toHaveLength(FIXTURE.length);

    const theirsByMillis = new Map(theirs.map((m) => [m.folderMillis, m.hash]));
    for (const entry of ours) {
      expect(theirsByMillis.get(entry.when)).toBe(entry.hash);
    }
  });

  it('hashes the raw bytes, so two files differing by one byte differ', () => {
    const other = writeMigrationsFolder([{ ...FIXTURE[0], sql: `${FIXTURE[0].sql} ` }]);
    try {
      expect(readJournalWithHashes(other)[0].hash).not.toBe(readJournalWithHashes(folder)[0].hash);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('throws when the journal names a .sql that is not there', () => {
    const partial = mkdtempSync(join(tmpdir(), 'oxydb-verify-partial-'));
    mkdirSync(join(partial, 'meta'));
    writeFileSync(
      join(partial, 'meta', '_journal.json'),
      JSON.stringify({ entries: [{ idx: 0, when: 1, tag: '0000_absent' }] })
    );
    try {
      expect(() => readJournalWithHashes(partial)).toThrow(/0000_absent/);
    } finally {
      rmSync(partial, { recursive: true, force: true });
    }
  });
});

describe('compareLedger', () => {
  const entries: JournalEntryWithHash[] = [
    { tag: '0000_first', when: 100, hash: 'aaa' },
    { tag: '0001_second', when: 200, hash: 'bbb' },
  ];
  const rows: AppliedMigrationRow[] = [
    { whenMillis: 100, hash: 'aaa' },
    { whenMillis: 200, hash: 'bbb' },
  ];

  it('reports a fully-applied ledger as three empty residuals with non-zero counts', () => {
    const result = compareLedger(entries, rows);
    expect(result).toMatchObject({
      journalCount: 2,
      ledgerCount: 2,
      unapplied: [],
      unknownToJournal: [],
      hashMismatches: [],
    });
  });

  /**
   * The three-way mutation. Each case moves a DIFFERENT counter, because a
   * control that exercises one of them says nothing about the other two — the
   * first version of this check moved only the second residual and would have
   * passed against a comparator blind to the other two.
   */
  it('moves `unapplied` when a ledger row is missing', () => {
    const result = compareLedger(entries, [rows[0]]);
    expect(result.unapplied.map((e) => e.tag)).toEqual(['0001_second']);
    expect(result.unknownToJournal).toEqual([]);
    expect(result.hashMismatches).toEqual([]);
  });

  it('moves `unknownToJournal` when the ledger holds a row the journal lost', () => {
    const result = compareLedger(entries, [...rows, { whenMillis: 999, hash: 'zzz' }]);
    expect(result.unknownToJournal).toEqual([{ whenMillis: 999, hash: 'zzz' }]);
    expect(result.unapplied).toEqual([]);
    expect(result.hashMismatches).toEqual([]);
  });

  it('moves `hashMismatches` when the timestamps match and the content does not', () => {
    const result = compareLedger(entries, [rows[0], { whenMillis: 200, hash: 'CORRUPT' }]);
    expect(result.hashMismatches).toEqual([
      { tag: '0001_second', whenMillis: 200, journalHash: 'bbb', ledgerHash: 'CORRUPT' },
    ]);
    // Reported ONLY as a mismatch: a row that matched on `when` is present, so
    // calling it unapplied as well would describe two findings where there is one.
    expect(result.unapplied).toEqual([]);
    expect(result.unknownToJournal).toEqual([]);
  });

  it('is vacuously clean on two empty inputs, which is why the counts are returned', () => {
    const result = compareLedger([], []);
    expect(result.unapplied).toEqual([]);
    expect(result.unknownToJournal).toEqual([]);
    expect(result.hashMismatches).toEqual([]);
    // The residuals cannot distinguish this from a correct comparison. The
    // counts can, and are the floor a caller is expected to gate on.
    expect(result.journalCount).toBe(0);
    expect(result.ledgerCount).toBe(0);
  });

  it('reports every journal entry as unapplied against a database never migrated', () => {
    expect(compareLedger(entries, []).unapplied).toHaveLength(2);
  });
});

describe('formatLedgerComparison', () => {
  it('prints both residuals and both counts even when everything is empty', () => {
    const text = formatLedgerComparison(compareLedger([], []));
    expect(text).toContain('journal entries : 0');
    expect(text).toContain('ledger rows     : 0');
    expect(text).toContain('UNAPPLIED (in journal, not in ledger): 0');
    expect(text).toContain('UNKNOWN TO JOURNAL (in ledger, not in journal): 0');
    expect(text).toContain('HASH MISMATCHES on matched rows: 0');
    expect(text).toContain('(none)');
  });

  it('names the unapplied migrations', () => {
    const text = formatLedgerComparison(
      compareLedger([{ tag: '0007_late', when: 7, hash: 'h' }], [])
    );
    expect(text).toContain('UNAPPLIED (in journal, not in ledger): 1');
    expect(text).toContain('0007_late');
  });
});
