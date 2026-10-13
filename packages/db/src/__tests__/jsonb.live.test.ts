/**
 * drizzle `jsonb()` writes, asked of the SERVER, on the selected driver.
 *
 * drizzle's `jsonb()` column `JSON.stringify`s a value before handing it to the
 * driver. On a PREPARED statement `Bun.SQL` (1.4.3) learns from the server that
 * the parameter is `jsonb` and JSON-encodes that string a second time, so the
 * row lands as a jsonb STRING holding the JSON text: `{"a":1}` is stored as
 * `"{\"a\":1}"`. drizzle's reader `JSON.parse`s the string back, so a test that
 * only round-trips through drizzle reads the original value on either driver
 * and passes; `jsonb_typeof`, `->` and `@>` on the server see the truth. That
 * is why every claim below is checked on the server, through an independent
 * postgres.js connection, and not by reading the row back through the writer.
 *
 * `@oxy.so/db` therefore opens every `Bun.SQL` client unprepared and refuses
 * `prepare: true` (see `openBunSqlClient`). The last block holds the reason in
 * place: while raw prepared `Bun.SQL` still double-encodes, the refusal stays.
 *
 * postgres.js is the baseline: the same suite runs on it under Jest and under
 * `bun test` (`OXYDB_TEST_DRIVER=postgres-js`), and on `Bun.SQL` under
 * `OXYDB_TEST_DRIVER=bun-sql`. Skipped without `OXYDB_TEST_ADMIN_URL`.
 */

import { eq, sql } from 'drizzle-orm';
import { jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createDatabase } from '../database';
import type { BunSqlClient, BunSqlClientOptions, DatabaseDriver } from '../driver';
import { createTestDatabase, dropTestDatabase } from '../testing';
import { IS_BUN, TEST_DRIVER, openLiveClient } from './support/liveDriver';

const ADMIN_URL = process.env.OXYDB_TEST_ADMIN_URL;
const describeLive = ADMIN_URL ? describe : describe.skip;
const describeLiveBun = ADMIN_URL && IS_BUN ? describe : describe.skip;
const describeBun = IS_BUN ? describe : describe.skip;

const docs = pgTable('jsonb_docs', {
  id: text().primaryKey(),
  doc: jsonb(),
});

const DDL = 'create table jsonb_docs (id text primary key, doc jsonb)';

/** Each jsonb value shape a schema stores, with the type the server must report for it. */
const ROWS: ReadonlyArray<{ id: string; doc: unknown; type: string | null }> = [
  {
    id: 'object',
    doc: {
      kind: 'widget',
      name: 'first',
      nested: { n: 1.5, list: [1, 'x', null, true] },
      text: 'ñ 😀 "quoted" \\ back\nline',
    },
    type: 'object',
  },
  { id: 'array', doc: [1, 'two', { three: 3 }], type: 'array' },
  { id: 'string', doc: 'just a string', type: 'string' },
  // A string that happens to be JSON text is still a STRING: the server must
  // not be handed it as JSON to parse.
  { id: 'jsonLikeString', doc: '{"looks":"like json"}', type: 'string' },
  { id: 'number', doc: 42, type: 'number' },
  { id: 'null', doc: null, type: null },
];

function openHandle(databaseUrl: string, driver: DatabaseDriver) {
  const schema = { docs };
  if (driver === 'bun-sql') {
    const { db, client } = createDatabase({ databaseUrl, schema, driver, client: { max: 1 } });
    return { db, close: () => client.close({ timeout: 5 }) };
  }
  const { db, client } = createDatabase({ databaseUrl, schema, client: { max: 1 } });
  return { db, close: () => client.end({ timeout: 5 }) };
}

