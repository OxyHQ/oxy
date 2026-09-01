/**
 * The follow graph and the public user DTO, against a REAL Postgres.
 *
 * This suite exists for the two things the port could break SILENTLY — neither
 * raises an error, neither fails a type check, and both are load-bearing:
 *
 * 1. **Pagination is a STRICT TOTAL ORDER.** Every follow-graph page sorts on
 *    `(created_at, id)` BEFORE `OFFSET`/`LIMIT`. `created_at` alone is not
 *    unique, so without the id tiebreak a tied row can appear on two
 *    consecutive pages while another is skipped entirely — infinite scroll
 *    corrupts with no error and no failing request. The test walks every page
 *    of a set whose `created_at` values are ALL IDENTICAL, which is the only
 *    input that can tell a total order from a partial one.
 *
 * 2. **Follower counts are non-zero.** `routes/profiles.ts:540` passed
 *    `.toString()` ids into an aggregation `$match`; Mongoose does not cast
 *    aggregation pipelines, so the match selected nothing and every follower
 *    count on `/profiles/search` read ZERO. A test that only asserts "a number
 *    came back" passes against that exact bug, so these assert the real
 *    arithmetic against edges written in the same test.
 *
 * Plus response parity for `formatUserResponse`, whose input shape changed from
 * a Mongoose document to a flat row and whose output is the wire contract every
 * app in the ecosystem reads.
 *
 * Every assertion goes through the application's own pool against the throwaway
 * database `jest.globalSetup.ts` migrated. No mock, no second migrator. The
 * whole run shares one database, so every row carries a per-test random id and
 * no assertion depends on a table being empty.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userFollows } from '../../db/schema/userFollows';
import { userLinkMetadata } from '../../db/schema/userLinkMetadata';
import { users } from '../../db/schema/users';
import { userService } from '../user.service';

const uniqueId = () => randomUUID().replace(/-/g, '');

/** A minimal, discoverable account. */
async function makeUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const id = uniqueId();
  await getDb()
    .insert(users)
    .values({
      id,
      username: `u${id.slice(0, 12)}`,
      nameFirst: 'Test',
      nameLast: 'Person',
      ...overrides,
    });
  return id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('follow-graph pagination is a strict total order', () => {
  /**
   * Ten followers whose edges share ONE `created_at` value to the microsecond.
   *
   * This is the discriminating input. With a `(created_at, id)` key the order is
   * total and paging is deterministic; with `created_at` alone every row
   * compares EQUAL, Postgres is free to return them in any order per statement,
   * and an offset page can repeat or drop rows. A fixture with distinct
   * timestamps cannot tell the two apart — it passes either way.
   */
  const FOLLOWER_COUNT = 10;
  const PAGE_SIZE = 3;

  let targetId: string;
  let followerIds: string[];
  /** Follower ids in EDGE-ID ascending order — the order `oldest` must produce. */
  let byEdgeIdAscending: string[];

  beforeAll(async () => {
    targetId = await makeUser();
    followerIds = [];
    for (let i = 0; i < FOLLOWER_COUNT; i += 1) {
      followerIds.push(await makeUser());
    }

    // Edge ids are SUPPLIED, digits only (so JS and every Postgres collation
    // agree), and deliberately assigned OUT of insertion order. That is what
    // makes the assertion below discriminating: heap order is insertion order,
    // so a page that is merely "in heap order" cannot also be in edge-id order.
    const edgeIdFor = (index: number) =>
      String((index * 7) % FOLLOWER_COUNT).padStart(24, '0');

    const tiedAt = new Date('2026-03-01T12:00:00.000Z');
    await getDb()
      .insert(userFollows)
      .values(
        followerIds.map((followerId, index) => ({
          id: edgeIdFor(index),
          followerId,
          followedId: targetId,
          createdAt: tiedAt,
          updatedAt: tiedAt,
        }))
      );

    byEdgeIdAscending = followerIds
      .map((followerId, index) => ({ followerId, edgeId: edgeIdFor(index) }))
      .sort((a, b) => a.edgeId.localeCompare(b.edgeId))
      .map((entry) => entry.followerId);
  });

  it.each([
    ['recent' as const],
    ['oldest' as const],
  ])('pages %s without duplicating or skipping a tied row', async (sort) => {
    const seen: string[] = [];
    for (let offset = 0; offset < FOLLOWER_COUNT; offset += PAGE_SIZE) {
      const page = await userService.getUserFollowers(targetId, {
        limit: PAGE_SIZE,
        offset,
        sort,
      });
      expect(page.total).toBe(FOLLOWER_COUNT);
      for (const row of page.data) {
        expect(row.id).toBeDefined();
        seen.push(row.id as string);
      }
    }

    // The two properties a partial order violates: no id twice, and none lost.
    expect(new Set(seen).size).toBe(FOLLOWER_COUNT);
    expect([...seen].sort()).toEqual([...followerIds].sort());

    // ...and the property that DISCRIMINATES. Set equality alone is too weak:
    // with every `created_at` tied, Postgres returns a small heap in insertion
    // order, so dropping the tiebreak still yields disjoint pages and the two
    // assertions above pass against the exact bug. The edge ids were assigned
    // out of insertion order, so ONLY the tiebreak can produce this sequence.
    expect(seen).toEqual(
      sort === 'oldest' ? byEdgeIdAscending : [...byEdgeIdAscending].reverse()
    );
  });

  it('orders `oldest` as the exact reverse of `recent`', async () => {
    const [recent, oldest] = await Promise.all([
      userService.getUserFollowers(targetId, { limit: FOLLOWER_COUNT, sort: 'recent' }),
      userService.getUserFollowers(targetId, { limit: FOLLOWER_COUNT, sort: 'oldest' }),
    ]);
    expect(recent.data.map((row) => row.id)).toEqual(
      oldest.data.map((row) => row.id).reverse()
    );
  });

  it('excludes an archived counterparty from BOTH the page and the total', async () => {
    const archivedId = await makeUser({ accountStatus: 'archived' });
    await getDb().insert(userFollows).values({ followerId: archivedId, followedId: targetId });

    const page = await userService.getUserFollowers(targetId, { limit: 50 });
    expect(page.total).toBe(FOLLOWER_COUNT);
    expect(page.data.map((row) => row.id)).not.toContain(archivedId);
  });
});

