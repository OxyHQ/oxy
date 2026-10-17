/** Public follow lists must not expose relationship chronology, including via legacy sorts. */
import { randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import { userService } from '../user.service';
import type { FollowGraphSort } from '../../types/user.types';

const uniqueId = () => randomUUID().replace(/-/g, '');
async function makeUser() {
  const id = uniqueId();
  await getDb()
    .insert(users)
    .values({ id, username: `u${id}` });
  return id;
}
beforeAll(connectPostgres);
afterAll(closePostgres);

it.each(['followers', 'following', 'mutuals'] as const)(
  '%s pages stably and cannot recover chronology through sort, timestamps or edge ids',
  async (mode) => {
    const viewer = await makeUser();
    const target = await makeUser();
    const ids = await Promise.all(Array.from({ length: 9 }, makeUser));
    const edges = ids.map((id, i) => ({
      id: uniqueId(),
      followerId: mode === 'following' ? target : id,
      followedId: mode === 'following' ? id : target,
      createdAt: new Date(Date.UTC(2026, 0, i + 1)),
    }));
    await getDb().insert(userFollows).values(edges);
    if (mode === 'mutuals')
      await getDb()
        .insert(userFollows)
        .values(ids.map((id) => ({ followerId: viewer, followedId: id })));
    const page = (offset: number, sort?: FollowGraphSort, limit = 4) =>
      mode === 'mutuals'
        ? userService.getUserMutuals(viewer, target, { limit, offset, sort })
        : mode === 'following'
          ? userService.getUserFollowing(target, { limit, offset, sort })
          : userService.getUserFollowers(target, { limit, offset, sort });
    const original = (await page(0, undefined, 20)).data.map((row) => row.id);
    for (const sort of [undefined, 'stable', 'recent', 'oldest'] as const) {
      const seen = [];
      for (let offset = 0; offset < ids.length; offset += 4) {
        const result = await page(offset, sort);
        expect(result.total).toBe(ids.length);
        expect(result.hasMore).toBe(offset + 4 < ids.length);
        seen.push(...result.data.map((row) => row.id));
      }
      expect(seen).toEqual(original);
      expect([...seen].sort()).toEqual([...ids].sort());
    }
    // Reverse chronology and replace every edge id. Sorting on either would
    // change the answer; a stable identity order must survive both operations.
    for (let i = 0; i < edges.length; i++) {
      await getDb()
        .update(userFollows)
        .set({
          id: uniqueId(),
          createdAt: new Date(Date.UTC(2027, 0, edges.length - i)),
        })
        .where(inArray(userFollows.id, [edges[i].id]));
    }
    expect((await page(0, 'recent', 20)).data.map((row) => row.id)).toEqual(original);
    // Re-following also cannot change the account's position.
    await getDb()
      .delete(userFollows)
      .where(
        sql`${userFollows.followerId} = ${edges[0].followerId} and ${userFollows.followedId} = ${edges[0].followedId}`,
      );
    await getDb()
      .insert(userFollows)
      .values({ followerId: edges[0].followerId, followedId: edges[0].followedId });
    expect((await page(0, 'oldest', 20)).data.map((row) => row.id)).toEqual(original);
  },
);
