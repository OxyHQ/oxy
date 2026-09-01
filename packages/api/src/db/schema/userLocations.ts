/**
 * `user_locations` — a place a user saved on their profile.
 *
 * Ported from the `locations` array embedded in `models/User.ts`.
 *
 * A child table was not a judgement call: SEVEN indexes hung off `locations.*`
 * paths, including a text index and a 2dsphere. `address.*` and `metadata.*`
 * flatten to columns for the same reason — they are indexed, and `jsonb` cannot
 * serve an indexed path without a hand-written expression index per path.
 *
 * ## Coordinates are ported as a FIX, not replicated
 *
 * Mongo stored `{ lat, lon }` and indexed it with `2dsphere`. A 2dsphere index
 * over an object reads the pair POSITIONALLY as `[longitude, latitude]` — the
 * first field is longitude — so the live index has almost certainly had every
 * point transposed for its whole life. Two NAMED columns make that class of bug
 * unrepresentable: there is no ordering left to get wrong.
 *
 * ## The spatial index is PostGIS, and the point is GENERATED
 *
 * `geo` is a PostGIS `geography` point (WGS 84 / SRID 4326) with a GiST index,
 * which is what `findLocationsNear` (`locationQueryService.ts:29`) needs to
 * become `ST_DWithin` / `ST_Distance` instead of a hand-rolled haversine. See
 * `geography` below for why the column type carries no `(Point,4326)` typmod.
 *
 * It is `GENERATED ALWAYS AS … STORED`, never a column any write path supplies,
 * and that shape is the whole reason it is safe. A hand-written geo column and
 * the two coordinate columns are two representations of one fact, so they can
 * disagree — and the ORIGINAL bug here was exactly a coordinate-ordering
 * mistake, the kind that produces a plausible point in the wrong hemisphere
 * rather than an error. Deriving the point in the schema makes divergence
 * unrepresentable (a write to `geo` fails with SQLSTATE `428C9`) and states the
 * `(longitude, latitude)` order in ONE place, once, where the compiler and the
 * database both see it.
 *
 * The expression is legal in a generated column because every part of it is
 * IMMUTABLE — verified against this PostGIS version rather than assumed:
 * `st_makepoint(double precision, double precision)` and the
 * `geometry → geography` cast both report `provolatile = 'i'` in `pg_proc`
 * (PostGIS 3.5.2 / PostgreSQL 17.5). The cast also promotes `ST_MakePoint`'s
 * SRID 0 to geography's 4326, and `ST_MakePoint` is strict, so a row with no
 * coordinates gets `geo IS NULL` rather than a point at (0, 0) in the Gulf of
 * Guinea.
 *
 * PostGIS itself is a prerequisite of the whole migration rather than of this
 * table: `db/extensions.ts` creates it as the first half of `bun run db:migrate`
 * so it cannot be ordered after a migration that names the `geography` type.
 *
 * The location DATA is live independently of the spatial index — people search
 * matches on `name`, `city` and `country` (`utils/profileQuery.ts:97-102`, via
 * `routes/search.ts:45`), which is why the non-spatial indexes below stay.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  doublePrecision,
  index,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, tsvector, updatedAt } from '@oxyhq/db';
import { users } from './users';

/**
 * `geography` — a location on the WGS 84 spheroid, which is what makes
 * `ST_DWithin` and `ST_Distance` answer in METRES rather than in degrees.
 * (`geometry`, which drizzle DOES ship a builder for, measures in units of the
 * SRID — degrees for 4326 — so it is not a substitute here.)
 *
 * Declared in this file rather than reusing `@oxyhq/db`'s own `geography`
 * export — kept separate for now since this is the only spatial column in
 * this schema; worth revisiting if a second one lands.
 * The TypeScript type is the `string` Postgres renders the value as (WKB hex),
 * and there is deliberately no `toDriver` direction: the column is GENERATED,
 * so no application code ever writes it, and giving it a write path would
 * invite exactly the hand-maintained geo column this design exists to prevent.
 *
 * **Why the type carries no `(Point,4326)` typmod.** drizzle-kit emits a column
 * type verbatim only when it starts with one of a hardcoded list of names
 * (`sqlgenerator.ts` `parseType`); anything else is wrapped in double quotes as
 * a single identifier. That list contains `geometry` but not `geography`
 * (drizzle-kit 0.31.10 / drizzle-orm 0.45.2 — the current latest of both), so
 * `geography(Point,4326)` is emitted as `"geography(Point,4326)"` and the
 * migration fails with `type "geography(Point,4326)" does not exist`. A quoted
 * bare `"geography"` resolves normally, so that is what is declared.
 *
 * Nothing is lost that this table relies on. A typmod constrains what may be
 * WRITTEN, and nothing may be written here at all: every value is produced by
 * `GEO_EXPRESSION`, so it is a Point, and the cast promotes SRID 0 to 4326.
 * Both of those are asserted against stored rows on the running PostGIS version
 * in `db/__tests__/postgis.test.ts` rather than assumed from the declaration —
 * which is a stronger guarantee than the typmod, since it is measured.
 */
const geography = customType<{ data: string; driverData: string }>({
  dataType: () => 'geography',
});

/**
 * The one place the coordinate ORDER is written down.
 *
 * `ST_MakePoint` takes (x, y) — that is (longitude, latitude), the opposite of
 * how humans say a coordinate — and reading it backwards is the exact bug
 * inherited from Mongo's 2dsphere index. Because the column is generated from
 * this expression, no write path can reintroduce the transposition: every row's
 * point is derived from the NAMED columns, by this expression, or it does not
 * exist.
 *
 * The column names are spelled in SQL for the same reason as
 * `SEARCH_VECTOR_EXPRESSION` below: a generated expression is built before the
 * table object exists, so there are no drizzle columns to interpolate.
 */