describe('follower/following totals are measured, not zero', () => {
  it('counts the edges that exist on both sides', async () => {
    const subjectId = await makeUser();
    const followerIds = [await makeUser(), await makeUser(), await makeUser()];
    const followedIds = [await makeUser(), await makeUser()];

    await getDb()
      .insert(userFollows)
      .values([
        ...followerIds.map((followerId) => ({ followerId, followedId: subjectId })),
        ...followedIds.map((followedId) => ({ followerId: subjectId, followedId })),
      ]);

    const stats = await userService.getUserStats(subjectId);
    // The exact arithmetic, not merely "a number": the bug this replaces
    // returned a well-typed 0 for every account with followers.
    expect(stats).toEqual({ followers: 3, following: 2 });

    const [dto] = await userService.getUsersByIds([subjectId]);
    expect(dto._count).toEqual({ followers: 3, following: 2 });
  });

  it('reports zero only when there really are no edges', async () => {
    const lonelyId = await makeUser();
    expect(await userService.getUserStats(lonelyId)).toEqual({ followers: 0, following: 0 });
  });

  it('moves the totals with follow and unfollow, once each', async () => {
    const a = await makeUser();
    const b = await makeUser();

    const first = await userService.followUser(a, b);
    expect(first.created).toBe(true);
    expect(first.counts).toEqual({ followers: 1, following: 1 });

    // Idempotent: a repeat inserts nothing and cannot move a counter, because
    // there is no counter — the totals are a count of the edges.
    const second = await userService.followUser(a, b);
    expect(second.created).toBe(false);
    expect(second.counts).toEqual({ followers: 1, following: 1 });

    const removed = await userService.unfollowUser(a, b);
    expect(removed.removed).toBe(true);
    expect(removed.counts).toEqual({ followers: 0, following: 0 });

    const again = await userService.unfollowUser(a, b);
    expect(again.removed).toBe(false);
    expect(again.counts).toEqual({ followers: 0, following: 0 });
  });
});

