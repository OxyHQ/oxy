/**
 * Live-Postgres coverage for the ephemeral-database harness itself —
 * including that a throwing `migrate` hook does not leak the database it was
 * given, confirmed here against a REAL server rather than the faked driver
 * `testing.test.ts` uses for the same claim — and for the four
 * migration-ledger functions Task 5 shipped with NO coverage at all:
 * `assertMigrationTarget`, `readAppliedMillis`, `readLastAppliedMillis`,
 * `assertPostgresMigrationsCurrent`. Each needs a real `postgres.Sql` — a
 * stub would only prove the comparison agrees with itself, the same reasoning
 * `targetDatabase.test.ts` and `extensions.test.ts` already give for leaving
 * them out — and this package had no live-database harness until this task
 * built `createTestDatabase`/`dropTestDatabase`. The "migrated" database
 * below is created through the `migrate` hook itself (closing over
 * `runMigrations`), the same composition Task 12/14 are expected to use, not
 * a hand-wired call kept separate from what the harness actually offers.
 *
 * The final `describeLive` block covers `runMigrations`'s own
 * `expectedDatabase` option — optional precisely so a consumer that has
 * never carried the target-database guard is not forced to adopt it as a
 * side effect of adopting this package (see the option's own doc comment in
 * `runner.ts`) — proving BOTH directions: that the check genuinely does not
 * run when the option is omitted, and genuinely does when it is supplied. An
 * optional guard that silently never fires either way would be worse than no
 * option at all.
 *
 * Skipped entirely when `OXYDB_TEST_ADMIN_URL` is unset: this package's own
 * CI does not yet run a Postgres service (wiring one is a separate task), so
 * a checkout with no server to reach must not fail here. Point it at any
 * Postgres this process may create and drop databases on, e.g.:
 *
 *   OXYDB_TEST_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
 *     bun run --filter @oxyhq/db test -- liveDatabase.test.ts
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { MigrationsNotCurrentError, assertPostgresMigrationsCurrent, readAppliedMillis, readJournal, readLastAppliedMillis, type JournalEntry } from '../migrate/ledger';
import { runMigrations } from '../migrate/runner';
import { WrongMigrationTargetError, assertMigrationTarget } from '../migrate/targetDatabase';
import { createTestDatabase, dropTestDatabase } from '../testing';

const ADMIN_URL = process.env.OXYDB_TEST_ADMIN_URL;
const describeLive = ADMIN_URL ? describe : describe.skip;

const noopLogger = { info: () => {}, debug: () => {} };

/** Two trivial, real migrations — enough to produce genuine ledger rows. */
const FIXTURE_FILES: Array<{ tag: string; when: number; sql: string }> = [
  { tag: '0000_first', when: 1_000, sql: '-- oxy:deploy-phase=pre\nselect 1;\n' },
  { tag: '0001_second', when: 2_000, sql: '-- oxy:deploy-phase=pre\nselect 2;\n' },
];
const FIXTURE_ENTRIES: JournalEntry[] = FIXTURE_FILES.map(({ tag, when }) => ({ tag, when }));

/** A throwaway `drizzle/` directory holding {@link FIXTURE_FILES}. Caller removes it. */
function migrationsFixture(): string {
  const folder = mkdtempSync(join(tmpdir(), 'oxydb-live-'));
  mkdirSync(join(folder, 'meta'), { recursive: true });
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries: FIXTURE_ENTRIES })
  );
  for (const file of FIXTURE_FILES) {
    writeFileSync(join(folder, `${file.tag}.sql`), file.sql);
  }
  return folder;
}

function bareDatabaseName(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, '');
}

/**
 * Narrows a `beforeAll`-assigned `T | undefined` to `T`, with a real runtime
 * check rather than a `!`/`as` type-only assertion — `beforeAll` always runs
 * before the `it()`s below read these, but TypeScript has no way to know
 * that from the types alone.
 */
function assertAssigned<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`${name} was not assigned — beforeAll must run before this is read.`);
  }
  return value;
}

