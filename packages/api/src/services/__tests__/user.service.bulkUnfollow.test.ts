/**
 * `bulkUnfollow` — idempotent, unfollow-only, and honest about what it removed.
 *
 * The suite this replaces tested counter arithmetic: "decrements counters only
 * for follow documents actually deleted". Those counters are GONE — the port
 * deleted `users.following[]` / `followers[]` / `_count`, and every total is now
 * a `count(*)` over `user_follows` (`db/MIGRATION-CONTRACT.md`). The property
 * the old tests were protecting survives the change and is what is asserted
 * here: after a partly-redundant bulk unfollow, the totals equal the edges that
 * are actually left. It is a stronger check, because a measurement cannot drift
 * from the rows the way a maintained counter could.
 *
 * `wasFollowing` is the other half of the contract and is NOT decoration: it is
 * derived from `DELETE ... RETURNING`, so it names exactly the rows THIS call
 * removed. A target that was never followed is `success: true, wasFollowing:
 * false` — the desired end state already held — and must never be counted.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import userCache from '../../utils/userCache';
import { userService } from '../user.service';

const uniqueId = () => randomUUID().replace(/-/g, '');

async function makeUser(): Promise<string> {
  const id = uniqueId();
  await getDb().insert(users).values({ id, username: `u${id}` });
  return id;
}

async function follow(followerId: string, followedId: string): Promise<void> {
  await getDb().insert(userFollows).values({ followerId, followedId });
}

async function edgeExists(followerId: string, followedId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: userFollows.id })
    .from(userFollows)
    .where(
      and(eq(userFollows.followerId, followerId), eq(userFollows.followedId, followedId))
    );
  return rows.length === 1;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('bulkUnfollow removes exactly the edges that existed', () => {
  it('reports each target and leaves the totals equal to the surviving edges', async () => {
    const viewer = await makeUser();
    const followedA = await makeUser();
    const followedB = await makeUser();
    const neverFollowed = await makeUser();
    const keep = await makeUser();

    await follow(viewer, followedA);
    await follow(viewer, followedB);
    await follow(viewer, keep);

    const result = await userService.bulkUnfollow(viewer, [
      followedA,
      followedB,
      neverFollowed,
    ]);

    expect(result.unfollowedCount).toBe(2);
    expect(result.results).toEqual([
      { userId: followedA, success: true, wasFollowing: true },
      { userId: followedB, success: true, wasFollowing: true },
      // Not an error: unfollow is idempotent, so "already not following" is a
      // success that must not be counted.
      { userId: neverFollowed, success: true, wasFollowing: false },
    ]);

    expect(await edgeExists(viewer, followedA)).toBe(false);
    expect(await edgeExists(viewer, followedB)).toBe(false);
    // The untargeted edge survives — a `DELETE` scoped only by follower would
    // remove it and still satisfy every count above if `keep` were not here.
    expect(await edgeExists(viewer, keep)).toBe(true);

    expect(await userService.getUserStats(viewer)).toEqual({ followers: 0, following: 1 });
    expect(await userService.getUserStats(followedA)).toEqual({ followers: 0, following: 0 });
  });

  it('invalidates only the ids whose edge moved, and tags every one `graph`', async () => {
    const invalidate = jest.spyOn(userCache, 'invalidate');
    try {
      const viewer = await makeUser();
      const followed = await makeUser();
      const neverFollowed = await makeUser();
      await follow(viewer, followed);

      await userService.bulkUnfollow(viewer, [followed, neverFollowed]);

      // Tagged `'graph'` so nothing goes on the cross-service invalidation
      // channel: this call moves up to 200 edges and none of them touch
      // identity. Asserting the TAG (not just the id) is what keeps a future
      // edit from silently turning one bulk unfollow into a 200-message
      // broadcast — `invalidate` defaults to `'profile'`, which publishes.
      expect(invalidate).toHaveBeenCalledWith(viewer, 'graph');
      expect(invalidate).toHaveBeenCalledWith(followed, 'graph');
      // A target whose edge did not exist is not a change, so it is not evicted.
      expect(invalidate).not.toHaveBeenCalledWith(neverFollowed, 'graph');
      expect(invalidate.mock.calls.every(([, reason]) => reason === 'graph')).toBe(true);
    } finally {
      invalidate.mockRestore();
    }
  });

  it('is idempotent — a second identical call removes nothing and counts nothing', async () => {
    const viewer = await makeUser();
    const target = await makeUser();
    await follow(viewer, target);

    const first = await userService.bulkUnfollow(viewer, [target]);
    expect(first.unfollowedCount).toBe(1);

    const second = await userService.bulkUnfollow(viewer, [target]);
    expect(second.unfollowedCount).toBe(0);
    expect(second.results).toEqual([{ userId: target, success: true, wasFollowing: false }]);

    // The total is a measurement, so a double-decrement is not even
    // representable — but a second DELETE reporting a removal would be.
    expect(await userService.getUserStats(viewer)).toEqual({ followers: 0, following: 0 });
  });

  it('does not remove the REVERSE edge', async () => {
    // The edge is directed. Unfollowing someone must not also detach them from
    // the viewer, which a predicate written on the wrong column would do.
    const viewer = await makeUser();
    const target = await makeUser();
    await follow(viewer, target);
    await follow(target, viewer);

    await userService.bulkUnfollow(viewer, [target]);

    expect(await edgeExists(viewer, target)).toBe(false);
    expect(await edgeExists(target, viewer)).toBe(true);
    expect(await userService.getUserStats(viewer)).toEqual({ followers: 1, following: 0 });
  });

  it('never removes an edge belonging to a DIFFERENT follower', async () => {
    const viewer = await makeUser();
    const stranger = await makeUser();
    const target = await makeUser();
    await follow(viewer, target);
    await follow(stranger, target);

    await userService.bulkUnfollow(viewer, [target]);

    expect(await edgeExists(stranger, target)).toBe(true);
    expect(await userService.getUserStats(target)).toEqual({ followers: 1, following: 0 });
  });
});

describe('the candidate list is normalized before anything is read', () => {
  it('dedupes repeated ids and reports each target once', async () => {
    const viewer = await makeUser();
    const target = await makeUser();
    await follow(viewer, target);

    const result = await userService.bulkUnfollow(viewer, [target, target, target]);

    expect(result.unfollowedCount).toBe(1);
    expect(result.results).toEqual([{ userId: target, success: true, wasFollowing: true }]);
  });

  it('drops the caller’s own id entirely', async () => {
    const viewer = await makeUser();
    const target = await makeUser();
    await follow(viewer, target);

    const result = await userService.bulkUnfollow(viewer, [viewer, target]);

    // Self is not reported at all — it is not a target that succeeded or failed.
    expect(result.results.map((entry) => entry.userId)).toEqual([target]);
    expect(result.unfollowedCount).toBe(1);
  });

  it('answers an all-self or empty list without touching the graph', async () => {
    const viewer = await makeUser();
    const target = await makeUser();
    await follow(viewer, target);

    expect(await userService.bulkUnfollow(viewer, [])).toEqual({
      results: [],
      unfollowedCount: 0,
    });
    expect(await userService.bulkUnfollow(viewer, [viewer])).toEqual({
      results: [],
      unfollowedCount: 0,
    });
    expect(await edgeExists(viewer, target)).toBe(true);
  });

  it('reports an id naming no account as already not-following', async () => {
    // A `text` id that matches nothing needs no format guard: it deletes no row
    // and the desired end state (not following) holds.
    const viewer = await makeUser();
    const result = await userService.bulkUnfollow(viewer, [uniqueId(), 'not-an-id']);

    expect(result.unfollowedCount).toBe(0);
    expect(result.results).toEqual([
      { userId: expect.any(String), success: true, wasFollowing: false },
      { userId: 'not-an-id', success: true, wasFollowing: false },
    ]);
  });
});
