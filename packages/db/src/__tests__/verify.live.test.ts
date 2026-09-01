/**
 * `verify.ts` against a REAL ledger written by a REAL migration run.
 *
 * `verify.test.ts` proves {@link readJournalWithHashes} agrees with drizzle's
 * `readMigrationFiles` — both of which read the FOLDER. Neither of them touches
 * the ledger, so together they still cannot rule out the one thing that would
 * make the second key worthless: that what `migrate()` actually WRITES into
 * `drizzle.__drizzle_migrations` is not what either function computes. This
 * file closes that gap by running `runMigrations` against a throwaway database
 * and reading the row back.
 *
 * That distinction is the whole reason both files exist. A hash agreeing with
 * itself across two readers of the same bytes is not evidence about the
 * database.
 *
 * Skipped when `OXYDB_TEST_ADMIN_URL` is unset, same as `liveDatabase.test.ts`,
 * `expiryIndexes.live.test.ts` and `schemaInvariants.live.test.ts` — this
 * package's own CI does not yet run a Postgres service. The folder-side
 * coupling test in `verify.test.ts` is deliberately database-free for exactly
 * that reason: it is the layer that still runs.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { runMigrations } from '../migrate/runner';
import {
  compareLedger,
  readAppliedRows,
  readJournalWithHashes,
} from '../migrate/verify';
import { createTestDatabase, dropTestDatabase } from '../testing';

const ADMIN_URL = process.env.OXYDB_TEST_ADMIN_URL;
const describeLive = ADMIN_URL ? describe : describe.skip;

const MIGRATIONS = [
  {
    tag: '0000_create_widgets',
    when: 1_700_000_000_000,
    sql: '-- oxy:deploy-phase=pre\nCREATE TABLE "widgets" ("id" text PRIMARY KEY);',
  },
  {
    tag: '0001_create_gadgets',
    when: 1_700_000_001_000,
    sql: '-- oxy:deploy-phase=pre\nCREATE TABLE "gadgets" ("id" text PRIMARY KEY);',
  },
];

function writeMigrationsFolder(files: typeof MIGRATIONS): string {
  const folder = mkdtempSync(join(tmpdir(), 'oxydb-verify-live-'));
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

const silentLogger = { info: () => {}, debug: () => {} };

describeLive('verifyMigrationLedger against a real migration run', () => {
  let folder: string;
  let databaseUrl: string;

  beforeAll(async () => {
    folder = writeMigrationsFolder(MIGRATIONS);
    databaseUrl = await createTestDatabase({
      adminUrl: ADMIN_URL,
      migrate: (url) =>
        runMigrations({
          databaseUrl: url,
          migrationsFolder: folder,
          extensions: [],
          run: 'all',
          dryRun: false,
          logger: silentLogger,
        }),
    });
  }, 60_000);

  afterAll(async () => {
    if (databaseUrl) await dropTestDatabase(databaseUrl);
    if (folder) rmSync(folder, { recursive: true, force: true });
  }, 60_000);

  /**
   * THE CLAIM `verify.test.ts` CANNOT MAKE: the hash drizzle RECORDS equals the
   * one computed from the file. If drizzle ever hashed something other than the
   * raw file bytes — a normalized form, the split statements, the file with its
   * breakpoints removed — this is where it would show.
   */
  it('records the same hash this module computes, for every migration', async () => {
    const client = postgres(databaseUrl, { max: 1 });
    try {
      const rows = await readAppliedRows(client);
      const entries = readJournalWithHashes(folder);

      // Floor: an empty ledger would make every per-row assertion below
      // vacuous, and an empty ledger is exactly what a migration run that did
      // nothing leaves behind.
      expect(rows).toHaveLength(MIGRATIONS.length);
      expect(entries).toHaveLength(MIGRATIONS.length);

      const recorded = new Map(rows.map((row) => [row.whenMillis, row.hash]));
      for (const entry of entries) {
        expect(recorded.get(entry.when)).toBe(entry.hash);
      }
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 60_000);

  it('reports a fully-migrated database as current, with non-zero counts', async () => {
    const client = postgres(databaseUrl, { max: 1 });
    try {
      const result = compareLedger(readJournalWithHashes(folder), await readAppliedRows(client));
      expect(result.unapplied).toEqual([]);
      expect(result.unknownToJournal).toEqual([]);
      expect(result.hashMismatches).toEqual([]);
      expect(result.journalCount).toBe(MIGRATIONS.length);
      expect(result.ledgerCount).toBe(MIGRATIONS.length);
    } finally {
      await client.end({ timeout: 5 });
    }
  }, 60_000);

  /**
   * The negative control for the test above, in the same currency: a journal
   * carrying a migration this database never ran must be reported as unapplied.
   * Without it, "reports as current" is a claim a comparator that always
   * returned three empty arrays would also satisfy.
   */
  it('reports an unrun migration as unapplied against the same database', async () => {
    const extended = writeMigrationsFolder([
      ...MIGRATIONS,
      {
        tag: '0002_never_run',
        when: 1_700_000_002_000,
        sql: '-- oxy:deploy-phase=pre\nCREATE TABLE "sprockets" ("id" text PRIMARY KEY);',
      },
    ]);
    const client = postgres(databaseUrl, { max: 1 });
    try {
      const result = compareLedger(readJournalWithHashes(extended), await readAppliedRows(client));
      expect(result.unapplied.map((entry) => entry.tag)).toEqual(['0002_never_run']);
      expect(result.unknownToJournal).toEqual([]);
      expect(result.hashMismatches).toEqual([]);
    } finally {
      await client.end({ timeout: 5 });
      rmSync(extended, { recursive: true, force: true });
    }
  }, 60_000);

  /**
   * The other direction, and the one a timestamp-only comparison cannot see: a
   * journal whose file CONTENT changed after it was applied. Same `when`, same
   * tag, different bytes — indistinguishable from a current database unless the
   * hash is checked.
   */
  it('detects a migration whose file changed after it was applied', async () => {
    const edited = writeMigrationsFolder([
      { ...MIGRATIONS[0], sql: `${MIGRATIONS[0].sql}\n-- edited after applying` },
      MIGRATIONS[1],
    ]);
    const client = postgres(databaseUrl, { max: 1 });
    try {
      const result = compareLedger(readJournalWithHashes(edited), await readAppliedRows(client));
      expect(result.unapplied).toEqual([]);
      expect(result.unknownToJournal).toEqual([]);
      expect(result.hashMismatches.map((m) => m.tag)).toEqual(['0000_create_widgets']);
    } finally {
      await client.end({ timeout: 5 });
      rmSync(edited, { recursive: true, force: true });
    }
  }, 60_000);
});
