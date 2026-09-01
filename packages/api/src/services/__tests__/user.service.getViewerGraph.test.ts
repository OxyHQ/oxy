/**
 * `getViewerGraph` — the viewer's OWN social graph as one ids-only payload.
 *
 * Four independent reads (following, mutuals, blocked, restricted) run in
 * parallel and are assembled into one object. The suite this replaces asserted
 * that four mocked models were each queried with a particular filter, and that
 * `$limit` stages carried particular numbers. That could not catch the failure
 * this shape is prone to and which a caller would actually suffer: two lists
 * SWAPPED, or one list assembled from another's rows. Every list has the same
 * type (`string[]`), so nothing upstream complains — a blocked account simply
 * appears in `followingIds` and the consumer renders it.
 *
 * So each list is seeded with a DISJOINT set here and every assertion states
 * both what a list contains and what it must not.
 *
 * `blocked` and `restricted` matter most: they are the viewer's own safety
 * lists, and this is the only server-side read of the restrictions a delegated
 * caller can make (the `/privacy/restricted` router is user-auth only).
 */

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { blocks } from '../../db/schema/blocks';
import { restrictions } from '../../db/schema/restrictions';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import { userService } from '../user.service';

const uniqueId = () => randomUUID().replace(/-/g, '');

async function makeUsers(
  count: number,
  overrides: Partial<typeof users.$inferInsert> = {}
): Promise<string[]> {
  const ids = Array.from({ length: count }, () => uniqueId());
  await getDb()
    .insert(users)
    .values(ids.map((id) => ({ id, username: `u${id}`, ...overrides })));
  return ids;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('the four lists are assembled from their own rows', () => {
  it('keeps following, mutual, blocked and restricted disjoint and correct', async () => {
    const [viewer, followedOnly, mutual, blocked, restricted] = await makeUsers(5);

    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: followedOnly },
        { followerId: viewer, followedId: mutual },
        { followerId: mutual, followedId: viewer },
      ]);
    await getDb().insert(blocks).values({ userId: viewer, blockedId: blocked });
    await getDb().insert(restrictions).values({ userId: viewer, restrictedId: restricted });

    const graph = await userService.getViewerGraph(viewer);

    expect([...graph.followingIds].sort()).toEqual([followedOnly, mutual].sort());
    // `mutualIds` is a SUBSET of following, not a separate axis.
    expect(graph.mutualIds).toEqual([mutual]);
    expect(graph.blockedIds).toEqual([blocked]);
    expect(graph.restrictedIds).toEqual([restricted]);

    // The swap this shape invites: each safety list must hold ONLY its own ids.
    expect(graph.blockedIds).not.toContain(restricted);
    expect(graph.restrictedIds).not.toContain(blocked);
    expect(graph.followingIds).not.toContain(blocked);
    expect(graph.followingIds).not.toContain(restricted);
  });

  it('reads the viewer’s own direction of block and restriction', async () => {
    // Being blocked BY someone is not the same as blocking them, and the two
    // columns of `blocks` are both user ids — so a predicate on the wrong one
    // silently reports the inverse relationship.
    const [viewer, blockedByThem, restrictedByThem] = await makeUsers(3);
    await getDb().insert(blocks).values({ userId: blockedByThem, blockedId: viewer });
    await getDb()
      .insert(restrictions)
      .values({ userId: restrictedByThem, restrictedId: viewer });

    const graph = await userService.getViewerGraph(viewer);

    expect(graph.blockedIds).toEqual([]);
    expect(graph.restrictedIds).toEqual([]);
  });

  it('does not mix in another viewer’s graph', async () => {
    const [viewer, stranger, theirFollow, theirBlock] = await makeUsers(4);
    await getDb()
      .insert(userFollows)
      .values({ followerId: stranger, followedId: theirFollow });
    await getDb().insert(blocks).values({ userId: stranger, blockedId: theirBlock });

    expect(await userService.getViewerGraph(viewer)).toEqual({
      followingIds: [],
      mutualIds: [],
      blockedIds: [],
      restrictedIds: [],
    });
  });
});

describe('eligibility', () => {
  it('drops an archived or restricted-tier account from following and mutuals', async () => {
    const [viewer, visible] = await makeUsers(2);
    const [archived] = await makeUsers(1, { accountStatus: 'archived' });
    const [restrictedTier] = await makeUsers(1, { reputationTier: 'restricted' });

    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: visible },
        { followerId: visible, followedId: viewer },
        { followerId: viewer, followedId: archived },
        { followerId: archived, followedId: viewer },
        { followerId: viewer, followedId: restrictedTier },
        { followerId: restrictedTier, followedId: viewer },
      ]);

    const graph = await userService.getViewerGraph(viewer);

    expect(graph.followingIds).toEqual([visible]);
    expect(graph.mutualIds).toEqual([visible]);
  });

  it('keeps a blocked account on the block list even if it is archived', async () => {
    // The safety lists are not a discovery surface: forgetting someone is
    // blocked because their account went dormant would un-block them.
    const [viewer] = await makeUsers(1);
    const [archived] = await makeUsers(1, { accountStatus: 'archived' });
    await getDb().insert(blocks).values({ userId: viewer, blockedId: archived });

    expect((await userService.getViewerGraph(viewer)).blockedIds).toEqual([archived]);
  });
});

describe('bounds', () => {
  it('honours caller limits on following and on the two safety lists', async () => {
    const [viewer, ...others] = await makeUsers(7);
    const followed = others.slice(0, 3);
    const blockedIds = others.slice(3, 6);

    await getDb()
      .insert(userFollows)
      .values(followed.map((id) => ({ followerId: viewer, followedId: id })));
    await getDb()
      .insert(blocks)
      .values(blockedIds.map((id) => ({ userId: viewer, blockedId: id })));
    await getDb()
      .insert(restrictions)
      .values(blockedIds.map((id) => ({ userId: viewer, restrictedId: id })));

    const graph = await userService.getViewerGraph(viewer, {
      followingLimit: 2,
      blockedLimit: 1,
    });

    expect(graph.followingIds).toHaveLength(2);
    // ONE limit governs both safety lists — stated so a divergence is visible.
    expect(graph.blockedIds).toHaveLength(1);
    expect(graph.restrictedIds).toHaveLength(1);
    // Whatever came back is a real member of the seeded set, not a stray id.
    for (const id of graph.followingIds) expect(followed).toContain(id);
    for (const id of graph.blockedIds) expect(blockedIds).toContain(id);
  });

  it('treats a zero or negative limit as "use the cap"', async () => {
    const [viewer, ...followed] = await makeUsers(4);
    await getDb()
      .insert(userFollows)
      .values(followed.map((id) => ({ followerId: viewer, followedId: id })));

    const graph = await userService.getViewerGraph(viewer, {
      followingLimit: 0,
      blockedLimit: -1,
    });

    expect([...graph.followingIds].sort()).toEqual([...followed].sort());
  });
});

describe('an anonymous viewer', () => {
  it('gets an all-empty graph', async () => {
    expect(await userService.getViewerGraph(undefined)).toEqual({
      followingIds: [],
      mutualIds: [],
      blockedIds: [],
      restrictedIds: [],
    });
    expect(await userService.getViewerGraph('')).toEqual({
      followingIds: [],
      mutualIds: [],
      blockedIds: [],
      restrictedIds: [],
    });
  });
});
