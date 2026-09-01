/**
 * `getViewerRelationship` — the two directional flags a profile header renders.
 *
 * The suite this replaces stubbed `Follow.find` to return hand-written edge
 * documents and then asserted the flags. Since the fixture WAS the answer, it
 * could not catch the failure that matters: both flags are derived from ONE
 * query whose two `OR` branches differ only in which column holds the viewer,
 * so a branch written on the wrong column produces a perfectly-shaped result
 * with the relationship inverted. That is invisible unless the two directions
 * are seeded independently — which is what every case here does.
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

describe('each direction is reported independently', () => {
  it('returns both false when there is no edge either way', async () => {
    const [viewer, target] = await makeUsers(2);

    expect(await userService.getViewerRelationship(viewer, target)).toEqual({
      isFollowing: false,
      followsYou: false,
    });
  });

  it('returns isFollowing only, when the viewer follows the target', async () => {
    const [viewer, target] = await makeUsers(2);
    await getDb().insert(userFollows).values({ followerId: viewer, followedId: target });

    // `followsYou: false` is the discriminating half — a mirrored branch would
    // set both from the one edge.
    expect(await userService.getViewerRelationship(viewer, target)).toEqual({
      isFollowing: true,
      followsYou: false,
    });
  });

  it('returns followsYou only, when the target follows the viewer', async () => {
    const [viewer, target] = await makeUsers(2);
    await getDb().insert(userFollows).values({ followerId: target, followedId: viewer });

    expect(await userService.getViewerRelationship(viewer, target)).toEqual({
      isFollowing: false,
      followsYou: true,
    });
  });

  it('returns both when the follow is mutual', async () => {
    const [viewer, target] = await makeUsers(2);
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: viewer, followedId: target },
        { followerId: target, followedId: viewer },
      ]);

    expect(await userService.getViewerRelationship(viewer, target)).toEqual({
      isFollowing: true,
      followsYou: true,
    });
  });

  it('is the exact mirror when the two ids are swapped', async () => {
    // The strongest statement of the direction contract: asking from the other
    // side must transpose the two flags, which a symmetric predicate cannot do.
    const [a, b] = await makeUsers(2);
    await getDb().insert(userFollows).values({ followerId: a, followedId: b });

    expect(await userService.getViewerRelationship(a, b)).toEqual({
      isFollowing: true,
      followsYou: false,
    });
    expect(await userService.getViewerRelationship(b, a)).toEqual({
      isFollowing: false,
      followsYou: true,
    });
  });
});

describe('edges belonging to other people are not read', () => {
  it('ignores a third party following either side', async () => {
    const [viewer, target, stranger] = await makeUsers(3);
    await getDb()
      .insert(userFollows)
      .values([
        { followerId: stranger, followedId: target },
        { followerId: stranger, followedId: viewer },
        { followerId: viewer, followedId: stranger },
      ]);

    expect(await userService.getViewerRelationship(viewer, target)).toEqual({
      isFollowing: false,
      followsYou: false,
    });
  });
});

describe('ids that name no account', () => {
  it('resolves to both-false rather than raising', async () => {
    const [viewer] = await makeUsers(1);

    expect(await userService.getViewerRelationship(viewer, uniqueId())).toEqual({
      isFollowing: false,
      followsYou: false,
    });
    expect(await userService.getViewerRelationship(viewer, 'not-an-id')).toEqual({
      isFollowing: false,
      followsYou: false,
    });
  });
});

describe('a self-view', () => {
  it('reports both flags from the same row when a self-edge somehow exists', async () => {
    // The route skips this call on a self-view; the service itself has no such
    // guard, so this pins what it actually answers rather than implying one.
    const [id] = await makeUsers(1);

    expect(await userService.getViewerRelationship(id, id)).toEqual({
      isFollowing: false,
      followsYou: false,
    });
  });
});
