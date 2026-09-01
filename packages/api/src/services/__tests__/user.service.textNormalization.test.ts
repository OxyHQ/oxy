/**
 * Profile text normalization, asserted on the STORED row.
 *
 * The suite this replaces asserted `expect(set).toHaveBeenCalledWith('name',
 * {...})` against a mocked Mongoose document. That is a claim about an argument,
 * not about the database: normalization that happened and was then discarded by
 * the write path — or applied to the wrong column — passed it identically. The
 * reported bug this whole area exists for was a value rendered with
 * `white-space: pre-wrap` INTACT, which is a property of what is stored.
 *
 * So every case here writes through `updateUserProfile` and reads the row back.
 * The child collections (`user_locations`, `user_link_metadata`) are read as
 * rows, because normalization has to survive the embedded-array → child-table
 * translation too, and the ORDER a child table returns is not the submitted
 * order unless a column says so.
 */

import { randomUUID } from 'node:crypto';
import { asc, eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userLinkMetadata } from '../../db/schema/userLinkMetadata';
import { userLocations } from '../../db/schema/userLocations';
import { users } from '../../db/schema/users';
import { BadRequestError } from '../../utils/error';
import { USERNAME_INVALID_MESSAGE } from '@oxyhq/contracts';
import { userService } from '../user.service';

const uniqueId = () => randomUUID().replace(/-/g, '');

/**
 * The reported bug's exact input: a remote page served its `<title>` across
 * indented source lines, so the string carries a real newline plus indentation.
 */
const INDENTED_REMOTE_TITLE = '\n      Mi título\n    ';

async function makeUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const id = uniqueId();
  await getDb()
    .insert(users)
    .values({ id, username: `u${id}`, email: `${id}@example.test`, ...overrides });
  return id;
}

