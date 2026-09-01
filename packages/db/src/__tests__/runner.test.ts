/**
 * What `runMigrations` can be checked on WITHOUT a live database:
 *
 * - `materializeJournalPrefix`, the mechanism that lets a `pre`-phase run
 *   stop before a `post` migration: pure filesystem manipulation, no
 *   connection involved at all.
 * - That the filesystem preconditions (a readable journal, every pending
 *   migration declaring a deploy phase) run and fail BEFORE any connection
 *   is opened. Proven the same way `extensions.test.ts` proves its
 *   connection-avoidance claim: point `databaseUrl` at a host `.invalid`
 *   guarantees can never resolve (RFC 2606) and assert the rejection carries
 *   the filesystem check's own message, not a network error.
 * - That `runMigrations` removes the temporary prefix folder in its
 *   `finally`, not only when everything succeeds. This is a claim about OUR
 *   OWN control flow, not about Postgres, so the last describe block below
 *   fakes `postgres`, `drizzle-orm/postgres-js` and its migrator just deeply
 *   enough to reach the `migrate()` call and make it throw — it asserts
 *   nothing about real database semantics (`current_database()`, the real
 *   ledger table, a real migration actually applying) and would not be valid
 *   evidence for any of that.
 *
 * Everything else needs a real Postgres. `assertMigrationTarget` actually
 * comparing against a real `current_database()`, and the ledger read
 * (`readAppliedMillis`/`readLastAppliedMillis`), are now covered in
 * `liveDatabase.test.ts` against the ephemeral-database harness `testing.ts`
 * provides — whose `beforeAll` also applies a real migration through THIS
 * `runMigrations`, so `migrate()` itself succeeding is exercised there too
 * (indirectly: its `beforeAll` would throw otherwise). `ensureExtensions`
 * against a real server and a deliberately-broken post-apply
 * re-verification remain uncovered — closing every live-Postgres gap in this
 * package was not the harness task's scope, only the four functions Task 5
 * shipped with zero coverage.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JournalEntry } from '../migrate/ledger';
import { materializeJournalPrefix, runMigrations } from '../migrate/runner';

const noopLogger = { info: () => {}, debug: () => {} };

// Directories created FRESH inside a single `it()` — via `migrationsFixtureTracked`
// or `materializeJournalPrefixTracked` — are tracked here and removed in the
// top-level `afterEach`, so no single test's fixture needs to survive past
// that test. `materializeJournalPrefix` itself documents "the caller owns it
// and must remove it" (`runner.ts`); an `it()` block calling it IS that
// caller, so leaving the return value untracked is not a gap this file's
// tests are exempt from, it is exactly the leak the function's own contract
// assigns to them.
//
// A directory created ONCE at a `describe()` body's top level and reused by
// EVERY sibling test — the shared source folder in `describe('materializeJournalPrefix', ...)`
// below — must NOT go through this array: this `afterEach` runs after every
// individual test, so tracking a describe-scoped fixture here would delete
// it after the FIRST sibling test and break every test after it with an
// ENOENT reading a journal that this suite itself removed. That case gets
// its own `afterAll` instead, scoped to the describe block that created it.
const createdFolders: string[] = [];

afterEach(() => {
  for (const folder of createdFolders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

function migrationsFixture(entries: Array<{ tag: string; when: number; sql: string }>): string {
  const folder = mkdtempSync(join(tmpdir(), 'oxydb-runner-'));
  mkdirSync(join(folder, 'meta'), { recursive: true });
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: entries.map(({ tag, when }) => ({ tag, when })),
    })
  );
  for (const entry of entries) {
    writeFileSync(join(folder, `${entry.tag}.sql`), entry.sql);
  }
  return folder;
}

/**
 * `migrationsFixture`, plus tracking its return value for per-test cleanup.
 * Only call this from INSIDE an `it()` — a fixture meant to be shared across
 * multiple sibling tests (created at a `describe()` body's top level) must be
 * cleaned up in its own `afterAll` instead, or the file-level `afterEach`
 * deletes it after the first test that runs.
 */
function migrationsFixtureTracked(
  entries: Array<{ tag: string; when: number; sql: string }>
): string {
  const folder = migrationsFixture(entries);
  createdFolders.push(folder);
  return folder;
}

/** `materializeJournalPrefix`, plus tracking its return value for cleanup. */
function materializeJournalPrefixTracked(
  entries: readonly JournalEntry[],
  count: number,
  sourceFolder: string
): string {
  const prefixFolder = materializeJournalPrefix(entries, count, sourceFolder);
  createdFolders.push(prefixFolder);
  return prefixFolder;
}