describeLive('createTestDatabase / dropTestDatabase (live Postgres)', () => {
  it('creates a connectable, uniquely-named database, and drop actually removes it', async () => {
    const url = await createTestDatabase({ adminUrl: ADMIN_URL });
    const name = bareDatabaseName(url);

    const client = postgres(url, { max: 1 });
    try {
      const rows = await client<{ current_database: string }[]>`select current_database()`;
      expect(rows[0]?.current_database).toBe(name);
    } finally {
      await client.end({ timeout: 5 });
    }

    await dropTestDatabase(url);

    // Confirmed via a SEPARATE admin connection, not by re-using `client`
    // (already closed above) or by trusting `dropTestDatabase` resolving
    // without error — this is the actual evidence the database is gone.
    const admin = postgres(assertAssigned(ADMIN_URL, 'ADMIN_URL'), { max: 1 });
    try {
      const rows = await admin<{ present: boolean }[]>`
        select exists(select 1 from pg_database where datname = ${name}) as present
      `;
      expect(rows[0]?.present).toBe(false);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });

  it('drops the database when the migrate hook throws, rather than leaving it behind', async () => {
    let capturedUrl = '';

    await expect(
      createTestDatabase({
        adminUrl: ADMIN_URL,
        migrate: async (url) => {
          capturedUrl = url;
          throw new Error('simulated migration failure');
        },
      })
    ).rejects.toThrow('simulated migration failure');

    expect(capturedUrl).not.toBe('');
    const name = bareDatabaseName(capturedUrl);

    // Same evidence standard as the test above: a SEPARATE admin connection
    // querying pg_database directly, against a real server — not an inference
    // from the rejection alone (a hook that throws AFTER leaking the database
    // would reject exactly the same way).
    const admin = postgres(assertAssigned(ADMIN_URL, 'ADMIN_URL'), { max: 1 });
    try {
      const rows = await admin<{ present: boolean }[]>`
        select exists(select 1 from pg_database where datname = ${name}) as present
      `;
      expect(rows[0]?.present).toBe(false);
    } finally {
      await admin.end({ timeout: 5 });
    }
  });
});

describeLive('migration-ledger functions against a real Postgres', () => {
  let freshUrl: string | undefined;
  let freshClient: postgres.Sql | undefined;
  let migratedUrl: string | undefined;
  let migratedClient: postgres.Sql | undefined;
  let migratedName: string;
  let fixtureFolder: string | undefined;

  beforeAll(async () => {
    // A database no migration has ever touched — for the "nothing recorded
    // yet" branch of readAppliedMillis/readLastAppliedMillis.
    freshUrl = await createTestDatabase({ adminUrl: ADMIN_URL });
    freshClient = postgres(freshUrl, { max: 1 });

    // A second database, actually migrated through the SAME runMigrations
    // this package ships, wired through createTestDatabase's own `migrate`
    // hook — the way a real consumer (Task 12/14) is expected to use it —
    // so the ledger rows these tests read are exactly what a real migration
    // run produces, not a hand-written fixture.
    const folder = migrationsFixture();
    fixtureFolder = folder;
    migratedUrl = await createTestDatabase({
      adminUrl: ADMIN_URL,
      migrate: (url) =>
        runMigrations({
          databaseUrl: url,
          migrationsFolder: folder,
          extensions: [],
          run: 'all',
          expectedDatabase: bareDatabaseName(url),
          dryRun: false,
          logger: noopLogger,
        }),
    });
    migratedName = bareDatabaseName(migratedUrl);
    migratedClient = postgres(migratedUrl, { max: 1 });
  });

  afterAll(async () => {
    await freshClient?.end({ timeout: 5 });
    await migratedClient?.end({ timeout: 5 });
    if (fixtureFolder) rmSync(fixtureFolder, { recursive: true, force: true });
    if (freshUrl) await dropTestDatabase(freshUrl);
    if (migratedUrl) await dropTestDatabase(migratedUrl);
  });

  describe('assertMigrationTarget', () => {
    it('resolves when the connection really is pointed at the named database', async () => {
      const client = assertAssigned(migratedClient, 'migratedClient');
      await expect(assertMigrationTarget(client, migratedName)).resolves.toBeUndefined();
    });

    it('rejects, naming both sides, when it is not', async () => {
      const client = assertAssigned(migratedClient, 'migratedClient');
      await expect(assertMigrationTarget(client, 'definitely_not_this_database')).rejects.toThrow(
        WrongMigrationTargetError
      );
      await expect(assertMigrationTarget(client, 'definitely_not_this_database')).rejects.toThrow(
        new RegExp(migratedName)
      );
    });
  });

  describe('readAppliedMillis / readLastAppliedMillis', () => {
    it('return [] / null against a database no migration has ever touched', async () => {
      const client = assertAssigned(freshClient, 'freshClient');
      await expect(readAppliedMillis(client)).resolves.toEqual([]);
      await expect(readLastAppliedMillis(client)).resolves.toBeNull();
    });

    it('return the real applied millis, correctly coerced from Postgres, once migrations have run', async () => {
      const client = assertAssigned(migratedClient, 'migratedClient');
      // Order-independent: `readAppliedMillis` runs no ORDER BY (see its own
      // comment in ledger.ts).
      await expect(readAppliedMillis(client)).resolves.toEqual(
        expect.arrayContaining([1_000, 2_000])
      );
      await expect(readLastAppliedMillis(client)).resolves.toBe(2_000);
    });
  });

  describe('assertPostgresMigrationsCurrent', () => {
    it('resolves when the ledger covers every shipped journal entry', async () => {
      const client = assertAssigned(migratedClient, 'migratedClient');
      await expect(
        assertPostgresMigrationsCurrent(client, FIXTURE_ENTRIES)
      ).resolves.toBeUndefined();
    });

    it('rejects and names the tag when the image ships a migration the database has not applied', async () => {
      const client = assertAssigned(migratedClient, 'migratedClient');
      const aheadEntries: JournalEntry[] = [...FIXTURE_ENTRIES, { tag: '0002_third', when: 3_000 }];
      await expect(assertPostgresMigrationsCurrent(client, aheadEntries)).rejects.toThrow(
        /0002_third/
      );
    });

    // The message text is what a human reads; the CLASS is what a boot path
    // branches on to tell "schema is behind" from any other startup failure.
    // Asserting only the message would leave the class an untested claim — and
    // a later edit could quietly go back to a bare `Error` with this suite
    // still green.
    it('rejects with MigrationsNotCurrentError, carrying the pending entries', async () => {
      const client = assertAssigned(migratedClient, 'migratedClient');
      const aheadEntries: JournalEntry[] = [...FIXTURE_ENTRIES, { tag: '0002_third', when: 3_000 }];
      await expect(assertPostgresMigrationsCurrent(client, aheadEntries)).rejects.toBeInstanceOf(
        MigrationsNotCurrentError
      );
      const error = await assertPostgresMigrationsCurrent(client, aheadEntries).catch(
        (thrown: unknown) => thrown
      );
      expect(error).toBeInstanceOf(MigrationsNotCurrentError);
      expect((error as MigrationsNotCurrentError).pending.map((entry) => entry.tag)).toEqual([
        '0002_third',
      ]);
    });
  });
});

/**
 * A throwaway `drizzle/` directory holding a journal that parses to a
 * genuinely empty `entries` array — the shape a project has on disk after
 * wiring its migrator but before writing its first schema migration. No
 * `.sql` files: there is nothing for the journal to reference.
 */
function emptyMigrationsFixture(): string {
  const folder = mkdtempSync(join(tmpdir(), 'oxydb-live-empty-'));
  mkdirSync(join(folder, 'meta'), { recursive: true });
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({ version: '7', dialect: 'postgresql', entries: [] })
  );
  return folder;
}