describe('bulk follow and unfollow', () => {
  it('classifies new, already-following, and non-existent targets', async () => {
    const viewer = await makeUser();
    const existing = await makeUser();
    const fresh = await makeUser();
    const missing = uniqueId();

    await getDb().insert(userFollows).values({ followerId: viewer, followedId: existing });

    const result = await userService.bulkFollow(viewer, [
      existing,
      fresh,
      missing,
      viewer, // self is dropped before any query
      fresh, // duplicate is deduped
    ]);

    expect(result.followedCount).toBe(1);
    expect(result.results).toEqual([
      { userId: existing, success: true, alreadyFollowing: true },
      { userId: fresh, success: true, alreadyFollowing: false },
      { userId: missing, success: false, alreadyFollowing: false },
    ]);
  });

  it('removes only the edges that existed, and reports each target', async () => {
    const viewer = await makeUser();
    const followed = await makeUser();
    const notFollowed = await makeUser();

    await getDb().insert(userFollows).values({ followerId: viewer, followedId: followed });

    const result = await userService.bulkUnfollow(viewer, [followed, notFollowed]);
    expect(result.unfollowedCount).toBe(1);
    expect(result.results).toEqual([
      { userId: followed, success: true, wasFollowing: true },
      { userId: notFollowed, success: true, wasFollowing: false },
    ]);

    expect(await userService.getUserStats(viewer)).toEqual({ followers: 0, following: 0 });
  });
});

describe('viewer relationship and follow statuses', () => {
  it('reports each direction independently', async () => {
    const viewer = await makeUser();
    const target = await makeUser();

    expect(await userService.getViewerRelationship(viewer, target)).toEqual({
      isFollowing: false,
      followsYou: false,
    });

    await getDb().insert(userFollows).values({ followerId: viewer, followedId: target });
    expect(await userService.getViewerRelationship(viewer, target)).toEqual({
      isFollowing: true,
      followsYou: false,
    });

    await getDb().insert(userFollows).values({ followerId: target, followedId: viewer });
    expect(await userService.getViewerRelationship(viewer, target)).toEqual({
      isFollowing: true,
      followsYou: true,
    });
  });

  it('answers every requested id, including one that names no account', async () => {
    const viewer = await makeUser();
    const followed = await makeUser();
    const other = await makeUser();
    const missing = uniqueId();

    await getDb().insert(userFollows).values({ followerId: viewer, followedId: followed });

    expect(await userService.getFollowingStatuses(viewer, [followed, other, missing])).toEqual({
      [followed]: true,
      [other]: false,
      [missing]: false,
    });
  });
});

describe('purgeUserSocialGraph', () => {
  it('removes every edge in both directions and reports the count', async () => {
    const subject = await makeUser();
    const follower = await makeUser();
    const followed = await makeUser();

    await getDb()
      .insert(userFollows)
      .values([
        { followerId: follower, followedId: subject },
        { followerId: subject, followedId: followed },
      ]);

    const { followEdgesRemoved } = await userService.purgeUserSocialGraph(subject);
    expect(followEdgesRemoved).toBe(2);
    expect(await userService.getUserStats(subject)).toEqual({ followers: 0, following: 0 });
    expect(await userService.getUserStats(follower)).toEqual({ followers: 0, following: 0 });
    expect(await userService.getUserStats(followed)).toEqual({ followers: 0, following: 0 });
  });
});