describe('materializeJournalPrefix', () => {
  // Created ONCE and read by every `it()` below — cleaned up in `afterAll`,
  // deliberately NOT through `createdFolders` (see the comment on that array).
  const folder = migrationsFixture([
    { tag: '0000_a', when: 1000, sql: '-- oxy:deploy-phase=pre\nselect 1;\n' },
    { tag: '0001_b', when: 2000, sql: '-- oxy:deploy-phase=post\nselect 2;\n' },
    { tag: '0002_c', when: 3000, sql: '-- oxy:deploy-phase=pre\nselect 3;\n' },
  ]);
  const entries: JournalEntry[] = JSON.parse(
    readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')
  ).entries;

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('keeps only the first `count` journal entries', () => {
    const prefixFolder = materializeJournalPrefixTracked(entries, 2, folder);
    const prefixJournal = JSON.parse(readFileSync(join(prefixFolder, 'meta', '_journal.json'), 'utf8'));
    expect(prefixJournal.entries.map((entry: JournalEntry) => entry.tag)).toEqual([
      '0000_a',
      '0001_b',
    ]);
  });

  it('copies only the retained `.sql` files, and leaves the excluded ones out entirely', () => {
    const prefixFolder = materializeJournalPrefixTracked(entries, 2, folder);
    expect(existsSync(join(prefixFolder, '0000_a.sql'))).toBe(true);
    expect(existsSync(join(prefixFolder, '0001_b.sql'))).toBe(true);
    expect(existsSync(join(prefixFolder, '0002_c.sql'))).toBe(false);
  });

  it('copies each `.sql` file byte for byte, so drizzle records the same hash a full-folder run would', () => {
    const prefixFolder = materializeJournalPrefixTracked(entries, 1, folder);
    expect(readFileSync(join(prefixFolder, '0000_a.sql'), 'utf8')).toBe(
      readFileSync(join(folder, '0000_a.sql'), 'utf8')
    );
  });

  it('preserves the journal file\'s other top-level fields', () => {
    const prefixFolder = materializeJournalPrefixTracked(entries, 1, folder);
    const prefixJournal = JSON.parse(readFileSync(join(prefixFolder, 'meta', '_journal.json'), 'utf8'));
    expect(prefixJournal.version).toBe('7');
    expect(prefixJournal.dialect).toBe('postgresql');
  });

  it('takes a PREFIX, not an arbitrary subset — count=0 keeps nothing', () => {
    const prefixFolder = materializeJournalPrefixTracked(entries, 0, folder);
    const prefixJournal = JSON.parse(readFileSync(join(prefixFolder, 'meta', '_journal.json'), 'utf8'));
    expect(prefixJournal.entries).toEqual([]);
    expect(existsSync(join(prefixFolder, '0000_a.sql'))).toBe(false);
  });
});

describe('runMigrations — filesystem preconditions run before any connection is opened', () => {
  // `.invalid` is reserved by RFC 2606 to never resolve, so any of these
  // tests reaching an actual connection attempt would fail on a DNS lookup
  // rather than on the message asserted below — the two are not confusable.
  const unreachableUrl = 'postgres://unreachable.invalid/db';

  it('refuses a migrations folder whose journal cannot be read', async () => {
    await expect(
      runMigrations({
        databaseUrl: unreachableUrl,
        migrationsFolder: join(tmpdir(), 'oxydb-runner-does-not-exist'),
        extensions: [],
        run: 'all',
        expectedDatabase: 'irrelevant',
        dryRun: false,
        logger: noopLogger,
      })
    ).rejects.toThrow(/Cannot read the migration journal/);
  });

  it('refuses a pending migration with no deploy-phase marker', async () => {
    const folder = migrationsFixtureTracked([{ tag: '0000_a', when: 1000, sql: 'select 1;\n' }]);

    await expect(
      runMigrations({
        databaseUrl: unreachableUrl,
        migrationsFolder: folder,
        extensions: [],
        run: 'all',
        expectedDatabase: 'irrelevant',
        dryRun: false,
        logger: noopLogger,
      })
    ).rejects.toThrow(/do not declare which side of a deploy they belong on/);
  });

  it('names the offending tag, not just the count', async () => {
    const folder = migrationsFixtureTracked([
      { tag: '0000_a', when: 1000, sql: '-- oxy:deploy-phase=pre\nselect 1;\n' },
      { tag: '0001_bad', when: 2000, sql: 'select 2;\n' },
    ]);

    await expect(
      runMigrations({
        databaseUrl: unreachableUrl,
        migrationsFolder: folder,
        extensions: [],
        run: 'all',
        expectedDatabase: 'irrelevant',
        dryRun: false,
        logger: noopLogger,
      })
    ).rejects.toThrow(/0001_bad/);
  });
});

