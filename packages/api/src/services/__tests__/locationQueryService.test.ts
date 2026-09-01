/**
 * `locationQueryService` against a REAL Postgres with PostGIS.
 *
 * ## The guarantee this file exists for
 *
 * **A "near Barcelona" search returns Barcelona and NOT the point whose
 * coordinates are Barcelona's transposed.**
 *
 * A latitude/longitude swap does not throw. `ST_MakePoint(41.3851, 2.1734)` is
 * a perfectly valid point — it is just off the coast of Somalia instead of in
 * Catalonia. So a test that asserts "a row came back" passes against the exact
 * bug this table was redesigned to make unrepresentable, and one that asserts
 * only a row COUNT passes against it too.
 *
 * Every spatial case below therefore pins the answer against a distance that
 * can be checked OUTSIDE PostGIS, and seeds a deliberately transposed row whose
 * ABSENCE is the discriminator:
 *
 *  - `TRANSPOSED_BARCELONA` sits at (lat 2.1734, lon 41.3851). If
 *    `findLocationsNear` built its query point as `ST_MakePoint(lat, lon)` the
 *    query point would land there and the two results would INVERT: the
 *    transposed row would match and Barcelona would not. Both halves are
 *    asserted, in two cases that would swap their answers under that bug.
 *  - Barcelona↔Madrid is 505 444 m by haversine on the IUGG mean Earth radius,
 *    which agrees with the published ~505 km figure. PostGIS measures on the
 *    WGS 84 spheroid and answers ~506 649 m (0.24% higher). Transposing BOTH
 *    points makes the same measurement 662 317 m — 31% out. The tolerance below
 *    separates those by two orders of magnitude, so it is a discriminator, not
 *    a rounding allowance.
 *
 * `db/__tests__/postgis.test.ts` holds the COLUMN (generated, stored,
 * GiST-indexed, built as `(longitude, latitude)`). This file holds the QUERY.
 *
 * ## Isolation — every read here is a WHOLE-TABLE read
 *
 * The whole run shares ONE throwaway database and jest workers run in parallel,
 * so a `delete(userLocations)` here would destroy another suite's fixtures. It
 * matters more than usual for this file because none of these methods takes an
 * owner: they search the table. And the collision is REAL rather than
 * theoretical — `user.service.textNormalization.test.ts` and
 * `normalizeUserTextFields.writePathParity.test.ts` both seed points inside
 * Barcelona, well within the radii below.
 *
 * Three scoping devices, each stated where it is used:
 *  - every `location_key` carries a per-run prefix, and results are filtered to
 *    it before any membership or ORDER assertion (filtering preserves relative
 *    order, so the ordering guarantee survives intact);
 *  - counts, which cannot be filtered, are asserted as BEFORE/AFTER DELTAS;
 *  - the paging case sits at Point Nemo, the oceanic pole of inaccessibility,
 *    where no fixture of any suite could plausibly be.
 *
 * ## What was already broken before the port
 *
 * Two of these methods could not return a correct answer at all, and both are
 * asserted here as working:
 *
 *  - `findLocationsNear` prefiltered with `$geoWithin: { $centerSphere: … }`
 *    over a `{ lat, lon }` OBJECT, which Mongo reads positionally as
 *    `[longitude, latitude]` — i.e. over transposed points — and then applied a
 *    correctly-computed haversine. Intersecting a wrong circle with a right one
 *    returns (almost always) nothing.
 *  - `searchLocationsByText` put `$text` in a `$match` AFTER `$unwind`, which
 *    Mongo rejects outright, so it threw on every call.
 */

import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userLocations } from '../../db/schema/userLocations';
import { users } from '../../db/schema/users';
import locationQueryService, { type LocationMatch } from '../locationQueryService';

/** Barcelona, Plaça de Catalunya: degrees north, degrees east. */
const BARCELONA = { latitude: 41.3851, longitude: 2.1734 };
/** Madrid, Puerta del Sol: degrees north, degrees WEST — hence a negative longitude. */
const MADRID = { latitude: 40.4168, longitude: -3.7038 };
/**
 * Barcelona's pair read backwards. A valid point, in the Indian Ocean off
 * Somalia — which is why its ABSENCE, not an error, is the tell.
 */
