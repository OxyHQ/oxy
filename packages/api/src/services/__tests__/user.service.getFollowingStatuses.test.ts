/**
 * `getFollowingStatuses` — one answer per requested id, from real edges.
 *
 * The suite this replaces asserted the efficiency contract by counting calls on
 * a mocked model ("runs at most ONE query regardless of N") and by inspecting
 * the `$in` array ("never puts a structurally-invalid id in the query"). Both
 * watched the query rather than the answer, and the second guarded an
 * ObjectId-format filter the port DELETED on purpose: a `text` id that names no
 * account simply matches no rows, so a malformed id now takes the identical
 * "not following" path with no guard to maintain.
 *
 * What is actually load-bearing is the MAP: this replaces N per-button
 * `GET /users/:id/follow-status` requests, so every requested id must appear
 * with the right boolean. An id silently missing from the result renders as an
 * un-followed button on a profile the viewer follows.
 */

import { randomUUID } from 'node:crypto';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import { userService } from '../user.service';

const uniqueId = () => randomUUID().replace(/-/g, '');

async function makeUsers(count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => uniqueId());
  await getDb()
    .insert(users)
    .values(ids.map((id) => ({ id, username: `u${id}` })));
  return ids;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('every requested id is answered', () => {
  it('maps followed ids to true and the rest to false', async () => {
    const [viewer, followedA, followedB, notFollowed] = await makeUsers(4);
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: followedA },
        { followerId: viewer, followedId: followedB },
      ]);

    expect(
      await userService.getFollowingStatuses(viewer, [followedA, notFollowed, followedB])
    ).toEqual({
      [followedA]: true,
      [notFollowed]: false,
      [followedB]: true,
    });
  });

  it('includes an id that names no account, as false', async () => {
    const [viewer] = await makeUsers(1);
    const missing = uniqueId();

    // The key must be PRESENT. A result that merely omits unknown ids reads as
    // `undefined` at the call site, which is falsy — so a test asserting only
    // "not true" would pass against a map that lost the key.
    const statuses = await userService.getFollowingStatuses(viewer, [missing]);
    expect(statuses).toEqual({ [missing]: false });
    expect(Object.keys(statuses)).toEqual([missing]);
  });

  it('answers a malformed id the same way, with no format guard', async () => {
    // The port deleted the ObjectId-shape filter: a `text` id matches no rows.
    const [viewer] = await makeUsers(1);

    expect(await userService.getFollowingStatuses(viewer, ['', '  ', 'not-an-id'])).toEqual({
      'not-an-id': false,
    });
  });

  it('dedupes repeated ids while still answering each requested id once', async () => {
    const [viewer, followed] = await makeUsers(2);
    await getDb().insert(userFollows).values({ followerId: viewer, followedId: followed });

    const statuses = await userService.getFollowingStatuses(viewer, [
      followed,
      followed,
      followed,
    ]);
    expect(statuses).toEqual({ [followed]: true });
    expect(Object.keys(statuses)).toHaveLength(1);
  });

  it('scales to a large id set without losing one', async () => {
    // The efficiency contract used to be asserted by counting mock calls. What a
    // caller can actually observe is that a big batch is answered COMPLETELY —
    // a chunking bug drops the tail, which a 3-id fixture cannot see.
    const [viewer, ...targets] = await makeUsers(121);
    const followed = targets.filter((_, index) => index % 3 === 0);
    await getDb()
      .insert(userFollows)
      .values(followed.map((followedId) => ({ followerId: viewer, followedId })));

    const statuses = await userService.getFollowingStatuses(viewer, targets);

    expect(Object.keys(statuses)).toHaveLength(targets.length);
    expect(Object.values(statuses).filter(Boolean)).toHaveLength(followed.length);
    for (const id of targets) {
      expect(statuses[id]).toBe(followed.includes(id));
    }
  });
});

describe('the direction of the edge', () => {
  it('reports false when the target follows the VIEWER but not the reverse', async () => {
    // The edge is directed; reading the wrong column turns every follower into a
    // "following" on the viewer's buttons.
    const [viewer, target] = await makeUsers(2);
    await getDb().insert(userFollows).values({ followerId: target, followedId: viewer });

    expect(await userService.getFollowingStatuses(viewer, [target])).toEqual({
      [target]: false,
    });
  });

  it('does not leak another follower’s edges into the viewer’s answer', async () => {
    const [viewer, stranger, target] = await makeUsers(3);
    await getDb().insert(userFollows).values({ followerId: stranger, followedId: target });

    expect(await userService.getFollowingStatuses(viewer, [target])).toEqual({
      [target]: false,
    });
  });
});

describe('degenerate inputs', () => {
  it('returns all-false for an anonymous viewer', async () => {
    const [followed] = await makeUsers(1);

    expect(await userService.getFollowingStatuses('', [followed])).toEqual({
      [followed]: false,
    });
  });

  it('returns an empty map for an empty id set', async () => {
    const [viewer] = await makeUsers(1);

    expect(await userService.getFollowingStatuses(viewer, [])).toEqual({});
  });
});
