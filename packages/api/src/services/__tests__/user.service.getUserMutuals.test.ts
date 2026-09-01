/**
 * `getUserMutuals` — "followers you know" about ANOTHER profile.
 *
 * Users U such that the VIEWER follows U **and** U follows the TARGET. It is
 * asymmetric in a way that is easy to get subtly wrong and impossible to see
 * from a query shape: the viewer's side is an outbound edge, the target's side
 * an inbound one. A predicate that reads both from the same column returns the
 * viewer's own followers, or the target's, and both look like a plausible list.
 *
 * The suite this replaces stubbed the aggregation and asserted that the second
 * stage was skipped when the first returned nothing. Every case here seeds the
 * two hops separately so a collapsed direction is visible in the RESULT.
 */

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
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

describe('the two hops are read in the right directions', () => {
  it('returns users the viewer follows who also follow the target', async () => {
    const [viewer, target, known, viewerOnly, targetOnly] = await makeUsers(5);
    await getDb()
      .insert(userFollows)
      .values([
        // The mutual: viewer → known → target.
        { followerId: viewer, followedId: known },
        { followerId: known, followedId: target },
        // Followed by the viewer but does NOT follow the target.
        { followerId: viewer, followedId: viewerOnly },
        // Follows the target but the viewer does NOT follow them.
        { followerId: targetOnly, followedId: target },
      ]);

    const page = await userService.getUserMutuals(viewer, target, { limit: 10 });

    expect(page.total).toBe(1);
    expect(page.data.map((row) => row.id)).toEqual([known]);
  });

  it('does not return someone the viewer follows who the TARGET follows', async () => {
    // The target's side must be INBOUND (they follow the candidate is wrong).
    const [viewer, target, candidate] = await makeUsers(3);
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: candidate },
        { followerId: target, followedId: candidate },
      ]);

    const page = await userService.getUserMutuals(viewer, target, { limit: 10 });

    expect(page.total).toBe(0);
    expect(page.data).toEqual([]);
  });

  it('does not return a target follower the viewer merely follows BACK from', async () => {
    // The viewer's side must be OUTBOUND.
    const [viewer, target, candidate] = await makeUsers(3);
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: candidate, followedId: viewer },
        { followerId: candidate, followedId: target },
      ]);

    const page = await userService.getUserMutuals(viewer, target, { limit: 10 });

    expect(page.total).toBe(0);
  });
});

describe('paging metadata', () => {
  it('reports the full total and a truthful hasMore across pages', async () => {
    const [viewer, target, ...known] = await makeUsers(7);
    await getDb()
      .insert(userFollows)
      .values([
        ...known.map((id) => ({ followerId: viewer, followedId: id })),
        ...known.map((id) => ({ followerId: id, followedId: target })),
      ]);

    const first = await userService.getUserMutuals(viewer, target, { limit: 2, offset: 0 });
    expect(first.total).toBe(5);
    expect(first.data).toHaveLength(2);
    expect(first.hasMore).toBe(true);

    const last = await userService.getUserMutuals(viewer, target, { limit: 2, offset: 4 });
    expect(last.total).toBe(5);
    expect(last.data).toHaveLength(1);
    expect(last.hasMore).toBe(false);

    // Union of the pages is the whole set — no row lost between them.
    const middle = await userService.getUserMutuals(viewer, target, { limit: 2, offset: 2 });
    const seen = [...first.data, ...middle.data, ...last.data].map((row) => row.id);
    expect(new Set(seen).size).toBe(5);
  });

  it('excludes an ineligible mutual from BOTH the page and the total', async () => {
    const [viewer, target, eligible] = await makeUsers(3);
    const [archived] = await makeUsers(1, { accountStatus: 'archived' });
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: eligible },
        { followerId: eligible, followedId: target },
        { followerId: viewer, followedId: archived },
        { followerId: archived, followedId: target },
      ]);

    const page = await userService.getUserMutuals(viewer, target, { limit: 10 });

    expect(page.total).toBe(1);
    expect(page.data.map((row) => row.id)).toEqual([eligible]);
  });
});

describe('degenerate inputs return an empty page, not an error', () => {
  it('has no mutuals for an anonymous viewer', async () => {
    const [target] = await makeUsers(1);

    const page = await userService.getUserMutuals(undefined, target, { limit: 10 });
    expect(page).toMatchObject({ data: [], total: 0, hasMore: false });
  });

  it('has no mutuals with yourself', async () => {
    const [viewer, other] = await makeUsers(2);
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: other },
        { followerId: other, followedId: viewer },
      ]);

    const page = await userService.getUserMutuals(viewer, viewer, { limit: 10 });
    expect(page).toMatchObject({ data: [], total: 0 });
  });

  it('has no mutuals when the viewer follows nobody', async () => {
    const [viewer, target, follower] = await makeUsers(3);
    await getDb().insert(userFollows).values({ followerId: follower, followedId: target });

    const page = await userService.getUserMutuals(viewer, target, { limit: 10 });
    expect(page).toMatchObject({ data: [], total: 0 });
  });

  it('has no mutuals when the two share no one', async () => {
    const [viewer, target, viewerFollows, targetFollower] = await makeUsers(4);
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: viewerFollows },
        { followerId: targetFollower, followedId: target },
      ]);

    const page = await userService.getUserMutuals(viewer, target, { limit: 10 });
    expect(page).toMatchObject({ data: [], total: 0 });
  });

  it('carries the requested limit and offset back on an empty page', async () => {
    // Consumers page off these two fields, so an empty page still has to state
    // where it was.
    const [viewer, target] = await makeUsers(2);

    const page = await userService.getUserMutuals(viewer, target, { limit: 7, offset: 14 });
    expect(page).toEqual({ data: [], total: 0, hasMore: false, limit: 7, offset: 14 });
  });
});
