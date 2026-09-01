/**
 * Postgres harness integration test.
 *
 * Every assertion here queries a REAL Postgres through the application's own
 * `connectPostgres()` — there is no mock. If the throwaway database is missing,
 * unmigrated, or unreachable, these fail; that is the point. Each `it` is
 * pinned to a distinct link in the chain so a failure names which link broke:
 *
 *   1. global setup created a throwaway database and published its URL
 *   2. the app's own pool opens against THAT database, not a developer's
 *   3. `bun run db:migrate` actually ran (drizzle's bookkeeping table exists)
 *   4. a real write survives a real read back
 *   5. the health check backing GET /health reports a live database
 */

import { sql } from 'drizzle-orm';
import { checkPostgresHealth, closePostgres, connectPostgres, getDb } from '../../config/postgres';

/** Global setup names every throwaway database with this prefix. */
const TEST_DATABASE_PREFIX = 'oxy_test_';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('Postgres test harness', () => {
  it('publishes a throwaway DATABASE_URL from global setup', () => {
    const url = process.env.DATABASE_URL;
    expect(url).toBeDefined();
    // `?? ''` keeps the failure on the assertion above rather than a TypeError.
    expect(new URL(url ?? '').pathname).toMatch(
      new RegExp(`^/${TEST_DATABASE_PREFIX}[0-9a-f]{16}$`)
    );
  });

  it('opens the application pool against that throwaway database', async () => {
    const rows = await getDb().execute<{ current_database: string }>(
      sql`select current_database()`
    );
    const connectedTo = rows[0].current_database;

    expect(connectedTo).toMatch(new RegExp(`^${TEST_DATABASE_PREFIX}[0-9a-f]{16}$`));
    expect(`/${connectedTo}`).toBe(new URL(process.env.DATABASE_URL ?? '').pathname);
  });

  it('applied the migrations — drizzle bookkeeping exists', async () => {
    const rows = await getDb().execute<{ exists: boolean }>(sql`
      select exists (
        select 1 from information_schema.tables
        where table_schema = 'drizzle' and table_name = '__drizzle_migrations'
      ) as exists
    `);

    expect(rows[0].exists).toBe(true);
  });

  it('round-trips a real write through the drizzle connection', async () => {
    const db = getDb();
    await db.execute(sql`create table harness_probe (id text primary key, note text not null)`);
    try {
      await db.execute(sql`insert into harness_probe (id, note) values ('a', 'written')`);
      const rows = await db.execute<{ id: string; note: string }>(
        sql`select id, note from harness_probe order by id`
      );

      expect(rows).toEqual([{ id: 'a', note: 'written' }]);
    } finally {
      await db.execute(sql`drop table harness_probe`);
    }
  });

  it('reports healthy through the GET /health probe', async () => {
    await expect(checkPostgresHealth()).resolves.toBe(true);
  });
});