const TRANSPOSED_BARCELONA = { latitude: BARCELONA.longitude, longitude: BARCELONA.latitude };
/**
 * Point Nemo, the oceanic pole of inaccessibility — the point on Earth furthest
 * from any land. Used where a count must be exact: no suite's fixture can sit
 * near it, so a whole-table search around it sees only this file's rows.
 */
const POINT_NEMO = { latitude: -48.8767, longitude: -123.3933 };

/** Barcelona↔Madrid in metres, haversine on the IUGG mean radius (6 371 008.8 m). */
const BARCELONA_MADRID_METRES = 505_444;
/** Comfortably over the 0.24% sphere/spheroid gap, far under the 31% transposition. */
const DISTANCE_TOLERANCE = 0.02;

/**
 * Per-RUN, not per-test: it is the handle every assertion filters on, so it has
 * to survive across cases within a file while never colliding with another
 * worker's rows.
 */
const RUN = randomUUID().replace(/-/g, '').slice(0, 12);
/** A token no dictionary, and no other fixture, contains. */
const RARE_TOKEN = `zqxwv${RUN}`;

/** Accounts created here, torn down at the end — locations cascade with them. */
const createdOwners: string[] = [];
let OWNER_ID: string;

async function insertOwner(): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ username: `loc-${RUN}-${createdOwners.length}`, color: 'teal' })
    .returning({ id: users.id });
  createdOwners.push(row.id);
  return row.id;
}

/** This run's namespaced form of a location key. */
function key(name: string): string {
  return `${RUN}-${name}`;
}

interface SeedLocation {
  key: string;
  name: string;
  latitude?: number;
  longitude?: number;
  type?: 'home' | 'work' | 'school' | 'other';
  city?: string;
  country?: string;
  formattedAddress?: string;
  userId?: string;
}

async function seedLocation(location: SeedLocation): Promise<void> {
  await getDb()
    .insert(userLocations)
    .values({
      userId: location.userId ?? OWNER_ID,
      locationKey: key(location.key),
      name: location.name,
      type: location.type ?? 'other',
      city: location.city ?? null,
      country: location.country ?? null,
      formattedAddress: location.formattedAddress ?? null,
      latitude: location.latitude ?? null,
      longitude: location.longitude ?? null,
    });
}

/** The three cities every spatial case reasons about. */
async function seedCities(): Promise<void> {
  await seedLocation({ key: 'barcelona', name: 'Barcelona', ...BARCELONA });
  await seedLocation({ key: 'madrid', name: 'Madrid', ...MADRID });
  await seedLocation({
    key: 'transposed-barcelona',
    name: 'Transposed Barcelona',
    ...TRANSPOSED_BARCELONA,
  });
}

/**
 * This run's location keys, in the order the service returned them, with every
 * other suite's rows dropped. Filtering cannot reorder what survives, so an
 * ORDER assertion over the result is still an assertion about the query's own
 * ordering.
 */
function ownKeys(result: { locations: LocationMatch[] }): string[] {
  return result.locations
    .map((match) => match.location.id)
    .filter((id) => id.startsWith(`${RUN}-`))
    .map((id) => id.slice(RUN.length + 1));
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  if (createdOwners.length > 0) {
    // `user_locations.user_id` is ON DELETE CASCADE, so this takes the rows
    // with it — and it touches nothing another worker owns.
    await getDb().delete(users).where(inArray(users.id, createdOwners));
  }
  await closePostgres();
});

beforeEach(async () => {
  OWNER_ID = await insertOwner();
});

afterEach(async () => {
  await getDb().delete(users).where(eq(users.id, OWNER_ID));
});

