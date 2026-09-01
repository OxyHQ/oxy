/**
 * PostGIS — the prerequisite, and the coordinate ordering it exists to fix.
 *
 * Every assertion runs against a REAL PostGIS through the application's own
 * pool. Two independent things are held here, and they fail for different
 * reasons on purpose:
 *
 * 1. **The extension is present before any migration needs it.** This is not
 *    free with the right docker image: `postgis/postgis` seeds PostGIS into
 *    `$POSTGRES_DB` and a `template_postgis` template, NOT into `template1`,
 *    and every throwaway test database is created from `template1`. So this
 *    passing means `bun run db:migrate` really did run
 *    `scripts/ensure-extensions.ts` first — remove that half of the script and
 *    this goes red (and the migration itself fails with `type "geography" does
 *    not exist`).
 *
 * 2. **The generated point is built as (longitude, latitude).** Reading that
 *    pair backwards is the ORIGINAL bug — Mongo's 2dsphere index read
 *    `{lat, lon}` positionally as `[lon, lat]`, so it has almost certainly had
 *    every point transposed for its whole life. A transposition does not throw:
 *    it yields a perfectly valid point in the wrong hemisphere, so a test that
 *    only asserts "a row came back" passes against the exact bug being fixed.
 *    The assertions below therefore pin the ordering two ways: axis by axis
 *    (`ST_X` must be the longitude column, `ST_Y` the latitude column), and
 *    against a real-world distance computed OUTSIDE PostGIS.
 *
 * The expression under test is READ FROM the schema object — never copied — so
 * editing `GEO_EXPRESSION` in `schema/userLocations.ts` moves this test with it.
 *
 * The probe table is here because `user_locations.geo`'s migration is generated
 * centrally (see the migration contract) rather than on this branch, so the
 * column is not in `drizzle/` yet. The probe is built from the same declaration
 * the real column will be: the schema's rendered expression, `stored`, plus a
 * GiST index.
 */

