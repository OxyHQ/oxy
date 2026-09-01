/**
 * The five child tables extracted out of the `User` document, against a REAL
 * Postgres.
 *
 * `locations`, `linksMetadata`, `authMethods`, `verifiedDomains` and `ancestors`
 * were embedded arrays. Each became a table for a reason recorded in its own
 * module; this file checks the reasons hold — the relations are real, the
 * constraints fire, the coordinate fix is in place, and deleting an account does
 * what its `ON DELETE` says rather than what it looks like it says.
 */

import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../config/postgres';
import { userAncestors } from '../userAncestors';
import { userAuthMethods } from '../userAuthMethods';
import { userLinkMetadata } from '../userLinkMetadata';
import { userLocations } from '../userLocations';
import { users } from '../users';
import { userVerifiedDomains } from '../userVerifiedDomains';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';
/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503';
/** Postgres `check_violation`. */
const CHECK_VIOLATION = '23514';

const unique = () => randomUUID().replace(/-/g, '');

function pgErrorCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code: unknown = Reflect.get(current, 'code');
    if (typeof code === 'string') return code;
  }
  return undefined;
}

async function rejection(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the query to be rejected by a constraint, but it succeeded.');
}

async function insertUser(values: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ color: 'teal', ...values })
    .returning({ id: users.id });
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('user_locations — coordinates are named, not positional', () => {
  it('stores latitude and longitude in their own columns', async () => {
    // The Mongo defect this fixes is positional: a 2dsphere index over
    // `{ lat, lon }` reads the FIRST field as longitude, so every indexed point
    // was transposed. Round-tripping through named columns is what proves the
    // ordering can no longer be misread — Barcelona is 41.39N 2.17E, and a
    // transposition would put it in the Indian Ocean.
    const userId = await insertUser();
    const [row] = await getDb()
      .insert(userLocations)
      .values({
        userId,
        locationKey: `home-${unique()}`,
        name: 'Casa Nate',
        latitude: 41.3874,
        longitude: 2.1686,
      })
      .returning({ latitude: userLocations.latitude, longitude: userLocations.longitude });

    expect(row.latitude).toBeCloseTo(41.3874, 4);
    expect(row.longitude).toBeCloseTo(2.1686, 4);
  });

  it('rejects a latitude or longitude outside its range', async () => {
    const userId = await insertUser();
    const outOfRange = await rejection(
      getDb().insert(userLocations).values({
        userId,
        locationKey: unique(),
        name: 'Nowhere',
        latitude: 91,
        longitude: 0,
      })
    );
    expect(pgErrorCode(outOfRange)).toBe(CHECK_VIOLATION);

    // 91 is out of range for a LATITUDE and fine for a longitude — so this pair
    // passing is what proves the two checks are not the same check twice.
    await expect(
      getDb().insert(userLocations).values({
        userId,
        locationKey: unique(),
        name: 'Somewhere',
        latitude: 0,
        longitude: 91,
      })
    ).resolves.toBeDefined();
  });

  it('rejects half a coordinate, which Mongo permitted', async () => {
    const userId = await insertUser();
    const error = await rejection(
      getDb().insert(userLocations).values({
        userId,
        locationKey: unique(),
        name: 'Half',
        latitude: 41.3874,
      })
    );
    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('scopes the client-supplied key to one user', async () => {
    const userId = await insertUser();
    const locationKey = `home-${unique()}`;
    await getDb().insert(userLocations).values({ userId, locationKey, name: 'First' });

    const error = await rejection(
      getDb().insert(userLocations).values({ userId, locationKey, name: 'Second' })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);

    // Another user may reuse the same key — it is unique per profile, not global.
    await expect(
      getDb()
        .insert(userLocations)
        .values({ userId: await insertUser(), locationKey, name: 'Theirs' })
    ).resolves.toBeDefined();
  });

  it('builds a search vector over name and formatted address', async () => {
    // The replacement for Mongo's text index. A generated column, so it cannot
    // be left unpopulated by a write path that forgets it.
    const userId = await insertUser();
    const token = `zx${unique().slice(0, 10)}`;
    await getDb().insert(userLocations).values({
      userId,
      locationKey: unique(),
      name: `Casa ${token}`,
      formattedAddress: 'Carrer Gran 4, Barcelona',
    });

    const byName = await getDb()
      .select({ id: userLocations.id })
      .from(userLocations)
      .where(
        and(
          eq(userLocations.userId, userId),
          sql`${userLocations.searchVector} @@ to_tsquery('english', ${token})`
        )
      );
    expect(byName).toHaveLength(1);

    const byAddress = await getDb()
      .select({ id: userLocations.id })
      .from(userLocations)
      .where(
        and(
          eq(userLocations.userId, userId),
          sql`${userLocations.searchVector} @@ to_tsquery('english', 'barcelona')`
        )
      );
    expect(byAddress).toHaveLength(1);

    // A word in neither field must NOT match, or the assertions above would pass
    // for a vector containing everything.
    const byNothing = await getDb()
      .select({ id: userLocations.id })
      .from(userLocations)
      .where(
        and(
          eq(userLocations.userId, userId),
          sql`${userLocations.searchVector} @@ to_tsquery('english', 'reykjavik')`
        )
      );
    expect(byNothing).toHaveLength(0);
  });
});

describe('user_ancestors — the materialized path', () => {
  it('keeps the root-first order the array had', async () => {
    const root = await insertUser();
    const org = await insertUser({ parentAccountId: root, rootAccountId: root });
    const project = await insertUser({ parentAccountId: org, rootAccountId: root });

    await getDb()
      .insert(userAncestors)
      .values([
        { userId: project, depth: 0, ancestorId: root },
        { userId: project, depth: 1, ancestorId: org },
      ]);

    const path = await getDb()
      .select({ ancestorId: userAncestors.ancestorId })
      .from(userAncestors)
      .where(eq(userAncestors.userId, project))
      .orderBy(asc(userAncestors.depth));

    // `childAncestorsOf` builds `[...parent.ancestors, parent._id]`, so depth 0
    // is the tree root and the last entry is the immediate parent.
    expect(path.map((row) => row.ancestorId)).toEqual([root, org]);
  });

  it('answers the subtree query the path exists for', async () => {
    const root = await insertUser();
    const org = await insertUser();
    const project = await insertUser();
    await getDb()
      .insert(userAncestors)
      .values([
        { userId: org, depth: 0, ancestorId: root },
        { userId: project, depth: 0, ancestorId: root },
        { userId: project, depth: 1, ancestorId: org },
      ]);

    const descendants = await getDb()
      .select({ userId: userAncestors.userId })
      .from(userAncestors)
      .where(eq(userAncestors.ancestorId, root));

    expect(descendants.map((row) => row.userId).sort()).toEqual([org, project].sort());
  });

  it('permits one ancestor per position and no more', async () => {
    const userId = await insertUser();
    const first = await insertUser();
    const second = await insertUser();
    await getDb().insert(userAncestors).values({ userId, depth: 0, ancestorId: first });

    const error = await rejection(
      getDb().insert(userAncestors).values({ userId, depth: 0, ancestorId: second })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('rejects a self-ancestor and a depth past the cap', async () => {
    const userId = await insertUser();
    const other = await insertUser();

    const self = await rejection(
      getDb().insert(userAncestors).values({ userId, depth: 0, ancestorId: userId })
    );
    expect(pgErrorCode(self)).toBe(CHECK_VIOLATION);

    const tooDeep = await rejection(
      getDb().insert(userAncestors).values({ userId, depth: 8, ancestorId: other })
    );
    expect(pgErrorCode(tooDeep)).toBe(CHECK_VIOLATION);

    await expect(
      getDb().insert(userAncestors).values({ userId, depth: 7, ancestorId: other })
    ).resolves.toBeDefined();
  });

  it('refuses an ancestor that does not exist — the guarantee Mongo never had', async () => {
    const userId = await insertUser();
    const error = await rejection(
      getDb()
        .insert(userAncestors)
        .values({ userId, depth: 0, ancestorId: `ghost-${unique()}` })
    );
    expect(pgErrorCode(error)).toBe(FOREIGN_KEY_VIOLATION);
  });
});

describe('user_auth_methods', () => {
  it('requires the identifier its own type is addressed by', async () => {
    const userId = await insertUser();

    const noKey = await rejection(
      getDb().insert(userAuthMethods).values({ userId, type: 'identity' })
    );
    expect(pgErrorCode(noKey)).toBe(CHECK_VIOLATION);

    const noCredential = await rejection(
      getDb().insert(userAuthMethods).values({ userId, type: 'webauthn' })
    );
    expect(pgErrorCode(noCredential)).toBe(CHECK_VIOLATION);

    // An identity key does not satisfy a webauthn row, and vice versa.
    const wrongIdentifier = await rejection(
      getDb()
        .insert(userAuthMethods)
        .values({ userId, type: 'webauthn', methodPublicKey: `04${unique()}` })
    );
    expect(pgErrorCode(wrongIdentifier)).toBe(CHECK_VIOLATION);
  });

  it('binds one identity key to one account, case-insensitively', async () => {
    const key = `04AB${unique().toUpperCase()}`;
    await getDb()
      .insert(userAuthMethods)
      .values({ userId: await insertUser(), type: 'identity', methodPublicKey: key });

    const error = await rejection(
      getDb().insert(userAuthMethods).values({
        userId: await insertUser(),
        type: 'identity',
        methodPublicKey: key.toLowerCase(),
      })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('lets one account carry several passkeys', async () => {
    const userId = await insertUser();
    await expect(
      getDb()
        .insert(userAuthMethods)
        .values([
          { userId, type: 'webauthn', methodCredentialId: unique(), methodName: 'Laptop' },
          { userId, type: 'webauthn', methodCredentialId: unique(), methodName: 'Phone' },
        ])
    ).resolves.toBeDefined();
  });
});

describe('user_verified_domains', () => {
  it('lets one account claim a domain once, in any case', async () => {
    const userId = await insertUser();
    const domain = `${unique()}.example`;
    await getDb()
      .insert(userVerifiedDomains)
      .values({ userId, domain: domain.toUpperCase(), verifiedAt: new Date(), method: 'dns-txt' });

    const error = await rejection(
      getDb()
        .insert(userVerifiedDomains)
        .values({ userId, domain, verifiedAt: new Date(), method: 'well-known' })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('permits two accounts to claim the same domain — a real condition, not an error', async () => {
    const domain = `${unique()}.example`;
    await getDb()
      .insert(userVerifiedDomains)
      .values({ userId: await insertUser(), domain, verifiedAt: new Date(), method: 'dns-txt' });

    await expect(
      getDb()
        .insert(userVerifiedDomains)
        .values({ userId: await insertUser(), domain, verifiedAt: new Date(), method: 'dns-txt' })
    ).resolves.toBeDefined();
  });
});

describe('user_link_metadata', () => {
  it('keeps the user-chosen order and permits one entry per position', async () => {
    const userId = await insertUser();
    await getDb()
      .insert(userLinkMetadata)
      .values([
        { userId, position: 1, url: 'https://b.example', title: 'B', description: 'b' },
        { userId, position: 0, url: 'https://a.example', title: 'A', description: 'a' },
      ]);

    const ordered = await getDb()
      .select({ title: userLinkMetadata.title })
      .from(userLinkMetadata)
      .where(eq(userLinkMetadata.userId, userId))
      .orderBy(asc(userLinkMetadata.position));
    expect(ordered.map((row) => row.title)).toEqual(['A', 'B']);

    const error = await rejection(
      getDb()
        .insert(userLinkMetadata)
        .values({ userId, position: 0, url: 'https://c.example', title: 'C', description: 'c' })
    );
    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });
});

describe('deleting an account', () => {
  it('takes its own children with it and leaves the tree standing', async () => {
    const root = await insertUser();
    const org = await insertUser({ parentAccountId: root, rootAccountId: root });
    const bot = await insertUser({ type: 'automated', automationOwnerId: root });

    await getDb()
      .insert(userLocations)
      .values({ userId: root, locationKey: unique(), name: 'Home' });
    await getDb()
      .insert(userLinkMetadata)
      .values({ userId: root, position: 0, url: 'https://a.example', title: 'A', description: 'a' });
    await getDb()
      .insert(userVerifiedDomains)
      .values({ userId: root, domain: `${unique()}.example`, verifiedAt: new Date(), method: 'dns-txt' });
    await getDb()
      .insert(userAuthMethods)
      .values({ userId: root, type: 'identity', methodPublicKey: `04${unique()}` });
    await getDb().insert(userAncestors).values({ userId: org, depth: 0, ancestorId: root });

    await getDb().delete(users).where(eq(users.id, root));

    // Owned rows are gone.
    for (const [label, rows] of [
      ['locations', await getDb().select().from(userLocations).where(eq(userLocations.userId, root))],
      ['links', await getDb().select().from(userLinkMetadata).where(eq(userLinkMetadata.userId, root))],
      ['domains', await getDb().select().from(userVerifiedDomains).where(eq(userVerifiedDomains.userId, root))],
      ['authMethods', await getDb().select().from(userAuthMethods).where(eq(userAuthMethods.userId, root))],
      ['ancestorEdges', await getDb().select().from(userAncestors).where(eq(userAncestors.ancestorId, root))],
    ] as const) {
      expect({ [label]: rows.length }).toEqual({ [label]: 0 });
    }

    // The organization SURVIVES its founder and becomes a root; the bot survives
    // and becomes ownerless. Both are `SET NULL`, and NULL already means exactly
    // that in each column — the deliberate alternative to cascading a GDPR
    // erasure into other people's accounts.
    const [survivingOrg] = await getDb()
      .select({
        parentAccountId: users.parentAccountId,
        rootAccountId: users.rootAccountId,
      })
      .from(users)
      .where(eq(users.id, org));
    expect(survivingOrg).toEqual({ parentAccountId: null, rootAccountId: null });

    const [survivingBot] = await getDb()
      .select({ automationOwnerId: users.automationOwnerId, type: users.type })
      .from(users)
      .where(eq(users.id, bot));
    expect(survivingBot).toEqual({ automationOwnerId: null, type: 'automated' });
  });
});