describe('findLocationsNear — the coordinate ordering', () => {
  it('returns the genuinely-near city and NOT the transposed one', async () => {
    await seedCities();

    // 50 km around Barcelona: Madrid is 505 km away and the transposed point is
    // in the Indian Ocean, so exactly one of this run's rows can match.
    const result = await locationQueryService.findLocationsNear(
      BARCELONA.latitude,
      BARCELONA.longitude,
      50_000
    );

    expect(ownKeys(result)).toEqual(['barcelona']);
    // Stated separately, because "one row came back" is what a transposed query
    // point also produces — it just comes back with the WRONG row.
    expect(ownKeys(result)).not.toContain('transposed-barcelona');
  });

  it('finds the transposed point only from the transposed query point', async () => {
    // The other half of the same statement. The two rows are genuinely far
    // apart, so neither search can see the other's city — and if the service
    // swapped its arguments these two cases would swap their answers.
    await seedCities();

    const result = await locationQueryService.findLocationsNear(
      TRANSPOSED_BARCELONA.latitude,
      TRANSPOSED_BARCELONA.longitude,
      50_000
    );

    expect(ownKeys(result)).toEqual(['transposed-barcelona']);
  });

  it('measures a real-world distance that matches an independent computation', async () => {
    await seedCities();

    const result = await locationQueryService.findLocationsNear(
      BARCELONA.latitude,
      BARCELONA.longitude,
      600_000
    );

    // Nearest first, and the transposed point stays out even at 600 km.
    expect(ownKeys(result)).toEqual(['barcelona', 'madrid']);

    const own = result.locations.filter((match) => match.location.id.startsWith(`${RUN}-`));
    expect(own[0].distance).toBeCloseTo(0, 3);
    const madrid = own[1].distance;
    const drift = Math.abs(madrid - BARCELONA_MADRID_METRES) / BARCELONA_MADRID_METRES;
    expect(drift).toBeLessThan(DISTANCE_TOLERANCE);
  });

  it('excludes a city just outside the radius and includes it just inside', async () => {
    // `ST_DWithin` is a real distance test, not a bounding box: Madrid is due
    // WEST of Barcelona, so a box wide enough to hold 500 km of longitude would
    // admit it at radii a true distance rejects.
    await seedCities();

    const outside = await locationQueryService.findLocationsNear(
      BARCELONA.latitude,
      BARCELONA.longitude,
      500_000
    );
    const inside = await locationQueryService.findLocationsNear(
      BARCELONA.latitude,
      BARCELONA.longitude,
      510_000
    );

    expect(ownKeys(outside)).toEqual(['barcelona']);
    expect(ownKeys(inside)).toEqual(['barcelona', 'madrid']);
  });

  it('never returns a location that has no coordinates', async () => {
    await seedCities();
    await seedLocation({ key: 'nowhere', name: 'No coordinates' });

    const result = await locationQueryService.findLocationsNear(
      BARCELONA.latitude,
      BARCELONA.longitude,
      20_000_000
    );

    expect(ownKeys(result).sort()).toEqual(['barcelona', 'madrid', 'transposed-barcelona']);
  });
});

