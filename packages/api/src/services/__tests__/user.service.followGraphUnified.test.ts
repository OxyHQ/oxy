/**
 * The account routes write the ONE follow graph.
 *
 * `POST /users/:id/follow`, the bulk follow, MCP and the federation bridge go
 * through `userService.followUser` / `bulkFollow` / `unfollowUser` /
 * `bulkUnfollow`. Those used to write only the `user_follows` projection, so a
 * follow made there had no `follow_relationships` row and no event: v2 status
 * reads disagreed with the account graph and nothing federated or notified.
 * Every case here checks the relationship, the event and the projection agree.
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applications } from '../../db/schema/applications';
import { followEvents } from '../../db/schema/followEvents';
import { followRelationships } from '../../db/schema/followRelationships';
import { followTargets } from '../../db/schema/followTargets';
import { userFollows } from '../../db/schema/userFollows';
import { users } from '../../db/schema/users';
import { accountTargetUri, followTarget } from '../followCommand.service';
import { userService } from '../user.service';

const uniqueId = () => randomUUID().replace(/-/g, '');

async function makeUser(): Promise<string> {
  const id = uniqueId();
  await getDb().insert(users).values({ id, username: `u${id}` });
  return id;
}

async function relationshipsOf(followerId: string, followedId: string) {
  return getDb()
    .select({ id: followRelationships.id, source: followRelationships.source, uri: followTargets.canonicalUri })
    .from(followRelationships)
    .innerJoin(followTargets, eq(followTargets.id, followRelationships.followTargetId))
    .where(and(eq(followRelationships.followerUserId, followerId), eq(followTargets.localUserId, followedId)));
}

async function eventsOf(relationshipId: string) {
  return getDb()
    .select({ type: followEvents.type, cause: followEvents.cause })
    .from(followEvents)
    .where(eq(followEvents.relationshipId, relationshipId));
}

async function edgeExists(followerId: string, followedId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: userFollows.id })
    .from(userFollows)
    .where(and(eq(userFollows.followerId, followerId), eq(userFollows.followedId, followedId)));
  return rows.length === 1;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

describe('followUser / unfollowUser write the relationship, the event and the projection', () => {
  it('a follow creates the oxy.user relationship with a follow.created event', async () => {
    const follower = await makeUser();
    const followed = await makeUser();

    const result = await userService.followUser(follower, followed);

    expect(result.created).toBe(true);
    expect(await edgeExists(follower, followed)).toBe(true);
    const [relationship] = await relationshipsOf(follower, followed);
    expect(relationship).toMatchObject({ source: 'app', uri: accountTargetUri(followed) });
    expect(await eventsOf(relationship.id)).toEqual([{ type: 'follow.created', cause: 'user_action' }]);
  });

  it('following twice is one relationship and one event', async () => {
    const follower = await makeUser();
    const followed = await makeUser();

    await userService.followUser(follower, followed);
    const second = await userService.followUser(follower, followed);

    expect(second.created).toBe(false);
    const relationships = await relationshipsOf(follower, followed);
    expect(relationships).toHaveLength(1);
    expect(await eventsOf(relationships[0].id)).toHaveLength(1);
  });

  it('an unfollow removes the relationship with a follow.removed event, like v2', async () => {
    const follower = await makeUser();
    const followed = await makeUser();
    await userService.followUser(follower, followed);
    const [relationship] = await relationshipsOf(follower, followed);

    const result = await userService.unfollowUser(follower, followed);

    expect(result.removed).toBe(true);
    expect(await edgeExists(follower, followed)).toBe(false);
    expect(await relationshipsOf(follower, followed)).toEqual([]);
    expect(await eventsOf(relationship.id)).toEqual(
      expect.arrayContaining([
        { type: 'follow.created', cause: 'user_action' },
        { type: 'follow.removed', cause: 'user_action' },
      ]),
    );
  });

  it('an account unfollow also ends a follow an application made through v2', async () => {
    const follower = await makeUser();
    const followed = await makeUser();
    const [target] = await getDb()
      .insert(followTargets)
      .values({ canonicalUri: accountTargetUri(followed), kind: 'oxy.user', localUserId: followed })
      .returning();
    const [app] = await getDb()
      .insert(applications)
      .values({ name: `App ${uniqueId()}`, status: 'active', ownerAccountId: follower })
      .returning({ id: applications.id });
    await followTarget({
      capability: { userId: follower, applicationId: app.id, grantId: null as unknown as string, scopes: [], sessionId: 's' },
      target,
    });
    expect(await edgeExists(follower, followed)).toBe(true);

    await userService.unfollowUser(follower, followed);

    expect(await edgeExists(follower, followed)).toBe(false);
    expect(await relationshipsOf(follower, followed)).toEqual([]);
  });

  it('the federation bridge records its cause and source', async () => {
    const follower = await makeUser();
    const followed = await makeUser();

    await userService.followUser(follower, followed, { cause: 'federation_inbound', source: 'federation_inbound' });

    const [relationship] = await relationshipsOf(follower, followed);
    expect(relationship.source).toBe('federation_inbound');
    expect(await eventsOf(relationship.id)).toEqual([{ type: 'follow.created', cause: 'federation_inbound' }]);
  });
});

describe('bulkFollow / bulkUnfollow go through the same command', () => {
  it('creates one relationship and one event per newly followed account', async () => {
    const viewer = await makeUser();
    const a = await makeUser();
    const b = await makeUser();
    await userService.followUser(viewer, a);

    const result = await userService.bulkFollow(viewer, [a, b]);

    expect(result.followedCount).toBe(1);
    expect(await relationshipsOf(viewer, a)).toHaveLength(1);
    const [relationshipB] = await relationshipsOf(viewer, b);
    expect(await eventsOf(relationshipB.id)).toEqual([{ type: 'follow.created', cause: 'user_action' }]);
    expect(await edgeExists(viewer, b)).toBe(true);
  });

  it('removes the relationships and the projection together', async () => {
    const viewer = await makeUser();
    const a = await makeUser();
    const b = await makeUser();
    await userService.bulkFollow(viewer, [a, b]);

    const result = await userService.bulkUnfollow(viewer, [a, b]);

    expect(result.unfollowedCount).toBe(2);
    expect(await relationshipsOf(viewer, a)).toEqual([]);
    expect(await relationshipsOf(viewer, b)).toEqual([]);
    expect(await edgeExists(viewer, a)).toBe(false);
  });
});

describe('purgeUserSocialGraph', () => {
  it('drops the relationships behind the projection too', async () => {
    const subject = await makeUser();
    const other = await makeUser();
    await userService.followUser(subject, other);
    await userService.followUser(other, subject);

    await userService.purgeUserSocialGraph(subject);

    expect(await relationshipsOf(subject, other)).toEqual([]);
    expect(await relationshipsOf(other, subject)).toEqual([]);
  });
});
