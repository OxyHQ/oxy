/**
 * Location queries over `user_locations`.
 *
 * Ported from an aggregation pipeline that `$unwind`-ed the `locations` array
 * embedded in every user document. That array is a child table now
 * (`db/schema/userLocations.ts`), so the unwind IS the join and the seven
 * indexes Mongo hung off `locations.*` paths are real indexes.
 *
 * ## Two of these methods could not return a correct answer before the port
 *
 * Reported rather than quietly fixed, because both are the kind of defect that
 * looks like "no results" to a caller:
 *
 * 1. **`findLocationsNear` filtered on transposed points.** Mongo stored
 *    `{ lat, lon }` and the `$geoWithin: { $centerSphere: [[lon, lat], r] }`
 *    stage read that object POSITIONALLY as `[longitude, latitude]` — so the
 *    stored point was interpreted with its axes swapped, putting a Barcelona
 *    row in the Indian Ocean. The `$addFields` haversine that followed used the
 *    NAMED fields and was correct, so the pipeline intersected a wrong circle
 *    with a right one and returned (almost always) nothing. The `query` const at
 *    the top of that method, a `$near` that was never handed to anything, is
 *    gone with it.
 *
 * 2. **`searchLocationsByText` threw on every call.** `$text` is only legal in
 *    the FIRST stage of a pipeline, and the same `matchConditions` object —
 *    which always carried `$text` — was used again in a `$match` after
 *    `$unwind`. Mongo answers that with an error, so the endpoint has never
 *    returned a result.
 *
 * ## Where the ordering fix lives now
 *
 * `user_locations.geo` is `GENERATED ALWAYS AS (ST_MakePoint(longitude,
 * latitude)::geography) STORED`, so the `(longitude, latitude)` order is stated
 * ONCE, in the schema, and no write path can reintroduce the transposition —
 * the column is not writable at all (SQLSTATE `428C9`). The only ordering this
 * file can still get wrong is the QUERY POINT, which is why
 * `__tests__/locationQueryService.test.ts` seeds a deliberately transposed row
 * and requires it to be ABSENT from a search around the real one.
 *
 * Distances are `ST_DWithin` / `ST_Distance` on `geography`, which measure
 * METRES on the WGS 84 spheroid. Never a bounding box, and never
 * `earthdistance`/`cube` — a query that looks like a distance search while
 * answering a narrower question is the failure mode this table exists to avoid.
 */

import { and, asc, desc, eq, isNotNull, sql, type Column, type SQL } from 'drizzle-orm';
import { getDb } from '../config/postgres';
import { qualified } from '@oxyhq/db';
import { userLocations } from '../db/schema/userLocations';
import { users } from '../db/schema/users';
import { logger } from '../utils/logger';
import performanceMonitor from '../utils/performanceMonitor';

/**
 * The text-search configuration `user_locations.search_vector` is generated
 * with. A query must use the SAME one or its lexemes will not match the
 * stored ones.
 */
const SEARCH_CONFIGURATION = 'english';

/**
 * Terms honoured from one text query.
 *
 * Mongo's `$text` had no ceiling; a query is one bound parameter per term here,
 * so an unbounded term count is an unbounded statement. Thirty-two is far past
 * any real place name and is applied by truncation, so a normal search is
 * untouched.
 */
const MAX_SEARCH_TERMS = 32;

export interface LocationQueryOptions {
  limit?: number;
  skip?: number;
  type?: string;
  country?: string;
  city?: string;
}