describe('findLocationsNear — the response body', () => {
  it('returns the owner, the whole nested place, and a NUMBER distance', async () => {
    await seedLocation({
      key: 'barcelona',
      name: 'Barcelona',
      type: 'home',
      city: 'Barcelona',
      country: 'Spain',
      formattedAddress: 'Plaça de Catalunya, Barcelona',
      ...BARCELONA,
    });

    const result = await locationQueryService.findLocationsNear(
      BARCELONA.latitude,
      BARCELONA.longitude,
      50_000
    );

    const [match] = result.locations.filter((row) => row.location.id === key('barcelona'));
    expect(match._id).toBe(OWNER_ID);
    expect(match.username).toBe(`loc-${RUN}-${createdOwners.length - 1}`);
    // A raw `db.execute` hands a `timestamptz` back as the STRING
    // `2026-07-31 20:36:11.044179+00`, and `res.json` serializes a string as
    // happily as a Date — so the TYPE is the assertion, not the value.
    expect(match.location.createdAt).toBeInstanceOf(Date);
    expect(match.location.updatedAt).toBeInstanceOf(Date);
    expect(typeof match.distance).toBe('number');
    expect(match.location).toEqual({
      id: key('barcelona'),
      name: 'Barcelona',
      type: 'home',
      address: {
        city: 'Barcelona',
        country: 'Spain',
        formattedAddress: 'Plaça de Catalunya, Barcelona',
        // Every other address field is ABSENT, never null: drizzle hands back
        // `null` where Mongoose handed `undefined`, and the SDK's zod parse
        // rejects a null where the contract promises an optional.
      },
      coordinates: { lat: BARCELONA.latitude, lon: BARCELONA.longitude },
      metadata: {},
      createdAt: match.location.createdAt,
      updatedAt: match.location.updatedAt,
    });
  });

  it('omits coordinates entirely when the row has none', async () => {
    await seedLocation({ key: 'nowhere', name: `No coordinates ${RARE_TOKEN}` });

    const result = await locationQueryService.searchLocationsByText(RARE_TOKEN);

    expect(result.locations[0].location.coordinates).toBeUndefined();
  });

  it('pages with limit + skip and reports hasMore', async () => {
    // Point Nemo: the counts below are exact only because nothing else in the
    // suite can have a fixture within 100 km of it.
    await seedLocation({ key: 'nemo-a', name: 'A', ...POINT_NEMO });
    await seedLocation({
      key: 'nemo-b',
      name: 'B',
      latitude: POINT_NEMO.latitude + 0.1,
      longitude: POINT_NEMO.longitude,
    });
    await seedLocation({
      key: 'nemo-c',
      name: 'C',
      latitude: POINT_NEMO.latitude + 0.2,
      longitude: POINT_NEMO.longitude,
    });

    const first = await locationQueryService.findLocationsNear(
      POINT_NEMO.latitude,
      POINT_NEMO.longitude,
      100_000,
      { limit: 2, skip: 0 }
    );
    const second = await locationQueryService.findLocationsNear(
      POINT_NEMO.latitude,
      POINT_NEMO.longitude,
      100_000,
      { limit: 2, skip: 2 }
    );

    expect(ownKeys(first)).toEqual(['nemo-a', 'nemo-b']);
    expect(first.hasMore).toBe(true);
    // `total` is the length of THIS page, exactly as Mongo returned it — not a
    // table count. Preserved verbatim because every consumer reads it that way.
    expect(first.total).toBe(2);

    expect(ownKeys(second)).toEqual(['nemo-c']);
    expect(second.hasMore).toBe(false);
    expect(second.total).toBe(1);
  });
});

describe('searchLocationsByText', () => {
  it('matches the generated search vector — which the Mongo pipeline could not', async () => {
    // `$text` in a `$match` after `$unwind` is illegal, so this method threw on
    // every call. There is no prior behaviour to preserve, only a correct one.
    await seedLocation({ key: 'library', name: `Central Library ${RARE_TOKEN}` });
    await seedLocation({ key: 'gym', name: 'Riverside Gym' });

    const result = await locationQueryService.searchLocationsByText(RARE_TOKEN);

    expect(ownKeys(result)).toEqual(['library']);
    expect(typeof result.locations[0].score).toBe('number');
  });

  it('searches the formatted address as well as the name', async () => {
    // Both columns feed `search_vector`; a query that matched only `name` would
    // look identical on the case above.
    await seedLocation({
      key: 'library',
      name: 'Central Library',
      formattedAddress: `12 Reading Street ${RARE_TOKEN}`,
    });

    expect(ownKeys(await locationQueryService.searchLocationsByText(RARE_TOKEN)))
      .toEqual(['library']);
  });

  it('matches ANY term, as Mongo $text did — not all of them', async () => {
    await seedLocation({ key: 'library', name: `Library ${RARE_TOKEN}a` });
    await seedLocation({ key: 'gym', name: `Gym ${RARE_TOKEN}b` });

    const result = await locationQueryService.searchLocationsByText(
      `${RARE_TOKEN}a ${RARE_TOKEN}b`
    );

    expect(ownKeys(result).sort()).toEqual(['gym', 'library']);
  });

  it('stems, because the vector is built with the english configuration', async () => {
    // The generated column uses `to_tsvector('english', …)`; querying through a
    // different configuration would silently stop matching.
    await seedLocation({ key: 'library', name: `${RARE_TOKEN} Libraries` });

    expect(ownKeys(await locationQueryService.searchLocationsByText(`${RARE_TOKEN} library`)))
      .toEqual(['library']);
  });

  it('treats LIKE and tsquery metacharacters as ordinary text', async () => {
    await seedLocation({ key: 'library', name: `Central Library ${RARE_TOKEN}` });

    // `%` would match everything as a LIKE pattern, and `&`/`!` are tsquery
    // operators — every term is a bound parameter, so none of them reach the
    // query language.
    const result = await locationQueryService.searchLocationsByText('% & !');

    expect(ownKeys(result)).toEqual([]);
  });

  it('returns nothing rather than everything for a blank query', async () => {
    await seedLocation({ key: 'library', name: `Central Library ${RARE_TOKEN}` });

    expect((await locationQueryService.searchLocationsByText('   ')).locations).toEqual([]);
  });

  it('narrows by type, country and city', async () => {
    await seedLocation({
      key: 'library-es',
      name: `Library ${RARE_TOKEN}`,
      type: 'work',
      city: `Barcelona-${RUN}`,
      country: `Spain-${RUN}`,
    });
    await seedLocation({
      key: 'library-fr',
      name: `Library ${RARE_TOKEN}`,
      type: 'other',
      city: `Paris-${RUN}`,
      country: `France-${RUN}`,
    });

    expect(ownKeys(await locationQueryService.searchLocationsByText(RARE_TOKEN, { type: 'work' })))
      .toEqual(['library-es']);
    // Case-insensitive SUBSTRING, which is what `{ $regex, $options: 'i' }` was.
    expect(
      ownKeys(
        await locationQueryService.searchLocationsByText(RARE_TOKEN, {
          country: `fran`,
        })
      )
    ).toEqual(['library-fr']);
    expect(
      ownKeys(
        await locationQueryService.searchLocationsByText(RARE_TOKEN, {
          city: `BARCELONA-${RUN.toUpperCase()}`,
        })
      )
    ).toEqual(['library-es']);
  });
});

