import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { users, blocks, restrictions, files, followTargets, applications, userFollows } from '../../db/schema';
import { registerExternalIdentity, resolveExternalIdentityUsers } from '../externalIdentityRegistry.service';
import { userService } from '../user.service';
import { MediaPrivacyService } from '../mediaPrivacyService';
import { followTarget, unfollowEverywhere } from '../followCommand.service';
import type { FollowCapability } from '../followCapability.service';
const name = () => randomUUID().replaceAll('-', '');
beforeAll(connectPostgres);
afterAll(closePostgres);
async function pair() {
  const handle = name();
  const ig = { canonicalAcct: `${handle}@instagram.com`, actorUri: `https://instagram.com/ap/actors/${name()}`, transportAcct: `${handle}@instagram.com`, protocol: 'activitypub', stableId: `ig:${name()}`, profile: {}, evidenceLinks: [`https://threads.net/@${handle}`] };
  const th = { canonicalAcct: `${handle}@threads.net`, actorUri: `https://threads.net/ap/actors/${name()}`, transportAcct: `${handle}@threads.net`, protocol: 'activitypub', stableId: `th:${name()}`, profile: {}, evidenceLinks: [`https://instagram.com/${handle}`] };
  const a = await registerExternalIdentity(ig);
  const b = await registerExternalIdentity(th);
  const [viewer] = await getDb().insert(users).values({ username: name() }).returning();
  return { a: a.identity.userId, b: b.identity.userId, viewer: viewer.id, ig };
}
async function asset(ownerUserId: string) {
  const [row] = await getDb().insert(files).values({ ownerUserId, sha256: name().padEnd(64, '0'), size: 100, mime: 'image/png', ext: 'png', storageKey: name(), visibility: 'public' }).returning();
  return { ...row, links: [], variants: [] };
}
it('blocks and restricts through either alias, then restores original-only policy after revocation', async () => {
  const { a, b, viewer, ig } = await pair();
  const service = new MediaPrivacyService();
  const file = await asset(b);
  await getDb().insert(blocks).values({ userId: viewer, blockedId: a });
  expect(await service.checkMediaAccess(file, viewer)).toMatchObject({ allowed: false, reason: 'blocked' });
  expect((await userService.getViewerGraph(viewer)).blockedIds).toEqual(expect.arrayContaining([a, b]));
  await getDb().delete(blocks).where(eq(blocks.userId, viewer));
  await getDb().insert(restrictions).values({ userId: a, restrictedId: viewer });
  expect(await service.checkMediaAccess(file, viewer)).toMatchObject({ allowed: false, reason: 'restricted' });
  await registerExternalIdentity({ ...ig, evidenceLinks: [] });
  expect(await service.checkMediaAccess(file, viewer)).toMatchObject({ allowed: true });
});
it('follow status expands aliases and unfollow removes every member edge', async () => {
  const { a, b, viewer } = await pair();
  await getDb().insert(userFollows).values([{ followerId: viewer, followedId: a }, { followerId: viewer, followedId: b }]);
  expect(await userService.getFollowingStatuses(viewer, [a, b])).toEqual({ [a]: true, [b]: true });
  expect(await userService.getViewerRelationship(viewer, b)).toEqual({ isFollowing: true, followsYou: false });
  expect((await userService.unfollowUser(viewer, b)).removed).toBe(true);
  expect(await userService.isFollowing(viewer, a)).toBe(false);
});
it('universal follows reuse the active group relationship and group removal emits normal removal', async () => {
  const { a, b, viewer } = await pair();
  const [app] = await getDb().insert(applications).values({ name: name(), status: 'active', ownerAccountId: viewer }).returning();
  const capability: FollowCapability = { userId: viewer, applicationId: app.id, grantId: null as unknown as string, scopes: ['follows:read', 'follows:write'], sessionId: 'session' };
  const [targetA] = await getDb().insert(followTargets).values({ localUserId: a, kind: 'oxy.user', canonicalUri: `https://oxy.so/users/${a}` }).returning();
  const [targetB] = await getDb().insert(followTargets).values({ localUserId: b, kind: 'oxy.user', canonicalUri: `https://oxy.so/users/${b}` }).returning();
  const first = await followTarget({ capability, target: targetA });
  const second = await followTarget({ capability, target: targetB });
  expect(second.created).toBe(false);
  expect(second.relationshipId).toBe(first.relationshipId);
  await unfollowEverywhere({ capability, relationshipId: second.relationshipId });
  expect(await userService.isFollowing(viewer, a)).toBe(false);
});
it('batch identity resolution returns every input with a fixed two-query budget', async () => {
  const { a, b, viewer } = await pair();
  const execute = jest.spyOn(getDb(), 'execute');
  const select = jest.spyOn(getDb(), 'select');
  try {
    const result = await resolveExternalIdentityUsers([a, b, viewer, 'unknown']);
    expect(result.get(a)?.userId).toBe(result.get(b)?.userId);
    expect(result.get(viewer)?.userId).toBe(viewer);
    expect(result.get('unknown')?.userId).toBe('unknown');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledTimes(1);
  } finally { execute.mockRestore(); select.mockRestore(); }
});