describeLive('runMigrations — an empty journal applies nothing and succeeds', () => {
  // The exact shape Syra's third-consumer report reproduced: a project whose
  // migrator is wired before its first schema migration exists. Before the
  // fix, `readJournal` refused this journal outright — a database that never
  // ran a single migration is indistinguishable from one whose migrator is
  // genuinely broken only if the guard conflates "parsed with zero entries"
  // with "could not be read". This proves the fixed behaviour against a real
  // server end to end, not just the pure functions in ledger.test.ts.
  it('applies nothing, resolves, and leaves the ledger table absent', async () => {
    const folder = emptyMigrationsFixture();
    let url: string | undefined;
    try {
      // readJournal itself must not throw — the first filesystem precondition
      // runMigrations checks, before any connection is opened.
      expect(readJournal(folder)).toEqual([]);

      url = await createTestDatabase({
        adminUrl: ADMIN_URL,
        migrate: (databaseUrl) =>
          runMigrations({
            databaseUrl,
            migrationsFolder: folder,
            extensions: [],
            run: 'all',
            expectedDatabase: bareDatabaseName(databaseUrl),
            dryRun: false,
            logger: noopLogger,
          }),
      });

      // "Applies nothing" means exactly that: no migration ever ran, so
      // drizzle's migrator never created its own ledger table at all. This is
      // the "left consistent" claim — not an empty table, an ABSENT one,
      // which is what readAppliedMillis/readLastAppliedMillis already treat
      // as "nothing recorded" (see their own doc comments in ledger.ts).
      const client = postgres(url, { max: 1 });
      try {
        await expect(readAppliedMillis(client)).resolves.toEqual([]);
        await expect(readLastAppliedMillis(client)).resolves.toBeNull();
        const [ledger] = await client<{ present: boolean }[]>`
          select to_regclass('drizzle.__drizzle_migrations') is not null as present
        `;
        expect(ledger?.present).toBe(false);
      } finally {
        await client.end({ timeout: 5 });
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
      if (url) await dropTestDatabase(url);
    }
  });

  it('the deploy-phase runs (`pre`, `post`) agree: an empty journal applies nothing under either', async () => {
    // runMigrations's `run` option changes which pending migrations are safe
    // to apply, not whether an empty journal is readable at all — pinned for
    // both non-`all` phases so a future change to phases.ts cannot silently
    // reintroduce a refusal on one of them while ledger.test.ts only ever
    // exercises `readJournal` in isolation.
    for (const run of ['pre', 'post'] as const) {
      const folder = emptyMigrationsFixture();
      let url: string | undefined;
      try {
        url = await createTestDatabase({
          adminUrl: ADMIN_URL,
          migrate: (databaseUrl) =>
            runMigrations({
              databaseUrl,
              migrationsFolder: folder,
              extensions: [],
              run,
              expectedDatabase: bareDatabaseName(databaseUrl),
              dryRun: false,
              logger: noopLogger,
            }),
        });
      } finally {
        rmSync(folder, { recursive: true, force: true });
        if (url) await dropTestDatabase(url);
      }
    }
  });
});

describeLive('runMigrations — expectedDatabase is optional', () => {
  it('does not check the target when expectedDatabase is omitted, and still applies migrations', async () => {
    // The proof is the OMISSION itself, not a mismatch: assertMigrationTarget
    // has its own dedicated coverage above for what happens when it runs. If
    // this call silently checked against some inferred value anyway, that
    // would be indistinguishable from correct behaviour from the outside —
    // so this asserts the run SUCCEEDS with no target named at all, which is
    // only possible if the check truly did not execute.
    const folder = migrationsFixture();
    let url: string | undefined;
    try {
      url = await createTestDatabase({
        adminUrl: ADMIN_URL,
        migrate: (databaseUrl) =>
          runMigrations({
            databaseUrl,
            migrationsFolder: folder,
            extensions: [],
            run: 'all',
            // expectedDatabase deliberately omitted.
            dryRun: false,
            logger: noopLogger,
          }),
      });

      const client = postgres(url, { max: 1 });
      try {
        await expect(readLastAppliedMillis(client)).resolves.toBe(2_000);
      } finally {
        await client.end({ timeout: 5 });
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
      if (url) await dropTestDatabase(url);
    }
  });

  it('DOES check the target when expectedDatabase is supplied, and rejects on a mismatch', async () => {
    // The other half of the same proof: the identical call, differing only
    // in whether expectedDatabase is present, behaves differently — so the
    // option genuinely gates the check in both directions, rather than the
    // check silently never firing regardless of the option (or always
    // firing regardless of it).
    const folder = migrationsFixture();
    try {
      await expect(
        createTestDatabase({
          adminUrl: ADMIN_URL,
          migrate: (databaseUrl) =>
            runMigrations({
              databaseUrl,
              migrationsFolder: folder,
              extensions: [],
              run: 'all',
              expectedDatabase: 'definitely_not_this_database',
              dryRun: false,
              logger: noopLogger,
            }),
        })
        // createTestDatabase's own migrate-hook contract drops the database
        // it created before rethrowing, so nothing is leaked here.
      ).rejects.toThrow(WrongMigrationTargetError);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