/** A saved place, shaped exactly as the Mongo `locations` subdocument was. */
export interface LocationDto {
  /** The client-supplied handle, `locations[].id` in Mongo. */
  id: string;
  name: string;
  label?: string;
  type: string;
  address: {
    street?: string;
    streetNumber?: string;
    streetDetails?: string;
    postalCode?: string;
    city?: string;
    state?: string;
    country?: string;
    formattedAddress?: string;
  };
  /** Absent when the row has no coordinates — the pair is whole or absent. */
  coordinates?: { lat: number; lon: number };
  metadata: {
    placeId?: string;
    osmId?: string;
    osmType?: string;
    countryCode?: string;
    timezone?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

/** One row of every list this service returns: the owner plus their place. */
export interface LocationMatch {
  /** The OWNER's account id — Mongo projected the root document's `_id`. */
  _id: string;
  username?: string;
  location: LocationDto;
}

/** A {@link LocationMatch} with its great-circle distance from the query point. */
export interface NearbyLocationMatch extends LocationMatch {
  /** Metres on the WGS 84 spheroid, from `ST_Distance` on `geography`. */
  distance: number;
}

/** A {@link LocationMatch} with its text-search relevance. */
export interface ScoredLocationMatch extends LocationMatch {
  /** `ts_rank`, replacing Mongo's `$meta: "textScore"`. */
  score: number;
}

/**
 * `total` is the length of THIS page, not a table count — Mongo returned the
 * same thing and every consumer reads it that way. Preserved verbatim.
 */
export interface LocationSearchResult<T extends LocationMatch> {
  locations: T[];
  total: number;
  hasMore: boolean;
}

export interface LocationStats {
  totalLocations: number;
  locationsByType: { [key: string]: number };
  locationsByCountry: { [key: string]: number };
  topCities: { city: string; count: number }[];
}

/**
 * Every column one result row needs: the owner's identity plus the place.
 *
 * `users` columns are NAMED rather than taken through a whole-table select —
 * `users` is in `db/schema/protectedColumns.ts`, and a bare `select()` against
 * it returns the raw phone, the contact-discovery hashes and the refresh token.
 */
const locationSelection = {
  ownerId: users.id,
  username: users.username,
  locationKey: userLocations.locationKey,
  name: userLocations.name,
  label: userLocations.label,
  type: userLocations.type,
  street: userLocations.street,
  streetNumber: userLocations.streetNumber,
  streetDetails: userLocations.streetDetails,
  postalCode: userLocations.postalCode,
  city: userLocations.city,
  state: userLocations.state,
  country: userLocations.country,
  formattedAddress: userLocations.formattedAddress,
  latitude: userLocations.latitude,
  longitude: userLocations.longitude,
  placeId: userLocations.placeId,
  osmId: userLocations.osmId,
  osmType: userLocations.osmType,
  countryCode: userLocations.countryCode,
  timezone: userLocations.timezone,
  createdAt: userLocations.createdAt,
  updatedAt: userLocations.updatedAt,
} as const;

/** The row {@link locationSelection} yields. */
interface LocationRow {
  ownerId: string;
  username: string | null;
  locationKey: string;
  name: string;
  label: string | null;
  type: string;
  street: string | null;
  streetNumber: string | null;
  streetDetails: string | null;
  postalCode: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  formattedAddress: string | null;
  latitude: number | null;
  longitude: number | null;
  placeId: string | null;
  osmId: string | null;
  osmType: string | null;
  countryCode: string | null;
  timezone: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A NULL column becomes an ABSENT property — `undefined`, never `null`. */
function optional<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}

/** Flat joined row → the owner/place pair every caller receives. */
function toLocationMatch(row: LocationRow): LocationMatch {
  return {
    _id: row.ownerId,
    username: optional(row.username),
    location: {
      id: row.locationKey,
      name: row.name,
      label: optional(row.label),
      type: row.type,
      address: {
        street: optional(row.street),
        streetNumber: optional(row.streetNumber),
        streetDetails: optional(row.streetDetails),
        postalCode: optional(row.postalCode),
        city: optional(row.city),
        state: optional(row.state),
        country: optional(row.country),
        formattedAddress: optional(row.formattedAddress),
      },
      coordinates:
        row.latitude !== null && row.longitude !== null
          ? { lat: row.latitude, lon: row.longitude }
          : undefined,
      metadata: {
        placeId: optional(row.placeId),
        osmId: optional(row.osmId),
        osmType: optional(row.osmType),
        countryCode: optional(row.countryCode),
        timezone: optional(row.timezone),
      },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  };
}

/**
 * A case-insensitive SUBSTRING match, which is what Mongo's
 * `{ $regex: value, $options: 'i' }` was.
 *
 * The value is escaped for LIKE (`\`, `%`, `_`) and bound as a parameter, so no
 * input can widen the pattern — the same job escaping regex metacharacters
 * would have done, which the Mongo version never did.
 */
function substringMatch(column: Column, value: string): SQL {
  const pattern = `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  return sql`${qualified(column)} ilike ${pattern}`;
}

/**
 * The query point. `ST_MakePoint` takes (x, y) — LONGITUDE first — the same
 * ordering `user_locations.geo` is generated with, and the one thing about this
 * search that is still spelled out at a call site rather than in the schema.
 */
function queryPoint(lat: number, lon: number): SQL {
  return sql`ST_MakePoint(${lon}, ${lat})::geography`;
}

/**
 * Split a text query into the terms it should match ANY of.
 *
 * Mongo's `$text` scored a document containing ANY of the whitespace-separated
 * terms, so the port ORs one `plainto_tsquery` per term (`||` is tsquery OR)
 * rather than using `websearch_to_tsquery`, whose bare words are ANDed. Each
 * term is a bound parameter, so nothing in the input reaches the query language.
 *
 * Two `$text` features deliberately do NOT travel, and neither has a caller:
 * quoted phrases and `-negation`.
 */
function searchTerms(searchQuery: string): string[] {
  return searchQuery.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);
}

class LocationQueryService {
  /**
   * Saved places within `maxDistance` METRES of a point, nearest first.
   *
   * `ST_DWithin` on `geography` is a real distance test served by
   * `user_locations_geo_idx` (GiST) — not a bounding box, and not a haversine
   * computed per row after a wrong prefilter, which is what this replaced.
   */
  async findLocationsNear(
    lat: number,
    lon: number,
    maxDistance = 10000,
    options: LocationQueryOptions = {}
  ): Promise<LocationSearchResult<NearbyLocationMatch>> {
    const endTimer = performanceMonitor.startTimer('db_find_locations_near');

    try {
      const { limit = 10, skip = 0 } = options;
      const point = queryPoint(lat, lon);
      const distance = sql<number>`ST_Distance(${qualified(userLocations.geo)}, ${point})`;

      const rows = await getDb()
        .select({ ...locationSelection, distance })
        .from(userLocations)
        .innerJoin(users, eq(users.id, userLocations.userId))
        .where(
          and(
            isNotNull(userLocations.geo),
            sql`ST_DWithin(${qualified(userLocations.geo)}, ${point}, ${maxDistance})`
          )
        )
        // The secondary key is what Mongo lacked: two places at the same
        // distance could otherwise swap between pages of the same scan.
        .orderBy(asc(distance), asc(userLocations.id))
        .limit(limit + 1)
        .offset(skip);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const locations = page.map((row) => ({
        ...toLocationMatch(row),
        // `double precision` arrives as a number; the coercion is here so a
        // driver that ever hands back a string cannot put one on the wire.
        distance: Number(row.distance),
      }));

      endTimer();
      return { locations, total: locations.length, hasMore };
    } catch (error) {
      logger.error('Error finding locations near point:', error);
      endTimer();
      throw new Error('Error finding nearby locations');
    }
  }

  /**
   * Full-text search over `search_vector`, the GENERATED replacement for Mongo's
   * text index on `name` + `formatted_address`.
   */
  async searchLocationsByText(
    searchQuery: string,
    options: LocationQueryOptions = {}
  ): Promise<LocationSearchResult<ScoredLocationMatch>> {
    try {
      const { limit = 10, skip = 0, type, country, city } = options;

      const terms = searchTerms(searchQuery);
      if (terms.length === 0) {
        return { locations: [], total: 0, hasMore: false };
      }

      const tsQuery = sql.join(
        terms.map((term) => sql`plainto_tsquery(${SEARCH_CONFIGURATION}, ${term})`),
        sql` || `
      );
      const score = sql<number>`ts_rank(${qualified(userLocations.searchVector)}, ${tsQuery})`;

      const filters: SQL[] = [
        sql`${qualified(userLocations.searchVector)} @@ (${tsQuery})`,
      ];
      if (type) filters.push(sql`${qualified(userLocations.type)} = ${type}`);
      if (country) filters.push(substringMatch(userLocations.country, country));
      if (city) filters.push(substringMatch(userLocations.city, city));

      const rows = await getDb()
        .select({ ...locationSelection, score })
        .from(userLocations)
        .innerJoin(users, eq(users.id, userLocations.userId))
        .where(and(...filters))
        .orderBy(desc(score), asc(userLocations.id))
        .limit(limit + 1)
        .offset(skip);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const locations = page.map((row) => ({
        ...toLocationMatch(row),
        score: Number(row.score),
      }));

      return { locations, total: locations.length, hasMore };
    } catch (error) {
      logger.error('Error searching locations by text:', error);
      throw new Error('Error searching locations');
    }
  }

  /**
   * Saved places of one type, newest first.
   */
  async getLocationsByType(
    type: string,
    options: LocationQueryOptions = {}
  ): Promise<LocationSearchResult<LocationMatch>> {
    try {
      const { limit = 10, skip = 0, country, city } = options;

      const filters: SQL[] = [sql`${qualified(userLocations.type)} = ${type}`];
      if (country) filters.push(substringMatch(userLocations.country, country));
      if (city) filters.push(substringMatch(userLocations.city, city));

      return await this.listLocations(filters, limit, skip);
    } catch (error) {
      logger.error('Error getting locations by type:', error);
      throw new Error('Error getting locations by type');
    }
  }

  /**
   * Saved places in a country (and optionally a city), newest first.
   */
  async getLocationsByCountryCity(
    country: string,
    city?: string,
    options: LocationQueryOptions = {}
  ): Promise<LocationSearchResult<LocationMatch>> {
    try {
      const { limit = 10, skip = 0, type } = options;

      const filters: SQL[] = [substringMatch(userLocations.country, country)];
      if (city) filters.push(substringMatch(userLocations.city, city));
      if (type) filters.push(sql`${qualified(userLocations.type)} = ${type}`);

      return await this.listLocations(filters, limit, skip);
    } catch (error) {
      logger.error('Error getting locations by country/city:', error);
      throw new Error('Error getting locations by country/city');
    }
  }

  /**
   * Counts by type and by country, plus the ten most-saved cities.
   *
   * Mongo `$push`-ed every type and every country into two arrays and counted
   * them in JavaScript — the pipeline's own comment called that "optimized".
   * Both are `GROUP BY` here, so the row count never leaves the database.
   */
  async getLocationStats(): Promise<LocationStats> {
    try {
      const db = getDb();
      // `count(*)` is `bigint`, which postgres.js hands back as a STRING — a
      // silent `"42"` on the wire where the contract promises a number.
      const total = sql<number>`count(*)::int`;

      const [totals, byType, byCountry, topCities] = await Promise.all([
        db.select({ total }).from(userLocations),
        db.select({ key: userLocations.type, total }).from(userLocations).groupBy(userLocations.type),
        db
          .select({ key: userLocations.country, total })
          .from(userLocations)
          .where(isNotNull(userLocations.country))
          .groupBy(userLocations.country),
        db
          .select({ city: userLocations.city, count: total })
          .from(userLocations)
          .where(isNotNull(userLocations.city))
          .groupBy(userLocations.city)
          .orderBy(desc(total), asc(userLocations.city))
          .limit(10),
      ]);

      const locationsByType: { [key: string]: number } = {};
      for (const row of byType) {
        locationsByType[row.key] = Number(row.total);
      }

      const locationsByCountry: { [key: string]: number } = {};
      for (const row of byCountry) {
        if (row.key === null) continue;
        locationsByCountry[row.key] = Number(row.total);
      }

      return {
        totalLocations: Number(totals[0]?.total ?? 0),
        locationsByType,
        locationsByCountry,
        topCities: topCities.flatMap((row) =>
          row.city === null ? [] : [{ city: row.city, count: Number(row.count) }]
        ),
      };
    } catch (error) {
      logger.error('Error getting location stats:', error);
      throw new Error('Error getting location statistics');
    }
  }

  /**
   * Move one saved place.
   *
   * The pair is written by NAME, so there is no ordering left to get wrong, and
   * `geo` follows automatically — it is generated FROM these two columns and
   * cannot be written directly. `updated_at` is maintained by drizzle's
   * `$onUpdate`, as Mongoose's explicit `$set` of it used to be.
   */
  async updateLocationCoordinates(
    userId: string,
    locationId: string,
    lat: number,
    lon: number
  ): Promise<boolean> {
    try {
      const updated = await getDb()
        .update(userLocations)
        .set({ latitude: lat, longitude: lon })
        .where(
          and(eq(userLocations.userId, userId), eq(userLocations.locationKey, locationId))
        )
        .returning({ id: userLocations.id });

      return updated.length > 0;
    } catch (error) {
      logger.error('Error updating location coordinates:', error);
      throw new Error('Error updating location coordinates');
    }
  }

  /**
   * Remove one saved place. A real DELETE now, where Mongo `$pull`-ed an
   * element out of an embedded array.
   */
  async deleteLocation(userId: string, locationId: string): Promise<boolean> {
    try {
      const deleted = await getDb()
        .delete(userLocations)
        .where(
          and(eq(userLocations.userId, userId), eq(userLocations.locationKey, locationId))
        )
        .returning({ id: userLocations.id });

      return deleted.length > 0;
    } catch (error) {
      logger.error('Error deleting location:', error);
      throw new Error('Error deleting location');
    }
  }

  /** The shared newest-first listing behind the two filtered readers. */
  private async listLocations(
    filters: SQL[],
    limit: number,
    skip: number
  ): Promise<LocationSearchResult<LocationMatch>> {
    const rows = await getDb()
      .select(locationSelection)
      .from(userLocations)
      .innerJoin(users, eq(users.id, userLocations.userId))
      .where(and(...filters))
      .orderBy(desc(userLocations.createdAt), asc(userLocations.id))
      .limit(limit + 1)
      .offset(skip);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const locations = page.map(toLocationMatch);

    return { locations, total: locations.length, hasMore };
  }
}

// Export singleton instance
export const locationQueryService = new LocationQueryService();
export default locationQueryService;