async function storedRow(userId: string) {
  const [row] = await getDb()
    .select({
      username: users.username,
      nameFirst: users.nameFirst,
      nameLast: users.nameLast,
      bio: users.bio,
      links: users.links,
    })
    .from(users)
    .where(eq(users.id, userId));
  return row;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('display name', () => {
  it('collapses a run of spaces before storing', async () => {
    const id = await makeUser();

    await userService.updateUserProfile(id, {
      name: { first: `Ana${' '.repeat(20)}`, last: 'Gómez' },
    });

    // The stored columns, not the arguments — the run of spaces used to survive
    // to the client, which renders it with `white-space: pre-wrap`.
    expect(await storedRow(id)).toMatchObject({ nameFirst: 'Ana', nameLast: 'Gómez' });
  });

  it('keeps an apostrophe intact rather than escaping it', async () => {
    const id = await makeUser();

    const updated = await userService.updateUserProfile(id, {
      name: { first: "N'Golo", last: "O'Brien" },
    });

    expect(updated.name).toEqual({ first: "N'Golo", last: "O'Brien" });
    expect(await storedRow(id)).toMatchObject({ nameFirst: "N'Golo", nameLast: "O'Brien" });
  });

  it('rejects a name the display-name policy forbids, and stores nothing', async () => {
    const id = await makeUser({ nameFirst: 'Ada' });

    await expect(
      userService.updateUserProfile(id, { name: { first: 'Ada 3000 🚀' } })
    ).rejects.toBeInstanceOf(BadRequestError);

    expect((await storedRow(id)).nameFirst).toBe('Ada');
  });
});

describe('bio', () => {
  it('strips trailing whitespace per line so blank lines collapse', async () => {
    const id = await makeUser();

    await userService.updateUserProfile(id, {
      bio: 'Primera línea\n   \n   \nSegunda línea',
    });

    expect((await storedRow(id)).bio).toBe('Primera línea\n\nSegunda línea');
  });
});

describe('links', () => {
  it('trims each entry and drops the empty ones', async () => {
    const id = await makeUser();

    await userService.updateUserProfile(id, {
      links: [' https://example.com ', '   '],
    });

    expect((await storedRow(id)).links).toEqual(['https://example.com']);
  });
});

describe('linksMetadata child rows', () => {
  it('normalizes an indented multi-line remote title and description', async () => {
    const id = await makeUser();

    await userService.updateUserProfile(id, {
      linksMetadata: [
        {
          url: 'https://example.com',
          title: INDENTED_REMOTE_TITLE,
          description: 'Una   descripción\ncon salto',
        },
      ],
    });

    const rows = await getDb()
      .select({
        url: userLinkMetadata.url,
        title: userLinkMetadata.title,
        description: userLinkMetadata.description,
      })
      .from(userLinkMetadata)
      .where(eq(userLinkMetadata.userId, id));

    expect(rows).toEqual([
      {
        url: 'https://example.com',
        title: 'Mi título',
        description: 'Una descripción con salto',
      },
    ]);
  });

  it('records the submitted order as `position`', async () => {
    // An embedded array was ordered by construction; a child table is a SET
    // until a column says otherwise, so the order is part of the contract.
    const id = await makeUser();

    await userService.updateUserProfile(id, {
      linksMetadata: [
        { url: 'https://second.test', title: 'B', description: '' },
        { url: 'https://first.test', title: 'A', description: '' },
      ],
    });

    const rows = await getDb()
      .select({ url: userLinkMetadata.url, position: userLinkMetadata.position })
      .from(userLinkMetadata)
      .where(eq(userLinkMetadata.userId, id))
      .orderBy(asc(userLinkMetadata.position));

    expect(rows).toEqual([
      { url: 'https://second.test', position: 0 },
      { url: 'https://first.test', position: 1 },
    ]);
  });
});

describe('location child rows', () => {
  it('normalizes the place name, label and formatted address', async () => {
    const id = await makeUser();

    await userService.updateUserProfile(id, {
      locations: [
        {
          id: 'loc-1',
          name: '  Plaça   de Catalunya ',
          label: 'Home\noffice',
          address: { formattedAddress: 'Plaça de Catalunya,\n  Barcelona' },
        },
      ],
    });

    const rows = await getDb()
      .select({
        locationKey: userLocations.locationKey,
        name: userLocations.name,
        label: userLocations.label,
        formattedAddress: userLocations.formattedAddress,
      })
      .from(userLocations)
      .where(eq(userLocations.userId, id));

    expect(rows).toEqual([
      {
        locationKey: 'loc-1',
        name: 'Plaça de Catalunya',
        label: 'Home office',
        formattedAddress: 'Plaça de Catalunya, Barcelona',
      },
    ]);
  });

  it('writes the coordinate pair into its NAMED columns, unswapped', async () => {
    // The original Mongo defect was a coordinate-ordering mistake, and the fix
    // has two halves: named columns at the write path (this test) and a
    // GENERATED point so the spatial value cannot disagree with them (the
    // assertion below). Barcelona is 41.4°N, 2.2°E; a transposed pair is a
    // PLAUSIBLE point off the coast of Somalia, so asserting "a row came back"
    // would pass against the exact bug.
    const id = await makeUser();

    await userService.updateUserProfile(id, {
      locations: [
        { id: 'loc-1', name: 'Barcelona', coordinates: { lat: 41.3874, lon: 2.1686 } },
      ],
    });

    const [row] = await getDb()
      .select({
        latitude: userLocations.latitude,
        longitude: userLocations.longitude,
        // ST_X is the FIRST ordinate of the generated point, which must be the
        // longitude — that is the whole ordering contract.
        pointX: sql<number>`ST_X(${userLocations.geo}::geometry)`,
        pointY: sql<number>`ST_Y(${userLocations.geo}::geometry)`,
      })
      .from(userLocations)
      .where(eq(userLocations.userId, id));

    expect(row.latitude).toBeCloseTo(41.3874, 4);
    expect(row.longitude).toBeCloseTo(2.1686, 4);
    expect(row.pointX).toBeCloseTo(2.1686, 4);
    expect(row.pointY).toBeCloseTo(41.3874, 4);
  });

  it('replaces the previous locations rather than appending to them', async () => {
    const id = await makeUser();

    await userService.updateUserProfile(id, {
      locations: [
        { id: 'loc-1', name: 'First' },
        { id: 'loc-2', name: 'Second' },
      ],
    });
    await userService.updateUserProfile(id, {
      locations: [{ id: 'loc-3', name: 'Only' }],
    });

    const rows = await getDb()
      .select({ locationKey: userLocations.locationKey })
      .from(userLocations)
      .where(eq(userLocations.userId, id));

    expect(rows).toEqual([{ locationKey: 'loc-3' }]);
  });
});

describe('username policy', () => {
  it('rejects interior whitespace with a 400', async () => {
    const id = await makeUser();

    await expect(
      userService.updateUserProfile(id, { username: 'al ice' })
    ).rejects.toMatchObject({ statusCode: 400, message: USERNAME_INVALID_MESSAGE });
  });

  it('rejects punctuation with a 400', async () => {
    const id = await makeUser();

    await expect(
      userService.updateUserProfile(id, { username: 'al.ice' })
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it('stores a clean username change trimmed', async () => {
    const id = await makeUser();
    const next = `bob${uniqueId().slice(0, 8)}`;

    await userService.updateUserProfile(id, { username: `  ${next} ` });

    expect((await storedRow(id)).username).toBe(next);
  });

  it('does not re-validate an unchanged legacy username echoed back by the client', async () => {
    // A client that PUTs the whole profile sends the stored username back. A
    // value that predates the policy must not make an unrelated bio edit fail.
    const legacy = `legacy.user.${uniqueId().slice(0, 8)}`;
    const id = await makeUser({ username: legacy });

    await userService.updateUserProfile(id, { username: legacy, bio: 'Hola' });

    expect(await storedRow(id)).toMatchObject({ username: legacy, bio: 'Hola' });
  });

  it('rejects a username already taken by another account, case-insensitively', async () => {
    // The unique index is on `lower(btrim(username))`, so an uppercase spelling
    // must be refused HERE with a 400 rather than reaching the constraint as a
    // 500.
    const taken = `taken${uniqueId().slice(0, 8)}`;
    await makeUser({ username: taken });
    const id = await makeUser();

    await expect(
      userService.updateUserProfile(id, { username: taken.toUpperCase() })
    ).rejects.toThrow('Username already exists');
  });
});