describe('runMigrations — cleans up the materialized prefix folder even when migrate() throws', () => {
  const EXPECTED_DATABASE = 'expected_db';
  // Empty rather than unset: if `beforeEach`'s `mkdtempSync` below ever threw
  // before assigning it, `afterEach` would otherwise call `rmSync` on an
  // unassigned variable. The guard on the `afterEach` call below is what
  // actually prevents that; the empty-string default just keeps the
  // declared type `string` rather than `string | undefined` everywhere else
  // it's used.
  let scratchRoot = '';

  beforeEach(() => {
    // A directory this ONE test exclusively owns — `mkdtemp`'s random suffix
    // guarantees uniqueness, so nothing but this test's own
    // `materializeJournalPrefix` call can ever create anything inside it.
    // That is what makes "is it empty afterward" a deterministic assertion
    // rather than a heuristic over shared OS temp space: a before/after diff
    // of the real `tmpdir()` would also flag a same-prefixed directory a
    // concurrent process (another worktree, a parallel CI shard) happened to
    // create during this test's window, for a reason unrelated to
    // `runMigrations` — a check that can invent a failure it didn't cause is
    // the "cries wolf" shape, not a fix.
    scratchRoot = mkdtempSync(join(tmpdir(), 'oxydb-runner-cleanup-scratch-'));
  });

  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
  });

  it('removes the temp directory in `finally`, not only on the happy path', async () => {
    // `jest.resetModules()` FIRST: `runner.ts`, and the `postgres` /
    // `drizzle-orm/postgres-js` / migrator / `node:os` modules it imports,
    // are already cached from the static import at the top of this file
    // (unmocked). A `jest.doMock` registered after that point only takes
    // effect for a module required AFTER the registry forgets the cached
    // copy.
    jest.resetModules();

    jest.doMock('node:os', () => {
      const actual = jest.requireActual('node:os');
      // Redirects ONLY the freshly re-imported `runner.ts`'s own
      // `tmpdir()` call (inside `materializeJournalPrefix`) at `scratchRoot`.
      // This test file's OWN top-level `tmpdir` import — used by
      // `migrationsFixture` below to build the SOURCE migrations folder —
      // was already resolved before this call runs and is unaffected.
      return { ...actual, tmpdir: () => scratchRoot };
    });

    jest.doMock('postgres', () => {
      const respond = (queryText: string): unknown[] => {
        if (queryText.includes('current_database')) {
          return [{ current_database: EXPECTED_DATABASE }];
        }
        // Ledger table absent — `readAppliedMillis` returns `[]` without a
        // second query, so every migration in this test's fixture is pending.
        if (queryText.includes('to_regclass')) return [{ present: false }];
        return [];
      };
      const client = Object.assign(
        jest.fn((strings: TemplateStringsArray) => Promise.resolve(respond(strings.join('')))),
        { end: jest.fn(() => Promise.resolve(undefined)) }
      );
      return { __esModule: true, default: jest.fn(() => client) };
    });
    // Stubbed rather than exercised: this test is about `runMigrations`'s own
    // `finally`, not about what a real drizzle handle or migrator does.
    jest.doMock('drizzle-orm/postgres-js', () => ({ drizzle: jest.fn(() => ({})) }));
    jest.doMock('drizzle-orm/postgres-js/migrator', () => ({
      migrate: jest.fn(() => Promise.reject(new Error('simulated migrate failure'))),
    }));

    const { runMigrations: runMigrationsUnderMock } = await import('../migrate/runner');

    // `pre` with a `post` migration behind it: this is what makes
    // `plan.deferred.length > 0` and forces `runMigrations` down the
    // `materializeJournalPrefix` branch instead of using the folder as-is.
    const folder = migrationsFixtureTracked([
      { tag: '0000_a', when: 1000, sql: '-- oxy:deploy-phase=pre\nselect 1;\n' },
      { tag: '0001_b', when: 2000, sql: '-- oxy:deploy-phase=post\nselect 2;\n' },
    ]);

    await expect(
      runMigrationsUnderMock({
        databaseUrl: 'postgres://mocked/db',
        migrationsFolder: folder,
        extensions: [],
        run: 'pre',
        expectedDatabase: EXPECTED_DATABASE,
        dryRun: false,
        logger: noopLogger,
      })
    ).rejects.toThrow('simulated migrate failure');

    // `materializeJournalPrefix`'s own `mkdtempSync` call is the only thing
    // that can ever put anything inside `scratchRoot` (via the mocked
    // `tmpdir()` above), so this is a direct, unmocked read of real disk
    // state — not an inference from whether a spy was called, and not
    // subject to interference from any other process on the machine.
    expect(readdirSync(scratchRoot)).toEqual([]);
  });
});
