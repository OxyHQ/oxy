import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UnreachableMigrationError,
  highWaterMillis,
  pendingEntries,
  planLedgerRun,
  readJournal,
  toAppliedMillis,
  unreachableEntries,
  type JournalEntry,
} from '../migrate/ledger';

// Every directory `journalFixture` (or the one inline `mkdtempSync` call
// below) has created during the current test, removed in `afterEach` — a
// suite that never cleans these up leaves one behind per invocation, on
// every run, forever.
const createdFolders: string[] = [];

function journalFixture(entries: Array<{ tag: string; when: number }>): string {
  const folder = mkdtempSync(join(tmpdir(), 'oxydb-'));
  createdFolders.push(folder);
  mkdirSync(join(folder, 'meta'), { recursive: true });
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries })
  );
  return folder;
}

afterEach(() => {
  for (const folder of createdFolders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe('migration ledger', () => {
  it('reads the journal in order', () => {
    const folder = journalFixture([
      { tag: '0000_init', when: 1000 },
      { tag: '0001_next', when: 2000 },
    ]);
    expect(readJournal(folder).map((entry) => entry.tag)).toEqual(['0000_init', '0001_next']);
  });

  it('reports the high-water mark, not the count', () => {
    // The max sits in the MIDDLE of the input, so this fails against an
    // implementation that reads the first element, the last element, or the
    // minimum — any of which would be a plausible bug if a future change
    // assumed `appliedMillis` arrives pre-sorted or in insertion order (it does
    // not: `readAppliedMillis` selects with no ORDER BY).
    expect(highWaterMillis([1000, 3000, 2000])).toBe(3000);
  });

  it('reports null when nothing has been applied', () => {
    // `Math.max()` of nothing is `-Infinity`, which compares as "older than
    // every migration" and would make a fresh database look fully reachable by
    // accident rather than by rule — the distinction this test pins.
    expect(highWaterMillis([])).toBeNull();
  });

  it('refuses a journal that does not exist, rather than reporting no entries', () => {
    // The failure mode this whole module exists to prevent: a journal that
    // could not be read at all must never be mistaken for "nothing to do".
    expect(() => readJournal(join(tmpdir(), 'oxydb-does-not-exist'))).toThrow(/Cannot read/);
  });

  it('returns [] for a journal that parses with a genuinely empty entries array', () => {
    // This is NOT the failure the guard above exists to catch: the file
    // exists, parses, and says unambiguously "zero migrations" — the correct
    // state for a project that has wired its migrator before writing its
    // first schema. Conflating this with an unreadable journal is the exact
    // defect this test pins.
    const folder = journalFixture([]);
    expect(readJournal(folder)).toEqual([]);
  });

  it('refuses a journal whose entries field is missing entirely', () => {
    const folder = mkdtempSync(join(tmpdir(), 'oxydb-'));
    createdFolders.push(folder);
    mkdirSync(join(folder, 'meta'), { recursive: true });
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'postgresql' })
    );
    expect(() => readJournal(folder)).toThrow(/no `entries` field/);
  });

  it('refuses a journal whose entries field is not an array', () => {
    const folder = mkdtempSync(join(tmpdir(), 'oxydb-'));
    createdFolders.push(folder);
    mkdirSync(join(folder, 'meta'), { recursive: true });
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({ version: '7', dialect: 'postgresql', entries: 'not-an-array' })
    );
    expect(() => readJournal(folder)).toThrow(/entries` is a string, not an array/);
  });

  it('refuses a journal entry missing `tag` or `when`, naming the bad index', () => {
    const folder = mkdtempSync(join(tmpdir(), 'oxydb-'));
    createdFolders.push(folder);
    mkdirSync(join(folder, 'meta'), { recursive: true });
    writeFileSync(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [{ tag: '0000_init', when: 1000 }, { tag: '0001_bad' }],
      })
    );
    expect(() => readJournal(folder)).toThrow(/entries\[1\] is missing/);
  });
});

describe('pendingEntries', () => {
  const entries: JournalEntry[] = [
    { tag: '0000_a', when: 1000 },
    { tag: '0001_b', when: 2000 },
    { tag: '0002_c', when: 3000 },
  ];

  it('returns the whole journal against a ledger with nothing recorded', () => {
    expect(pendingEntries(entries, null)).toEqual(entries);
  });

  it('returns only entries strictly newer than the last applied', () => {
    expect(pendingEntries(entries, 2000)).toEqual([{ tag: '0002_c', when: 3000 }]);
  });

  it('returns nothing once the ledger is at or ahead of the newest entry', () => {
    expect(pendingEntries(entries, 3000)).toEqual([]);
  });
});

describe('unreachableEntries', () => {
  // Generated on a branch cut before `0001` landed, merged after it — the
  // shape a merge of two long-lived branches produces.
  const entries: JournalEntry[] = [
    { tag: '0000_first', when: 1000 },
    { tag: '0001_second', when: 2000 },
    { tag: '0002_late_merge', when: 1500 },
    { tag: '0003_after', when: 3000 },
  ];

  it('finds nothing on a database no migration has touched', () => {
    // drizzle reads the ledger ONCE before its loop, so `!lastDbMigration`
    // holds for every entry of a from-empty run and the out-of-order entry
    // applies like any other.
    expect(unreachableEntries(entries, [])).toEqual([]);
  });

  it('finds nothing when the ledger has recorded every entry', () => {
    expect(unreachableEntries(entries, [1000, 2000, 1500, 3000])).toEqual([]);
  });

  it('names the entry that sits BELOW the high-water without a ledger row', () => {
    expect(unreachableEntries(entries, [1000, 2000])).toEqual([
      { tag: '0002_late_merge', when: 1500 },
    ]);
  });

  it('does NOT flag an entry newer than the high-water — that one is merely pending', () => {
    expect(unreachableEntries(entries, [1000, 2000, 1500])).toEqual([]);
  });

  it('treats a timestamp the ledger HAS recorded as reachable, dropping only the unrecorded one', () => {
    const simple: JournalEntry[] = [
      { tag: '0000_a', when: 1000 },
      { tag: '0001_b', when: 2000 },
      { tag: '0002_c', when: 3000 },
    ];
    expect(unreachableEntries(simple, [1000, 2000, 3000])).toEqual([]);
    expect(unreachableEntries(simple, [1000, 3000])).toEqual([{ tag: '0001_b', when: 2000 }]);
  });

  // `unreachableEntries` is filtered `when <= highWater && !applied.has(when)`.
  // A reader eventually asks whether the `<=` could be `<`, and the docblock
  // answers that it could — `highWater` is `Math.max(appliedMillis)` and is
  // therefore always a member of `appliedMillis`, so `when === highWater`
  // implies `applied.has(when)` and the second clause rejects it either way.
  //
  // What is checked here is the REAL implementation against a hand-written
  // reference, on random input. What is deliberately NOT checked is
  // `withLte(...) === withLt(...)`: two local copies of the filter differing
  // only in that operator cannot disagree FOR ANY INPUT, by the argument
  // above, so that assertion passes on every possible run and would pass just
  // as readily against a broken `unreachableEntries` it never calls. A check
  // that cannot fail is worse than no check — it reads as coverage of the
  // boundary while covering nothing.
  it('agrees with a hand-written reference filter on random input', () => {
    function randomEntries(): JournalEntry[] {
      const count = 1 + Math.floor(Math.random() * 8);
      return Array.from({ length: count }, (_, index) => ({
        tag: `t${index}`,
        when: Math.floor(Math.random() * 10000),
      }));
    }
    function reference(list: JournalEntry[], appliedMillis: readonly number[]): JournalEntry[] {
      const highWater = highWaterMillis(appliedMillis);
      if (highWater === null) return [];
      const applied = new Set(appliedMillis);
      return list.filter((entry) => entry.when <= highWater && !applied.has(entry.when));
    }
    for (let trial = 0; trial < 2000; trial += 1) {
      const list = randomEntries();
      const appliedMillis = list
        .filter(() => Math.random() < 0.5)
        .map((entry) => entry.when);
      expect(unreachableEntries(list, appliedMillis)).toEqual(reference(list, appliedMillis));
    }
  });
});

describe('planLedgerRun', () => {
  const entries: JournalEntry[] = [
    { tag: '0000_first', when: 1000 },
    { tag: '0001_second', when: 2000 },
    { tag: '0002_late_merge', when: 1500 },
    { tag: '0003_after', when: 3000 },
  ];

  it('returns the pending entries when every skipped one is genuinely newer', () => {
    expect(planLedgerRun(entries, [1000, 2000, 1500])).toEqual([
      { tag: '0003_after', when: 3000 },
    ]);
  });

  it('returns the whole journal against an empty ledger', () => {
    expect(planLedgerRun(entries, [])).toEqual(entries);
  });

  it('REFUSES rather than reporting a clean run, and names the entry', () => {
    // With the ledger at 2000, `pendingEntries` alone returns [] — the exact
    // condition that used to print `No pending Postgres migrations` and exit 0
    // over a migration that never ran.
    let thrown: unknown;
    try {
      planLedgerRun(entries, [1000, 2000, 3000]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnreachableMigrationError);
    expect((thrown as Error).message).toContain('0002_late_merge');
    expect((thrown as Error).message).toContain('1500');
    expect((thrown as UnreachableMigrationError).entries).toEqual([
      { tag: '0002_late_merge', when: 1500 },
    ]);
  });

  it('refuses on the SILENT path specifically — nothing else is pending', () => {
    const ledger = [1000, 2000, 3000];
    expect(unreachableEntries(entries, ledger)).toHaveLength(1);
    expect(() => planLedgerRun(entries, ledger)).toThrow(UnreachableMigrationError);
  });

  it('names EVERY unreachable entry, not just the first', () => {
    const staggered: JournalEntry[] = [
      { tag: '0000_a', when: 1000 },
      { tag: '0001_b', when: 1200 },
      { tag: '0002_c', when: 1400 },
      { tag: '0003_d', when: 5000 },
    ];
    let caught: UnreachableMigrationError | null = null;
    try {
      planLedgerRun(staggered, [1000, 5000]);
    } catch (error) {
      caught = error as UnreachableMigrationError;
    }
    expect(caught?.entries.map((entry) => entry.tag)).toEqual(['0001_b', '0002_c']);
  });
});

describe('toAppliedMillis', () => {
  // `readAppliedMillis` and `readLastAppliedMillis` both reduce to this
  // function on the rows postgres.js hands back, so these are the tests for
  // both round trips' coercion rule — not just for this function in isolation.

  it('drops a NULL created_at rather than coercing it to 0', () => {
    // The exact bug this exists to refuse: `Number(null)` is 0, which would
    // read as a row applied at the Unix epoch and drag the ledger's
    // high-water mark down to it.
    expect(toAppliedMillis([{ created_at: null }, { created_at: '5000' }])).toEqual([5000]);
  });

  it('coerces a bigint-as-string to an actual number, not a string', () => {
    // toEqual distinguishes '1712345678901' from 1712345678901 — a missed
    // `Number(...)` would return the former and fail this assertion, not
    // silently pass it.
    expect(toAppliedMillis([{ created_at: '1712345678901' }])).toEqual([1712345678901]);
  });

  it('returns [] for an empty result set — a table that exists but holds no rows', () => {
    expect(toAppliedMillis([])).toEqual([]);
  });

  it('models readLastAppliedMillis: the single most-recent row, or null when there is none', () => {
    // `readLastAppliedMillis` is `toAppliedMillis(rows)[0] ?? null` on a
    // `order by created_at desc limit 1` result — asserted here directly
    // since calling the real function needs a live database this package
    // does not yet have a harness for.
    expect(toAppliedMillis([{ created_at: '2000' }])[0] ?? null).toBe(2000);
    expect(toAppliedMillis([])[0] ?? null).toBeNull();
    // A lone NULL row: dropped by the coercion, same as an empty result set —
    // not coerced to a value of 0.
    expect(toAppliedMillis([{ created_at: null }])[0] ?? null).toBeNull();
  });
});