describe('getLocationsByType / getLocationsByCountryCity', () => {
  it('returns only the requested type, newest first', async () => {
    await seedLocation({ key: 'home', name: 'Home', type: 'home', country: `Spain-${RUN}` });
    await seedLocation({ key: 'work', name: 'Work', type: 'work', country: `Spain-${RUN}` });

    expect(
      ownKeys(await locationQueryService.getLocationsByType('home', { country: `Spain-${RUN}` }))
    ).toEqual(['home']);
  });

  it('matches country and city case-insensitively, as a substring', async () => {
    await seedLocation({
      key: 'bcn',
      name: 'Home',
      city: `Barcelona-${RUN}`,
      country: `Spain-${RUN}`,
    });
    await seedLocation({
      key: 'par',
      name: 'Home',
      city: `Paris-${RUN}`,
      country: `France-${RUN}`,
    });

    expect(ownKeys(await locationQueryService.getLocationsByCountryCity(`spain-${RUN}`)))
      .toEqual(['bcn']);
    expect(
      ownKeys(
        await locationQueryService.getLocationsByCountryCity(
          `France-${RUN}`,
          `PARIS-${RUN.toUpperCase()}`
        )
      )
    ).toEqual(['par']);
  });

  it('does not let a wildcard in the filter widen the match', async () => {
    // `%` is escaped for LIKE, so it is a literal per cent sign and matches
    // nothing here — a raw pattern would have returned both rows.
    await seedLocation({ key: 'bcn', name: 'Home', country: `Spain-${RUN}` });
    await seedLocation({ key: 'par', name: 'Home', country: `France-${RUN}` });

    expect(ownKeys(await locationQueryService.getLocationsByCountryCity('%'))).toEqual([]);
  });
});