describeLive(
  `drizzle jsonb() writes on ${TEST_DRIVER}, asked of the server (live Postgres)`,
  () => {
    let url: string | undefined;
    let handle: ReturnType<typeof openHandle> | undefined;

    beforeAll(async () => {
      url = await createTestDatabase({
        adminUrl: ADMIN_URL,
        driver: TEST_DRIVER,
        migrate: async (databaseUrl) => {
          const admin = openLiveClient(databaseUrl, 'postgres-js');
          try {
            await admin.exec(DDL);
          } finally {
            await admin.close();
          }
        },
      });
      handle = openHandle(url, TEST_DRIVER);
      await handle.db.insert(docs).values(ROWS.map(({ id, doc }) => ({ id, doc })));
    }, 60_000);

    afterAll(async () => {
      await handle?.close();
      if (url) await dropTestDatabase(url, { driver: TEST_DRIVER });
    }, 60_000);

    function db() {
      if (handle === undefined) throw new Error('beforeAll did not open the handle.');
      return handle.db;
    }

    /** Server truth, read through postgres.js whatever the writer was. */
    async function server<TRow extends Record<string, unknown>>(query: string): Promise<TRow[]> {
      if (url === undefined) throw new Error('beforeAll did not create the database.');
      const reader = openLiveClient(url, 'postgres-js');
      try {
        return await reader.query<TRow>(query);
      } finally {
        await reader.close();
      }
    }

    it('stores each value as the jsonb type it is, not as a string of it', async () => {
      const stored = await server<{ id: string; type: string | null }>(
        'select id, jsonb_typeof(doc) as type from jsonb_docs',
      );
      expect(stored).toHaveLength(ROWS.length);
      const byId = Object.fromEntries(stored.map((row) => [row.id, row.type]));
      expect(byId).toEqual(Object.fromEntries(ROWS.map((row) => [row.id, row.type])));
    });

    it('answers -> and ->> on the server', async () => {
      const [object] = await server<{ name: string; n: string; first: string }>(
        `select doc->>'name' as name, doc->'nested'->>'n' as n, doc->'nested'->'list'->>1 as first
       from jsonb_docs where id = 'object'`,
      );
      expect(object).toEqual({ name: 'first', n: '1.5', first: 'x' });
      const [array] = await server<{ second: string; three: string }>(
        `select doc->>1 as second, doc->2->>'three' as three from jsonb_docs where id = 'array'`,
      );
      expect(array).toEqual({ second: 'two', three: '3' });
    });

    it('answers @> on the server', async () => {
      const ids = async (needle: string) =>
        (
          await server<{ id: string }>(
            `select id from jsonb_docs where doc @> '${needle}'::jsonb order by id`,
          )
        ).map((row) => row.id);
      expect(await ids('{"kind":"widget"}')).toEqual(['object']);
      expect(await ids('{"nested":{"list":[true]}}')).toEqual(['object']);
      expect(await ids('[{"three":3}]')).toEqual(['array']);
      expect(await ids('"just a string"')).toEqual(['string']);
    });

    it('answers -> and @> through drizzle, with the needle bound as a parameter', async () => {
      const needle = JSON.stringify({ nested: { n: 1.5 } });
      const rows = await db()
        .select({ id: docs.id, name: sql<string>`${docs.doc}->>'name'` })
        .from(docs)
        .where(sql`${docs.doc} @> ${needle}::jsonb`);
      expect(rows).toEqual([{ id: 'object', name: 'first' }]);
    });

    it('reads every value back through drizzle as written', async () => {
      // The check that CANNOT see the defect on its own (a double-encoded row
      // reads back fine); kept so a regression on the read side is caught too.
      //
      // `jsonLikeString` is left out on purpose: drizzle's jsonb reader
      // `JSON.parse`s any string the driver hands it, so a jsonb STRING whose
      // text is itself JSON reads back as the parsed object on BOTH drivers.
      // That is the same reader behaviour that hides a double-encoded write, and
      // a drizzle quirk this package does not own; the server-side checks above
      // prove the row is stored as the string it is.
      const rows = await db().select().from(docs);
      const byId = Object.fromEntries(
        rows.filter((row) => row.id !== 'jsonLikeString').map((row) => [row.id, row.doc]),
      );
      expect(byId).toEqual(
        Object.fromEntries(
          ROWS.filter((row) => row.id !== 'jsonLikeString').map((row) => [row.id, row.doc]),
        ),
      );
    });

    it('stores an UPDATEd value as its own type too', async () => {
      await db()
        .update(docs)
        .set({ doc: { updated: true, by: TEST_DRIVER } })
        .where(eq(docs.id, 'number'));
      const [row] = await server<{ type: string; by: string }>(
        `select jsonb_typeof(doc) as type, doc->>'by' as by from jsonb_docs where id = 'number'`,
      );
      expect(row).toEqual({ type: 'object', by: TEST_DRIVER });
    });
  },
);

describeBun('createDatabase on bun-sql refuses prepare: true', () => {
  it('throws before opening a connection, naming the defect', () => {
    expect(() =>
      createDatabase({
        databaseUrl: 'postgres://unused/db',
        schema: {},
        driver: 'bun-sql',
        // A JS caller, or a cast: the type already forbids it.
        client: { prepare: true } as unknown as BunSqlClientOptions,
      }),
    ).toThrow(/prepare: true/);
  });
});

describeLiveBun('why: raw prepared Bun.SQL double-encodes a string bound to jsonb', () => {
  // If this starts failing, Bun has fixed the encoding and the `prepare: true`
  // refusal in `openBunSqlClient` can be revisited; until then it stays.
  let url: string | undefined;

  beforeAll(async () => {
    url = await createTestDatabase({ adminUrl: ADMIN_URL });
  }, 60_000);

  afterAll(async () => {
    if (url) await dropTestDatabase(url);
  }, 60_000);

  it('stores the JSON text as a jsonb string when prepared, and as an object when not', async () => {
    if (url === undefined) throw new Error('beforeAll did not create the database.');
    const { SQL } = Reflect.get(globalThis, 'Bun') as {
      SQL: new (url: string, options: Record<string, unknown>) => BunSqlClient;
    };
    const text = JSON.stringify({ a: 1 });
    const typeOf = async (prepare: boolean) => {
      const client = new SQL(url as string, { max: 1, adapter: 'postgres', prepare });
      try {
        const [row] = await client<{ type: string }[]>`select jsonb_typeof(${text}::jsonb) as type`;
        return row?.type;
      } finally {
        await client.close({ timeout: 5 });
      }
    };
    expect(await typeOf(true)).toBe('string');
    expect(await typeOf(false)).toBe('object');
  });
});
