import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { registerExternalIdentity, getEquivalentUserIds, lookupExternalIdentity, resolveCanonicalUserId, getExternalIdentitiesForUser, linkedSourceAcct } from '../externalIdentityRegistry.service';
import { externalIdentityActors } from '../../db/schema/externalIdentities';
import { users } from '../../db/schema/users';
import { blocks } from '../../db/schema/blocks';
import { restrictions } from '../../db/schema/restrictions';
import { userFollows } from '../../db/schema/userFollows';
beforeAll(connectPostgres);
afterAll(closePostgres);
const name = () => randomUUID().replaceAll('-', '');
function input(acct: string, actor = `https://bridge.example/users/${acct}`) {
  return { canonicalAcct: acct, actorUri: actor, transportAcct: `${acct}@bridge.example`, protocol: 'activitypub', profile: { displayName: 'External person' } };
}
it('concurrent bridge aliases converge while independent same handles stay separate', async () => {
  const handle = name();
  const a = input(`${handle}@instagram.com`);
  const b = input(a.canonicalAcct, `https://other.example/users/${handle}`);
  const [first, second] = await Promise.all([registerExternalIdentity(a), registerExternalIdentity(b)]);
  expect(first.userId).toBe(second.userId);
  expect(await lookupExternalIdentity(b.actorUri)).toBe(first.userId);
  expect(await getExternalIdentitiesForUser(first.userId)).toHaveLength(2);
  const unrelated = await registerExternalIdentity(input(`${handle}@threads.net`));
  expect(unrelated.userId).not.toBe(first.userId);
});
it('requires immutable identities as well as reciprocal links; revokes safely', async () => {
  const handle = name();
  const a = { ...input(`${handle}@instagram.com`), evidenceLinks: [`https://threads.net/@${handle}`] };
  const b = { ...input(`${handle}@threads.net`), evidenceLinks: [`https://instagram.com/${handle}`] };
  const first = await registerExternalIdentity(a);
  await registerExternalIdentity(b);
  expect(await getEquivalentUserIds(first.userId)).toEqual([first.userId]);
  const pinnedA = { ...a, stableId: `instagram:${name()}` };
  const pinnedB = { ...b, stableId: `threads:${name()}` };
  await registerExternalIdentity(pinnedA);
  const second = await registerExternalIdentity(pinnedB);
  const ids = await getEquivalentUserIds(first.userId);
  expect(ids).toHaveLength(2);
  expect(second.userId).toBe([...ids].sort()[0]);
  expect(new Set((await getExternalIdentitiesForUser(first.userId)).map(row => row.sourceUserId)).size).toBe(2);
  await registerExternalIdentity({ ...pinnedA, evidenceLinks: [] });
  expect(await getEquivalentUserIds(first.userId)).toEqual([first.userId]);
});
it('expires evidence and refuses changed stable owners', async () => {
  const handle = name();
  const a = { ...input(`${handle}@instagram.com`), stableId: `instagram:${name()}`, evidenceLinks: [`https://threads.net/@${handle}`] };
  const b = { ...input(`${handle}@threads.net`), stableId: `threads:${name()}`, evidenceLinks: [`https://instagram.com/${handle}`] };
  const first = await registerExternalIdentity(a);
  await registerExternalIdentity(b);
  await getDb().update(externalIdentityActors).set({ updatedAt: sql`now() - interval '8 days'` }).where(eq(externalIdentityActors.actorUri, a.actorUri));
  expect(await getEquivalentUserIds(first.userId)).toEqual([first.userId]);
  await registerExternalIdentity(a);
  await expect(registerExternalIdentity({ ...a, stableId: 'new-owner' })).rejects.toThrow('stable identity changed');
  expect(await getEquivalentUserIds(first.userId)).toEqual([first.userId]);
});
it('preserves legacy moderation and follows when transports converge', async () => {
  const handle = name();
  const canonical = await registerExternalIdentity(input(`${handle}@instagram.com`));
  const actor = `https://old.example/users/${handle}`;
  const [legacy] = await getDb().insert(users).values({ username: `${handle}@old.example`, type: 'federated', federationActorUri: actor }).returning();
  const [viewer] = await getDb().insert(users).values({ username: name() }).returning();
  await getDb().insert(blocks).values({ userId: viewer.id, blockedId: legacy.id });
  await getDb().insert(restrictions).values({ userId: legacy.id, restrictedId: viewer.id });
  await getDb().insert(userFollows).values({ followerId: viewer.id, followedId: legacy.id });
  await registerExternalIdentity(input(`${handle}@instagram.com`, actor));
  expect(await resolveCanonicalUserId(legacy.id)).toBe(canonical.userId);
  expect(await getDb().select().from(blocks).where(eq(blocks.blockedId, canonical.userId))).toHaveLength(1);
  expect(await getDb().select().from(restrictions).where(eq(restrictions.userId, canonical.userId))).toHaveLength(1);
  expect(await getDb().select().from(userFollows).where(eq(userFollows.followedId, canonical.userId))).toHaveLength(1);
  expect(await getDb().select().from(users).where(eq(users.id, legacy.id))).toHaveLength(1);
});
it('rejects lookalike domains and arbitrary text as source links', () => {
  expect(linkedSourceAcct('https://instagram.com.evil.example/person')).toBeNull();
  expect(linkedSourceAcct('hello @person@instagram.com')).toBeNull();
  expect(linkedSourceAcct('https://instagram.com@evil.example/person')).toBeNull();
});

it('a fresh source losing immutable proof cannot renew historical equivalence', async () => {
  const handle = name();
  const a = { ...input(`${handle}@instagram.com`), stableId: `ig:${name()}`, evidenceLinks: [`https://threads.net/@${handle}`] };
  const b = { ...input(`${handle}@threads.net`), stableId: `th:${name()}`, evidenceLinks: [`https://instagram.com/${handle}`] };
  const first = await registerExternalIdentity(a);
  await registerExternalIdentity(b);
  expect(await getEquivalentUserIds(first.userId)).toHaveLength(2);
  await registerExternalIdentity({ ...a, stableId: undefined });
  expect(await getEquivalentUserIds(first.userId)).toEqual([first.userId]);
  await registerExternalIdentity(b);
  expect(await getEquivalentUserIds(first.userId)).toEqual([first.userId]);
});

it('cannot claim or rewrite a non-federated account through an actor collision', async () => {
  const actorUri = `https://source.example/actor/${name()}`;
  const [local] = await getDb().insert(users).values({ username: name(), federationActorUri: actorUri, nameFirst: 'Local person' }).returning();
  await expect(registerExternalIdentity(input(`${name()}@instagram.com`, actorUri))).rejects.toMatchObject({ statusCode: 409 });
  const [unchanged] = await getDb().select().from(users).where(eq(users.id, local.id));
  expect(unchanged.type).toBe('local');
  expect(unchanged.nameFirst).toBe('Local person');
});