import { SQL, is, sql } from 'drizzle-orm';
import { IndexedColumn, PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { DATABASE_CASING, sqlColumnName } from '@oxyhq/db';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { REQUIRED_EXTENSIONS } from '../extensions';
import { userLocations } from '../schema/userLocations';

/**
 * A predefined, non-superuser role every Postgres 14+ cluster already has. It
 * stands in for a managed-database application role that is NOT `rds_superuser`
 * — used via `SET LOCAL ROLE` inside a rolled-forward transaction, so the test
 * creates nothing and leaves nothing behind on the server.
 */
const UNPRIVILEGED_ROLE = 'pg_read_all_data';

/** Barcelona, Plaça de Catalunya: degrees north, degrees east. */
const BARCELONA = { latitude: 41.3851, longitude: 2.1734 };
/** Madrid, Puerta del Sol: degrees north, degrees WEST — hence a negative longitude. */
const MADRID = { latitude: 40.4168, longitude: -3.7038 };

/**
 * Barcelona↔Madrid, in metres, computed OUTSIDE PostGIS: haversine on the IUGG
 * mean Earth radius (6 371 008.8 m) over the two pairs above gives 505 444 m,
 * which agrees with the published ~505 km straight-line figure.
 *
 * PostGIS measures on the WGS 84 SPHEROID and answers 506 649 m — 0.24% higher,
 * the expected sphere/spheroid gap. Transposing the pairs puts both points in
 * the Indian Ocean and the same measurement becomes 662 317 m, 31% out. So the
 * tolerance below separates "correct" from "transposed" with two orders of
 * magnitude of margin: it is a real discriminator, not a rounding allowance.
 */
const BARCELONA_MADRID_METRES = 505_444;
/** Fractional tolerance: comfortably over the 0.24% model gap, far under the 31% bug. */
const DISTANCE_TOLERANCE = 0.02;

/** Rows in the probe table — enough for the planner to prefer the GiST index. */
const PROBE_ROW_COUNT = 2000;

const PROBE_TABLE = 'postgis_geo_probe';

/**
 * The generating expression exactly as the schema declares it, rendered through
 * drizzle's own dialect so this cannot drift from the DDL drizzle-kit emits.
 */
function renderGeoExpression(): string {
  const generated = userLocations.geo.generated;
  if (!generated) {
    throw new Error(
      'user_locations.geo is not a generated column. The whole point of the ' +
      'column is that no write path can produce a point disagreeing with its ' +
      'latitude/longitude — a plain column reopens that divergence.'
    );
  }
  const { as } = generated;
  if (!is(as, SQL)) {
    throw new Error('user_locations.geo must be generated from a SQL expression.');
  }
  const query = new PgDialect({ casing: DATABASE_CASING }).sqlToQuery(as);
  if (query.params.length > 0) {
    throw new Error(
      'The geo expression carries bound parameters, which a generated column ' +
      'cannot take. It must be literal SQL over the table\'s own columns.'
    );
  }
  return query.sql;
}

beforeAll(async () => {
  await connectPostgres();
  const db = getDb();
  await db.execute(
    sql.raw(
      `create table ${PROBE_TABLE} (
         id text primary key,
         latitude double precision,
         longitude double precision,
         geo geography generated always as (${renderGeoExpression()}) stored
       )`
    )
  );
  await db.execute(sql.raw(`create index ${PROBE_TABLE}_geo_idx on ${PROBE_TABLE} using gist (geo)`));
  await db.execute(sql`
    insert into ${sql.identifier(PROBE_TABLE)} (id, latitude, longitude)
    values
      ('barcelona', ${BARCELONA.latitude}, ${BARCELONA.longitude}),
      ('madrid', ${MADRID.latitude}, ${MADRID.longitude}),
      ('no-coordinates', null, null)
  `);
  // Spread over Europe so the planner has a realistic distribution to index.
  await db.execute(sql.raw(
    `insert into ${PROBE_TABLE} (id, latitude, longitude)
     select g::text, 36 + (g % 340) * 0.1, -10 + (g % 400) * 0.1
     from generate_series(1, ${PROBE_ROW_COUNT}) g`
  ));
  await db.execute(sql.raw(`analyze ${PROBE_TABLE}`));
});

afterAll(async () => {
  await getDb().execute(sql.raw(`drop table if exists ${PROBE_TABLE}`));
  await closePostgres();
});

describe('PostGIS extension prerequisite', () => {
  it('is installed in the throwaway database, which template1 never seeds', async () => {
    const rows = await getDb().execute<{ extname: string }>(sql`
      select extname from pg_extension order by extname
    `);
    const installed = rows.map((row) => row.extname);

    for (const extension of REQUIRED_EXTENSIONS) {
      expect(installed).toContain(extension.name);
    }
    // A registry that emptied out would make the loop above vacuously true.
    expect(REQUIRED_EXTENSIONS.length).toBeGreaterThan(0);
  });

  it('states why each extension is required', () => {
    for (const extension of REQUIRED_EXTENSIONS) {
      expect(extension.reason.length).toBeGreaterThan(0);
    }
  });

  it('can be re-run by a role with no privilege to create it', async () => {
    // The claim this pins is the one a managed database rests on: once someone
    // privileged has installed the extension, `CREATE EXTENSION IF NOT EXISTS`
    // short-circuits on the duplicate check BEFORE the privilege check, so the
    // migration role does not need `rds_superuser`. If that were false, every
    // migration on RDS would fail at this step.
    const db = getDb();
    const [role] = await db.execute<{ rolsuper: boolean }>(sql`
      select rolsuper from pg_roles where rolname = ${UNPRIVILEGED_ROLE}
    `);
    expect(role).toBeDefined();
    expect(role.rolsuper).toBe(false);

    await db.transaction(async (tx) => {
      // SET LOCAL so the role reverts at the end of this transaction, and so
      // every statement below runs on the SAME pooled connection.
      await tx.execute(sql.raw(`set local role ${UNPRIVILEGED_ROLE}`));
      const [current] = await tx.execute<{ current_user: string }>(sql`select current_user`);
      expect(current.current_user).toBe(UNPRIVILEGED_ROLE);

      for (const extension of REQUIRED_EXTENSIONS) {
        await tx.execute(sql.raw(`create extension if not exists "${extension.name}"`));
      }
    });
  });
});

describe('user_locations.geo', () => {
  it('is generated always, stored — not a column any write path supplies', () => {
    const generated = userLocations.geo.generated;
    expect(generated?.type).toBe('always');
    expect(generated?.mode).toBe('stored');
  });

  it('has a GiST index, which is the only thing a distance search can use', () => {
    // An index built with `.using(...)` holds `IndexedColumn`s, whose `.name` is
    // the TypeScript PROPERTY name — compared here against the column object's
    // own property name, never against a literal, so a rename moves both.
    const geoIndexes = getTableConfig(userLocations).indexes.filter((index) =>
      index.config.columns.some(
        (column) => is(column, IndexedColumn) && column.name === userLocations.geo.name
      )
    );

    expect(geoIndexes).toHaveLength(1);
    expect(geoIndexes[0].config.method).toBe('gist');
  });

  it('derives the point from the latitude and longitude columns by their SQL names', () => {
    const expression = renderGeoExpression();

    expect(expression).toContain(sqlColumnName(userLocations.latitude));
    expect(expression).toContain(sqlColumnName(userLocations.longitude));
  });

  it('puts LONGITUDE on the x axis and LATITUDE on the y axis', async () => {
    // The direct statement of the ordering: transposing the arguments swaps
    // these two values and this fails naming both.
    const rows = await getDb().execute<{
      id: string;
      st_x: number;
      st_y: number;
      longitude: number;
      latitude: number;
    }>(sql.raw(
      `select id,
              ST_X(geo::geometry) as st_x, longitude,
              ST_Y(geo::geometry) as st_y, latitude
       from ${PROBE_TABLE}
       where id in ('barcelona', 'madrid')
       order by id`
    ));

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.st_x).toBeCloseTo(row.longitude, 9);
      expect(row.st_y).toBeCloseTo(row.latitude, 9);
    }
  });

  it('measures a real-world distance that matches an independent computation', async () => {
    const [row] = await getDb().execute<{ metres: number }>(sql.raw(
      `select ST_Distance(b.geo, m.geo) as metres
       from ${PROBE_TABLE} b, ${PROBE_TABLE} m
       where b.id = 'barcelona' and m.id = 'madrid'`
    ));

    const drift = Math.abs(Number(row.metres) - BARCELONA_MADRID_METRES) / BARCELONA_MADRID_METRES;
    expect(drift).toBeLessThan(DISTANCE_TOLERANCE);
  });

  it('lands the points inside Spain rather than in the Indian Ocean', async () => {
    // A transposition is a valid point, so the hemisphere is the tell.
    const rows = await getDb().execute<{ id: string; inside: boolean }>(sql.raw(
      `select id,
              ST_Within(geo::geometry, ST_MakeEnvelope(-9.5, 35.9, 3.4, 43.8, 4326)) as inside
       from ${PROBE_TABLE}
       where id in ('barcelona', 'madrid')
       order by id`
    ));

    expect(rows.map((row) => row.inside)).toEqual([true, true]);
  });

  it('stores a Point at SRID 4326 — the cast promotes ST_MakePoint\'s SRID 0', async () => {
    const rows = await getDb().execute<{ geom_type: string; srid: number }>(sql.raw(
      `select ST_GeometryType(geo::geometry) as geom_type, ST_SRID(geo) as srid
       from ${PROBE_TABLE} where id = 'barcelona'`
    ));

    expect(rows[0].geom_type).toBe('ST_Point');
    expect(Number(rows[0].srid)).toBe(4326);
  });

  it('is NULL when the coordinate pair is absent, never a point at (0, 0)', async () => {
    const rows = await getDb().execute<{ geo_is_null: boolean }>(sql.raw(
      `select geo is null as geo_is_null from ${PROBE_TABLE} where id = 'no-coordinates'`
    ));

    expect(rows[0].geo_is_null).toBe(true);
  });

  it('refuses a write, so it can never disagree with its coordinates', async () => {
    await expect(
      getDb().execute(sql.raw(
        `update ${PROBE_TABLE} set geo = ST_MakePoint(0, 0)::geography where id = 'barcelona'`
      ))
      // Drizzle wraps the driver error, so the SQLSTATE is on `cause`.
    ).rejects.toMatchObject({ cause: { code: '428C9' } });
  });

  it('is searched through the GiST index by a real ST_DWithin query', async () => {
    const plan = await getDb().execute<{ 'QUERY PLAN': string }>(sql.raw(
      `explain (costs off)
       select id from ${PROBE_TABLE}
       where ST_DWithin(geo, ST_MakePoint(${BARCELONA.longitude}, ${BARCELONA.latitude})::geography, 50000)`
    ));
    const text = plan.map((row) => row['QUERY PLAN']).join('\n');

    expect(text).toContain(`${PROBE_TABLE}_geo_idx`);
    expect(text).not.toContain('Seq Scan');
  });
});