const GEO_EXPRESSION = sql.raw('ST_MakePoint(longitude, latitude)::geography');

/** What the user calls this place. */
export const USER_LOCATION_TYPES = ['home', 'work', 'school', 'other'] as const;

/**
 * The text-search configuration behind `search_vector`, matching the Mongo text
 * index's `default_language: "en"`. A LITERAL, because the one-argument
 * `to_tsvector` is STABLE and Postgres refuses it in a generated column.
 */
const SEARCH_CONFIGURATION = 'english';

/**
 * `name` + `formatted_address`, the two fields Mongo's text index covered.
 *
 * The column names are spelled in SQL here because a generated expression is
 * built before the table object exists, so there are no drizzle columns to
 * interpolate. That is the one place in this schema where a hand-written SQL
 * name is unavoidable — `__tests__/users.test.ts` asserts the resulting column
 * actually populates, so a name that drifts fails rather than silently indexing
 * nothing.
 */
const SEARCH_VECTOR_EXPRESSION = sql.raw(
  `to_tsvector('${SEARCH_CONFIGURATION}', ` +
    `coalesce(name, '') || ' ' || coalesce(formatted_address, ''))`
);

export const userLocations = pgTable(
  'user_locations',
  {
    id: generatedId(),
    /**
     * The owner. `CASCADE` — a saved place has no meaning without the profile
     * it was saved on.
     */
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * The client-supplied handle every call site addresses this row by
     * (`removeLocation(locationId)`, `updateLocationCoordinates(locationId, …)`),
     * carried over verbatim. It is NOT the primary key: it comes from the
     * client, so it is unique only within one user, which is what the index
     * below states.
     */
    locationKey: text().notNull(),
    name: text().notNull(),
    label: text(),
    type: text({ enum: USER_LOCATION_TYPES }).notNull().default('other'),

    // ---- address ----------------------------------------------------------
    street: text(),
    streetNumber: text(),
    streetDetails: text(),
    postalCode: text(),
    city: text(),
    state: text(),
    country: text(),
    formattedAddress: text(),

    // ---- coordinates ------------------------------------------------------
    /** Degrees north, [-90, 90]. NAMED, so it can never be read as a longitude. */
    latitude: doublePrecision(),
    /** Degrees east, [-180, 180]. */
    longitude: doublePrecision(),
    /**
     * GENERATED — the spatial form of the pair above, and the only thing the
     * GiST index and `ST_DWithin` can use. NULL exactly when the pair is
     * absent. See `GEO_EXPRESSION`.
     */
    geo: geography().generatedAlwaysAs(GEO_EXPRESSION),

    // ---- geocoder metadata ------------------------------------------------
    placeId: text(),
    osmId: text(),
    osmType: text(),
    countryCode: text(),
    timezone: text(),

    /** GENERATED — the replacement for Mongo's text index on this table. */
    searchVector: tsvector().generatedAlwaysAs(SEARCH_VECTOR_EXPRESSION),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Leads with `user_id`, so it also answers every "this user's locations"
    // read — which is every read there is. No separate `user_id` index.
    uniqueIndex('user_locations_user_id_location_key_key').on(t.userId, t.locationKey),

    // Mongo declared seven indexes on these paths; three were redundant, since a
    // btree serves any leading prefix of a compound:
    //   {address.city}          — covered by (city, country)
    //   {type}                  — covered by (type, city)
    //   {address.country} is NOT covered by (city, country), so it stays.
    index('user_locations_city_country_idx').on(t.city, t.country),
    index('user_locations_country_idx').on(t.country),
    index('user_locations_type_city_idx').on(t.type, t.city),
    index('user_locations_country_code_city_idx').on(t.countryCode, t.city),
    // Mongo also indexed `locations.createdAt` and `locations.updatedAt`
    // descending. Dropped: nothing in the codebase orders or filters locations
    // by either, and an index nobody uses still costs every write.
    index('user_locations_search_vector_idx').using('gin', t.searchVector),
    // The only index a distance search can use. `geography` has a default GiST
    // operator class, so no opclass is named here; `EXPLAIN` on a real
    // `ST_DWithin` confirms the planner picks it (`db/__tests__/postgis.test.ts`).
    index('user_locations_geo_idx').using('gist', t.geo),
    // NOTE for the call-site port: these are ports of the indexes Mongo
    // declared, and they serve equality and prefix reads. The one live consumer
    // of this data — people search — matches with an UNANCHORED
    // case-insensitive substring pattern (`utils/profileQuery.ts:97-102`), which
    // none of them can serve, exactly as none of Mongo's could. It is a scan
    // today and it will be a scan on port. If it needs indexing, `pg_trgm` is
    // the tool and it is already available; do not assume these cover it.

    check(
      'user_locations_type_check',
      sql`${t.type} in (${sql.raw(USER_LOCATION_TYPES.map((value) => `'${value}'`).join(', '))})`
    ),
    // Mongo's `min`/`max` on the two coordinate paths.
    check(
      'user_locations_latitude_check',
      sql`${t.latitude} is null or (${t.latitude} >= -90 and ${t.latitude} <= 90)`
    ),
    check(
      'user_locations_longitude_check',
      sql`${t.longitude} is null or (${t.longitude} >= -180 and ${t.longitude} <= 180)`
    ),
    // Half a coordinate is not a place. Mongo permitted `{ lat }` with no `lon`,
    // and every consumer had to guard for it; here the pair is whole or absent.
    check(
      'user_locations_coordinates_complete_check',
      sql`(${t.latitude} is null) = (${t.longitude} is null)`
    ),
  ]
);