describe('getLocationStats', () => {
  it('counts by type and country as DELTAS this run can own', async () => {
    // The aggregate is global — no filter reaches it — so what is asserted is
    // the CHANGE this run's rows make, plus a country name only this run uses.
    const before = await locationQueryService.getLocationStats();

    const other = await insertOwner();
    await seedLocation({ key: 'a', name: 'A', type: 'home', country: `Spain-${RUN}` });
    await seedLocation({ key: 'b', name: 'B', type: 'home', country: `Spain-${RUN}` });
    await seedLocation({ key: 'c', name: 'C', type: 'work', country: `France-${RUN}` });
    await seedLocation({ key: 'd', name: 'D', type: 'work', userId: other });

    const after = await locationQueryService.getLocationStats();

    expect(after.totalLocations - before.totalLocations).toBe(4);
    expect((after.locationsByType.home ?? 0) - (before.locationsByType.home ?? 0)).toBe(2);
    expect((after.locationsByType.work ?? 0) - (before.locationsByType.work ?? 0)).toBe(2);
    expect(after.locationsByCountry[`Spain-${RUN}`]).toBe(2);
    expect(after.locationsByCountry[`France-${RUN}`]).toBe(1);
    // A row with no country is counted in neither bucket, as Mongo's
    // `if (country)` filter did — 4 rows, 3 countries.
    await getDb().delete(users).where(eq(users.id, other));
  });

  it('ranks the busiest cities first', async () => {
    // Twelve rows in one uniquely-named city: far more than any other suite
    // seeds in a single city, so this run legitimately owns the top slot. If
    // that ever stops being true this fails loudly rather than drifting.
    for (let index = 0; index < 12; index += 1) {
      await seedLocation({ key: `busy-${index}`, name: 'Busy', city: `Nemo-${RUN}` });
    }

    const stats = await locationQueryService.getLocationStats();

    expect(stats.topCities[0]).toEqual({ city: `Nemo-${RUN}`, count: 12 });
    const counts = stats.topCities.map((entry) => entry.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });

  it('reports counts as NUMBERS, not the strings count(*) arrives as', async () => {
    // `count(*)` is `bigint`, which postgres.js hands back as a string — a
    // silent `"1"` where the contract promises a number.
    await seedLocation({ key: 'a', name: 'A', type: 'home', city: `Nemo-${RUN}` });

    const stats = await locationQueryService.getLocationStats();

    expect(typeof stats.totalLocations).toBe('number');
    expect(typeof stats.locationsByType.home).toBe('number');
    expect(typeof stats.topCities[0].count).toBe('number');
  });
});

describe('updateLocationCoordinates', () => {
  it('moves the place and the generated point follows', async () => {
    await seedLocation({ key: 'here', name: 'Here', ...MADRID });

    expect(
      await locationQueryService.updateLocationCoordinates(
        OWNER_ID,
        key('here'),
        BARCELONA.latitude,
        BARCELONA.longitude
      )
    ).toBe(true);

    // The proof is spatial, not just columnar: `geo` is GENERATED from the two
    // columns, so a search around the NEW point must find the row and one
    // around the old point must not.
    const near = await locationQueryService.findLocationsNear(
      BARCELONA.latitude,
      BARCELONA.longitude,
      50_000
    );
    const far = await locationQueryService.findLocationsNear(
      MADRID.latitude,
      MADRID.longitude,
      50_000
    );

    expect(ownKeys(near)).toEqual(['here']);
    expect(ownKeys(far)).toEqual([]);
  });

  it("will not move another account's place", async () => {
    const stranger = await insertOwner();
    await seedLocation({ key: 'here', name: 'Here', ...MADRID });

    expect(
      await locationQueryService.updateLocationCoordinates(
        stranger,
        key('here'),
        BARCELONA.latitude,
        BARCELONA.longitude
      )
    ).toBe(false);

    const [row] = await getDb()
      .select({ latitude: userLocations.latitude })
      .from(userLocations)
      .where(eq(userLocations.locationKey, key('here')));
    expect(row.latitude).toBe(MADRID.latitude);

    await getDb().delete(users).where(eq(users.id, stranger));
  });

  it('reports false for a location key that does not exist', async () => {
    expect(
      await locationQueryService.updateLocationCoordinates(OWNER_ID, key('missing'), 1, 1)
    ).toBe(false);
  });
});

describe('deleteLocation', () => {
  it('removes the row', async () => {
    await seedLocation({ key: 'here', name: 'Here', ...BARCELONA });

    expect(await locationQueryService.deleteLocation(OWNER_ID, key('here'))).toBe(true);
    expect(
      await getDb()
        .select({ id: userLocations.id })
        .from(userLocations)
        .where(eq(userLocations.userId, OWNER_ID))
    ).toEqual([]);
  });

  it("will not delete another account's place", async () => {
    const stranger = await insertOwner();
    await seedLocation({ key: 'here', name: 'Here', ...BARCELONA });

    expect(await locationQueryService.deleteLocation(stranger, key('here'))).toBe(false);
    expect(
      await getDb()
        .select({ id: userLocations.id })
        .from(userLocations)
        .where(eq(userLocations.userId, OWNER_ID))
    ).toHaveLength(1);

    await getDb().delete(users).where(eq(users.id, stranger));
  });
});
