/**
 * Profile text normalization, asserted on the STORED row.
 *
 * Asserting on a mocked write's argument is a claim about an argument, not
 * about the database: normalization that happened and was then discarded by
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
import { PROFILE_LINKS_MAX, USERNAME_INVALID_MESSAGE } from '@oxy.so/contracts';
import { userService } from '../user.service';

jest.mock('../clarityLinkDocuments.service', () => {
  const actual = jest.requireActual('../clarityLinkDocuments.service');
  return {
    ...actual,
    resolveLinkDocuments: async (urls: readonly string[]) => ({
      documents: new Map(
        urls.map((url) => [
          url,
          // Clarity names one document per page: a trailing slash is the same page.
          { id: `doc:${url.replace(/\/$/, '')}`, canonicalUrl: url, faviconUrl: null },
        ]),
      ),
      pending: [],
    }),
  };
});

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
      userService.updateUserProfile(id, { name: { first: 'Ada 3000 🚀' } }),
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
  it('never stores the bare URL list: a profile link is a Clarity document row', async () => {
    const id = await makeUser();

    await userService.updateUserProfile(id, {
      links: [' https://example.com '],
    });

    expect((await storedRow(id)).links).toBeNull();
  });
});

describe('linksMetadata child rows', () => {
  it('refuses more than PROFILE_LINKS_MAX links and stores none of them', async () => {
    const id = await makeUser();
    const links = Array.from({ length: PROFILE_LINKS_MAX + 1 }, (_, index) => ({
      url: `https://example.com/${index}`,
    }));

    await expect(
      userService.updateUserProfile(id, { linksMetadata: links }),
    ).rejects.toBeInstanceOf(BadRequestError);

    const rows = await getDb()
      .select({ id: userLinkMetadata.id })
      .from(userLinkMetadata)
      .where(eq(userLinkMetadata.userId, id));
    expect(rows).toHaveLength(0);
  });

  it('stores the Clarity document id, never the URL, with the owner title normalized', async () => {
    const id = await makeUser();

    await userService.updateUserProfile(id, {
      linksMetadata: [{ url: 'https://example.com', title: INDENTED_REMOTE_TITLE }],
    });

    const rows = await getDb()
      .select({
        clarityDocumentId: userLinkMetadata.clarityDocumentId,
        title: userLinkMetadata.title,
      })
      .from(userLinkMetadata)
      .where(eq(userLinkMetadata.userId, id));

    expect(rows).toEqual([{ clarityDocumentId: `doc:https://example.com`, title: 'Mi título' }]);
  });

  it('records the submitted order as `position`', async () => {
    // A child table is a set until a column says otherwise, so the order is part of the contract.
    const id = await makeUser();

    await userService.updateUserProfile(id, {
      linksMetadata: [{ url: 'https://second.test' }, { url: 'https://first.test' }],
    });

    const rows = await getDb()
      .select({
        clarityDocumentId: userLinkMetadata.clarityDocumentId,
        position: userLinkMetadata.position,
      })
      .from(userLinkMetadata)
      .where(eq(userLinkMetadata.userId, id))
      .orderBy(asc(userLinkMetadata.position));

    expect(rows).toEqual([
      { clarityDocumentId: 'doc:https://second.test', position: 0 },
      { clarityDocumentId: 'doc:https://first.test', position: 1 },
    ]);
  });

  it('keeps one row per Clarity document, the first position winning', async () => {
    const id = await makeUser();

    await userService.updateUserProfile(id, {
      linksMetadata: [{ url: 'https://same.test' }, { url: 'https://same.test/' }],
    });

    const rows = await getDb()
      .select({ clarityDocumentId: userLinkMetadata.clarityDocumentId })
      .from(userLinkMetadata)
      .where(eq(userLinkMetadata.userId, id));
    expect(rows).toHaveLength(1);
  });

  it('refuses a link that is not https and stores nothing', async () => {
    const id = await makeUser();

    await expect(
      userService.updateUserProfile(id, { linksMetadata: [{ url: 'http://example.com' }] }),
    ).rejects.toBeInstanceOf(BadRequestError);

    const rows = await getDb()
      .select({ id: userLinkMetadata.id })
      .from(userLinkMetadata)
      .where(eq(userLinkMetadata.userId, id));
    expect(rows).toHaveLength(0);
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
    // The defect guarded here is a coordinate-ordering mistake, and the fix has
    // two halves: named columns at the write path (this test) and a
    // GENERATED point so the spatial value cannot disagree with them (the
    // assertion below). Barcelona is 41.4°N, 2.2°E; a transposed pair is a
    // PLAUSIBLE point off the coast of Somalia, so asserting "a row came back"
    // would pass against the exact bug.
    const id = await makeUser();

    await userService.updateUserProfile(id, {
      locations: [{ id: 'loc-1', name: 'Barcelona', coordinates: { lat: 41.3874, lon: 2.1686 } }],
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

    await expect(userService.updateUserProfile(id, { username: 'al ice' })).rejects.toMatchObject({
      statusCode: 400,
      message: USERNAME_INVALID_MESSAGE,
    });
  });

  it('rejects punctuation with a 400', async () => {
    const id = await makeUser();

    await expect(userService.updateUserProfile(id, { username: 'al.ice' })).rejects.toBeInstanceOf(
      BadRequestError,
    );
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
      userService.updateUserProfile(id, { username: taken.toUpperCase() }),
    ).rejects.toThrow('Username already exists');
  });
});
