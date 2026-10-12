/**
 * The driver option itself, against a real Postgres.
 *
 * Three claims, each of which the other live suites cannot make on their own:
 *
 * 1. A `createDatabase` handle on the selected driver (`OXYDB_TEST_DRIVER`)
 *    really is a working drizzle handle over a consumer schema — snake_case
 *    casing reaches the SQL, transactions roll back — and a constraint failure
 *    raised through it is recognised by `pgErrors`. The last one is the
 *    easy-to-miss part: `Bun.SQL` reports the SQLSTATE in `errno`, not `code`,
 *    so a predicate that only knew postgres.js would silently answer "not a
 *    unique violation" for every bun-sql failure.
 * 2. Ledger PARITY, Bun only: the same journal applied through postgres.js and
 *    through `Bun.SQL` leaves byte-identical ledger rows, and a database
 *    half-migrated by one driver is finished correctly by the other. That is
 *    what lets an application switch drivers between two deploys.
 * 3. Node refuses `bun-sql` with a sentence about the configuration, not a
 *    module-resolution error — and never loads `drizzle-orm/bun-sql` doing so.
 *
 * Skipped without `OXYDB_TEST_ADMIN_URL`, like every live suite here.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { createDatabase } from '../database';
import type { DatabaseDriver } from '../driver';
import { runMigrations } from '../migrate/runner';
import { WrongMigrationTargetError } from '../migrate/targetDatabase';
import { constraintNameOf, isCheckViolation, isUniqueViolation, sqlStateOf } from '../pgErrors';
import { createTestDatabase, dropTestDatabase } from '../testing';
import { IS_BUN, TEST_DRIVER, openLiveClient } from './support/liveDriver';

const ADMIN_URL = process.env.OXYDB_TEST_ADMIN_URL;
const describeLive = ADMIN_URL ? describe : describe.skip;
const describeLiveBun = ADMIN_URL && IS_BUN ? describe : describe.skip;
const describeNode = IS_BUN ? describe.skip : describe;

const silentLogger = { info: () => {}, debug: () => {} };

const widgets = pgTable('driver_widgets', {
  id: integer().primaryKey(),
  displayName: text().notNull().unique('driver_widgets_display_name_unique'),
  stock: integer().notNull(),
});

function bareDatabaseName(databaseUrl: string): string {
  return new URL(databaseUrl).pathname.replace(/^\//, '');
}

function openHandle(databaseUrl: string, driver: DatabaseDriver) {
  const schema = { widgets };
  if (driver === 'bun-sql') {
    const { db, client } = createDatabase({
      databaseUrl,
      schema,
      driver: 'bun-sql',
      client: { max: 2 },
    });
    return { db, close: () => client.close({ timeout: 5 }) };
  }
  const { db, client } = createDatabase({ databaseUrl, schema, client: { max: 2 } });
  return { db, close: () => client.end({ timeout: 5 }) };
}

describeLive(`createDatabase on ${TEST_DRIVER} (live Postgres)`, () => {
  let url: string | undefined;

  beforeAll(async () => {
    url = await createTestDatabase({
      adminUrl: ADMIN_URL,
      driver: TEST_DRIVER,
      migrate: async (databaseUrl) => {
        const admin = openLiveClient(databaseUrl);
        try {
          await admin.exec(`
            create table driver_widgets (
              id integer primary key,
              display_name text not null constraint driver_widgets_display_name_unique unique,
              stock integer not null constraint driver_widgets_stock_check check (stock >= 0)
            )
          `);
        } finally {
          await admin.close();
        }
      },
    });
  }, 60_000);

  afterAll(async () => {
    if (url) await dropTestDatabase(url, { driver: TEST_DRIVER });
  }, 60_000);

  function databaseUrl(): string {
    if (url === undefined) throw new Error('beforeAll did not create the database.');
    return url;
  }

  it('writes and reads through the schema, with snake_case reaching the SQL', async () => {
    const { db, close } = openHandle(databaseUrl(), TEST_DRIVER);
    try {
      await db.insert(widgets).values({ id: 1, displayName: 'first', stock: 3 });
      const rows = await db.select().from(widgets);
      expect(rows).toEqual([{ id: 1, displayName: 'first', stock: 3 }]);

      // The raw column name is `display_name`: the casing reached the SQL,
      // not just the result mapping.
      const raw = await db.execute(sql`select display_name from driver_widgets where id = 1`);
      expect(Array.from(raw)).toEqual([{ display_name: 'first' }]);
    } finally {
      await close();
    }
  });

  it('rolls a failed transaction back', async () => {
    const { db, close } = openHandle(databaseUrl(), TEST_DRIVER);
    try {
      await expect(
        db.transaction(async (tx) => {
          await tx.insert(widgets).values({ id: 2, displayName: 'in-tx', stock: 1 });
          throw new Error('abort the transaction');
        }),
      ).rejects.toThrow('abort the transaction');
      const rows = await db.select().from(widgets).where(sql`${widgets.id} = 2`);
      expect(rows).toEqual([]);
    } finally {
      await close();
    }
  });

  it('raises constraint failures that pgErrors recognises, by SQLSTATE and by name', async () => {
    const { db, close } = openHandle(databaseUrl(), TEST_DRIVER);
    try {
      await db.insert(widgets).values({ id: 10, displayName: 'taken', stock: 1 });

      const duplicate = await db
        .insert(widgets)
        .values({ id: 11, displayName: 'taken', stock: 1 })
        .catch((error: unknown) => error);
      expect(sqlStateOf(duplicate)).toBe('23505');
      expect(isUniqueViolation(duplicate, 'driver_widgets_display_name_unique')).toBe(true);
      expect(isUniqueViolation(duplicate, 'some_other_unique')).toBe(false);

      const negative = await db
        .insert(widgets)
        .values({ id: 12, displayName: 'negative', stock: -1 })
        .catch((error: unknown) => error);
      expect(constraintNameOf(negative)).toBe('driver_widgets_stock_check');
      expect(isCheckViolation(negative, 'driver_widgets_stock_check')).toBe(true);
      expect(isUniqueViolation(negative)).toBe(false);
    } finally {
      await close();
    }
  });
});

/** Two migrations on each side of a deploy, so a `pre` run must stop short. */
const PARITY_MIGRATIONS = [
  {
    tag: '0000_create_parts',
    when: 1_700_000_000_000,
    sql: '-- oxy:deploy-phase=pre\nCREATE TABLE "parts" ("id" text PRIMARY KEY);',
  },
  {
    tag: '0001_add_part_label',
    when: 1_700_000_001_000,
    sql: '-- oxy:deploy-phase=pre\nALTER TABLE "parts" ADD COLUMN "label" text;\n--> statement-breakpoint\nCREATE INDEX "parts_label_idx" ON "parts" ("label");',
  },
  {
    tag: '0002_drop_part_label',
    when: 1_700_000_002_000,
    sql: '-- oxy:deploy-phase=post\nALTER TABLE "parts" DROP COLUMN "label";',
  },
];

function writeParityFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'oxydb-driver-parity-'));
  mkdirSync(join(folder, 'meta'));
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: PARITY_MIGRATIONS.map((file, idx) => ({
        idx,
        version: '7',
        when: file.when,
        tag: file.tag,
        breakpoints: true,
      })),
    }),
  );
  for (const file of PARITY_MIGRATIONS) {
    writeFileSync(join(folder, `${file.tag}.sql`), file.sql);
  }
  return folder;
}

/** The whole ledger, every column drizzle writes, in insertion order. */
async function ledgerRows(databaseUrl: string): Promise<Record<string, unknown>[]> {
  const live = openLiveClient(databaseUrl, 'postgres-js');
  try {
    const [ledger] = await live.query<{ present: boolean }>(
      "select to_regclass('drizzle.__drizzle_migrations') is not null as present",
    );
    if (!ledger?.present) return [];
    return (
      await live.query('select id, hash, created_at from drizzle.__drizzle_migrations order by id')
    ).map((row) => ({ ...row }));
  } finally {
    await live.close();
  }
}

describeLiveBun('ledger parity between postgres-js and bun-sql (live Postgres, Bun only)', () => {
  let folder = '';
  const created: string[] = [];

  beforeAll(() => {
    folder = writeParityFolder();
  });

  afterAll(async () => {
    for (const url of created) await dropTestDatabase(url);
    if (folder) rmSync(folder, { recursive: true, force: true });
  }, 60_000);

  async function migrated(
    runs: ReadonlyArray<{ driver: DatabaseDriver; run: 'pre' | 'post' | 'all' }>,
  ): Promise<string> {
    const url = await createTestDatabase({ adminUrl: ADMIN_URL });
    created.push(url);
    for (const { driver, run } of runs) {
      await runMigrations({
        databaseUrl: url,
        driver,
        migrationsFolder: folder,
        extensions: [],
        run,
        expectedDatabase: bareDatabaseName(url),
        dryRun: false,
        logger: silentLogger,
      });
    }
    return url;
  }

  it('writes identical ledger rows from either driver', async () => {
    const viaPostgres = await ledgerRows(await migrated([{ driver: 'postgres-js', run: 'all' }]));
    const viaBun = await ledgerRows(await migrated([{ driver: 'bun-sql', run: 'all' }]));

    // Floor: identical EMPTY ledgers would make the equality vacuous.
    expect(viaPostgres).toHaveLength(PARITY_MIGRATIONS.length);
    expect(viaBun).toEqual(viaPostgres);
  }, 60_000);

  it('stops a `pre` run at the same place on either driver', async () => {
    const viaPostgres = await ledgerRows(await migrated([{ driver: 'postgres-js', run: 'pre' }]));
    const viaBun = await ledgerRows(await migrated([{ driver: 'bun-sql', run: 'pre' }]));

    expect(viaPostgres).toHaveLength(2);
    expect(viaBun).toEqual(viaPostgres);
  }, 60_000);

  it('lets either driver finish a database the other one started', async () => {
    const reference = await ledgerRows(await migrated([{ driver: 'postgres-js', run: 'all' }]));
    const bunFinishes = await ledgerRows(
      await migrated([
        { driver: 'postgres-js', run: 'pre' },
        { driver: 'bun-sql', run: 'post' },
      ]),
    );
    const postgresFinishes = await ledgerRows(
      await migrated([
        { driver: 'bun-sql', run: 'pre' },
        { driver: 'postgres-js', run: 'post' },
      ]),
    );

    expect(reference).toHaveLength(PARITY_MIGRATIONS.length);
    expect(bunFinishes).toEqual(reference);
    expect(postgresFinishes).toEqual(reference);
  }, 60_000);

  it('refuses the wrong target on bun-sql before writing anything', async () => {
    const url = await createTestDatabase({ adminUrl: ADMIN_URL });
    created.push(url);
    await expect(
      runMigrations({
        databaseUrl: url,
        driver: 'bun-sql',
        migrationsFolder: folder,
        extensions: [],
        run: 'all',
        expectedDatabase: 'definitely_not_this_database',
        dryRun: false,
        logger: silentLogger,
      }),
    ).rejects.toThrow(WrongMigrationTargetError);
    // Not even the ledger table: the guard ran first.
    expect(await ledgerRows(url)).toEqual([]);
  }, 60_000);
});

describeNode('driver bun-sql under Node', () => {
  it('createDatabase refuses with a sentence about the configuration', () => {
    expect(() =>
      createDatabase({ databaseUrl: 'postgres://unused/db', schema: {}, driver: 'bun-sql' }),
    ).toThrow(/needs the Bun runtime/);
  });

  it('runMigrations refuses the same way, after its filesystem checks', async () => {
    const folder = writeParityFolder();
    try {
      await expect(
        runMigrations({
          databaseUrl: 'postgres://unused/db',
          driver: 'bun-sql',
          migrationsFolder: folder,
          extensions: [],
          run: 'all',
          dryRun: false,
          logger: silentLogger,
        }),
      ).rejects.toThrow(/needs the Bun runtime/);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