describe('public user DTO parity', () => {
  it('emits the documented wire shape from a flat row', async () => {
    const id = await makeUser({
      nameFirst: 'Ada',
      nameLast: 'Lovelace',
      avatar: 'file-1',
      color: 'blue',
      bio: 'Analytical',
      description: 'Engines',
      links: ['https://example.test'],
      verified: true,
      type: 'federated',
      federationActorUri: 'https://remote.test/users/ada',
      federationDomain: 'remote.test',
    });
    await getDb()
      .insert(userLinkMetadata)
      .values({
        userId: id,
        position: 0,
        url: 'https://example.test',
        title: 'Example',
        description: 'An example',
        image: null,
      });

    const view = await userService.getPublicUserById(id);
    expect(view).not.toBeNull();
    const dto = userService.formatUserResponse(view as NonNullable<typeof view>, {
      followers: 0,
      following: 0,
    });

    expect(dto.id).toBe(id);
    // `name.displayName` is the canonical contract every ecosystem app renders.
    expect(dto.name).toMatchObject({
      first: 'Ada',
      last: 'Lovelace',
      full: 'Ada Lovelace',
      displayName: 'Ada Lovelace',
    });
    expect(dto.avatar).toBe('file-1');
    expect(dto.color).toBe('blue');
    expect(dto.bio).toBe('Analytical');
    expect(dto.description).toBe('Engines');
    expect(dto.links).toEqual(['https://example.test']);
    expect(dto.linksMetadata).toEqual([
      { url: 'https://example.test', title: 'Example', description: 'An example', image: null },
    ]);
    expect(dto.verified).toBe(true);
    expect(dto.isFederated).toBe(true);
    expect(dto.federation).toEqual({
      actorUri: 'https://remote.test/users/ada',
      domain: 'remote.test',
    });
    expect(dto.fediverseSharing).toBe(true);
    expect(dto._count).toEqual({ followers: 0, following: 0 });

    // The `toJSON` transform's deletes are the response contract: no `_id`, no
    // contact-discovery hashes, no credential material on a public DTO.
    expect(dto).not.toHaveProperty('_id');
    expect(dto).not.toHaveProperty('hashedEmail');
    expect(dto).not.toHaveProperty('hashedPhone');
    expect(dto).not.toHaveProperty('password');
    expect(dto).not.toHaveProperty('refreshToken');
    expect(dto).not.toHaveProperty('email');
    // Owner-only fields stay off a public DTO.
    expect(dto).not.toHaveProperty('phone');
    expect(dto).not.toHaveProperty('address');
    expect(dto).not.toHaveProperty('birthday');
    expect(dto).not.toHaveProperty('themePreference');
  });

  it('carries the owner-only fields ONLY under includePrivateFields', async () => {
    const id = await makeUser({
      phone: '+34600000000',
      address: '1 Test Street',
      birthday: '1990-01-01',
      themePreferenceMode: 'dark',
      themePreferenceColorPreset: 'blue',
    });

    const view = await userService.getCurrentUser(id);
    expect(view).not.toBeNull();
    const self = userService.formatUserResponse(
      view as NonNullable<typeof view>,
      undefined,
      { includePrivateFields: true }
    );
    expect(self.phone).toBe('+34600000000');
    expect(self.address).toBe('1 Test Street');
    expect(self.birthday).toBe('1990-01-01');
    expect(self.themePreference).toEqual({ mode: 'dark', colorPreset: 'blue' });

    const publicDto = userService.formatUserResponse(view as NonNullable<typeof view>);
    expect(publicDto).not.toHaveProperty('phone');
    expect(publicDto).not.toHaveProperty('themePreference');
  });

  it('omits `fediverseSharing` consent and `federation` per the stored row', async () => {
    const localId = await makeUser({ privacyFediverseSharing: false });
    const view = await userService.getPublicUserById(localId);
    const dto = userService.formatUserResponse(view as NonNullable<typeof view>);
    expect(dto.fediverseSharing).toBe(false);
    expect(dto.federation).toBeUndefined();
    expect(dto.isFederated).toBe(false);
  });
});

describe('privacy settings', () => {
  it('returns every key and merges only what was supplied', async () => {
    const id = await makeUser();

    const initial = await userService.readPrivacySettings(id);
    expect(initial).not.toBeNull();
    expect(Object.keys(initial as NonNullable<typeof initial>)).toHaveLength(22);
    expect(initial).toMatchObject({ isPrivateAccount: false, fediverseSharing: true });

    const updated = await userService.updatePrivacySettings(id, { isPrivateAccount: true });
    expect(updated).toMatchObject({
      isPrivateAccount: true,
      // Untouched by the patch — a whole-object replace would have reset it.
      fediverseSharing: true,
      profileVisibility: true,
    });

    const [row] = await getDb()
      .select({ isPrivate: users.privacyIsPrivateAccount })
      .from(users)
      .where(eq(users.id, id));
    expect(row.isPrivate).toBe(true);
  });

  it('answers null for an id that names no account', async () => {
    expect(await userService.readPrivacySettings(uniqueId())).toBeNull();
  });
});

describe('contact hashes stay generated and unreachable', () => {
  it('never reaches a public DTO, and is still computed by the database', async () => {
    const id = await makeUser({ email: 'Parity@Example.test' });

    const [row] = await getDb()
      .select({ hashedEmail: users.hashedEmail })
      .from(users)
      .where(eq(users.id, id));
    // GENERATED, so the write path could not have skipped it.
    expect(row.hashedEmail).toMatch(/^[0-9a-f]{64}$/);

    const view = await userService.getPublicUserById(id);
    expect(view).not.toHaveProperty('hashedEmail');
    expect(userService.formatUserResponse(view as NonNullable<typeof view>)).not.toHaveProperty(
      'hashedEmail'
    );
  });
});

describe('follows-of-follows', () => {
  it('ranks by how many of the viewer’s follows follow each candidate', async () => {
    const viewer = await makeUser();
    const hopA = await makeUser();
    const hopB = await makeUser();
    const popular = await makeUser();
    const single = await makeUser();

    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: hopA },
        { followerId: viewer, followedId: hopB },
        { followerId: hopA, followedId: popular },
        { followerId: hopB, followedId: popular },
        { followerId: hopA, followedId: single },
      ]);

    const ids = await userService.getFollowsOfFollowsIds(viewer);
    expect(ids.slice(0, 2)).toEqual([popular, single]);
    // The viewer's own follows, and the viewer, are never recommendations.
    expect(ids).not.toContain(hopA);
    expect(ids).not.toContain(hopB);
    expect(ids).not.toContain(viewer);
  });
});

describe('mutuals', () => {
  it('is the bidirectional intersection, most recent first', async () => {
    const viewer = await makeUser();
    const mutual = await makeUser();
    const oneWay = await makeUser();

    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: mutual },
        { followerId: mutual, followedId: viewer },
        { followerId: viewer, followedId: oneWay },
      ]);

    expect(await userService.getMutualUserIds(viewer)).toEqual([mutual]);
  });

  it('is empty for an anonymous viewer and for a self-target', async () => {
    const viewer = await makeUser();
    expect(await userService.getMutualUserIds(undefined)).toEqual([]);
    const page = await userService.getUserMutuals(viewer, viewer);
    expect(page.data).toEqual([]);
    expect(page.total).toBe(0);
  });
});

describe('viewer graph', () => {
  it('returns following, mutuals, blocked and restricted as bare ids', async () => {
    const viewer = await makeUser();
    const followed = await makeUser();
    const mutual = await makeUser();

    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: followed },
        { followerId: viewer, followedId: mutual },
        { followerId: mutual, followedId: viewer },
      ]);

    const graph = await userService.getViewerGraph(viewer);
    expect([...graph.followingIds].sort()).toEqual([followed, mutual].sort());
    expect(graph.mutualIds).toEqual([mutual]);
    expect(graph.blockedIds).toEqual([]);
    expect(graph.restrictedIds).toEqual([]);
  });

  it('is empty without a viewer', async () => {
    expect(await userService.getViewerGraph(undefined)).toEqual({
      followingIds: [],
      mutualIds: [],
      blockedIds: [],
      restrictedIds: [],
    });
  });
});

describe('profile writes', () => {
  it('persists a whitelisted update and rejects a duplicate username', async () => {
    const id = await makeUser();
    const other = await makeUser({ username: `taken${uniqueId().slice(0, 8)}` });

    const [otherRow] = await getDb()
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, other));

    const updated = await userService.updateUserProfile(id, {
      bio: 'ported',
      name: { first: 'Grace', last: 'Hopper' },
    });
    expect(updated.bio).toBe('ported');
    expect(updated.name).toEqual({ first: 'Grace', last: 'Hopper' });

    // Case-insensitively unique — the index is on `lower(btrim(username))`, so
    // an uppercase spelling must be rejected here rather than by the constraint.
    await expect(
      userService.updateUserProfile(id, {
        username: (otherRow.username as string).toUpperCase(),
      })
    ).rejects.toThrow('Username already exists');
  });

  it('replaces the link-metadata child rows in submitted order', async () => {
    const id = await makeUser();

    await userService.updateUserProfile(id, {
      linksMetadata: [
        { url: 'https://b.test', title: 'B', description: 'second' },
        { url: 'https://a.test', title: 'A', description: 'first' },
      ],
    });

    const rows = await getDb()
      .select({ url: userLinkMetadata.url, position: userLinkMetadata.position })
      .from(userLinkMetadata)
      .where(eq(userLinkMetadata.userId, id))
      .orderBy(userLinkMetadata.position);
    expect(rows).toEqual([
      { url: 'https://b.test', position: 0 },
      { url: 'https://a.test', position: 1 },
    ]);

    // A second write REPLACES rather than appends — an embedded array was
    // overwritten wholesale, and a child table has to be told to be.
    await userService.updateUserProfile(id, {
      linksMetadata: [{ url: 'https://c.test', title: 'C', description: 'only' }],
    });
    const [{ n }] = await getDb()
      .select({ n: sql<number>`count(*)::int` })
      .from(userLinkMetadata)
      .where(eq(userLinkMetadata.userId, id));
    expect(n).toBe(1);
  });
});
