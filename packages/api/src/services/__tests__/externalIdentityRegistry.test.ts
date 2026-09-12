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


it('refuses a recycled handle with a contradictory source profile before merging history', async () => {
  const first = input(`${name()}@instagram.com`);
  const original = await registerExternalIdentity(first);
  const second = { ...input(first.canonicalAcct, `https://other.example/users/${name()}`), profile: { displayName: 'Different owner' } };
  await expect(registerExternalIdentity(second)).rejects.toMatchObject({ statusCode: 409 });
  expect(await lookupExternalIdentity(second.actorUri)).toBeNull();
  expect(await getExternalIdentitiesForUser(original.userId)).toHaveLength(1);
});

it('does not adopt a migrated native DID from its recycled handle', async () => {
  const acct = `${name()}@bsky.social`;
  const did = `did:plc:${name()}`;
  const [original] = await getDb().insert(users).values({ username: acct, type: 'federated', federationActorUri: did }).returning();
  const incoming = { ...input(acct, `https://bsky.brid.gy/ap/${name()}`), stableId: `did:plc:${name()}` };
  await expect(registerExternalIdentity(incoming)).rejects.toMatchObject({ statusCode: 409 });
  expect(await lookupExternalIdentity(incoming.actorUri)).toBeNull();
  const verified = await registerExternalIdentity({ ...incoming, stableId: did });
  expect(verified.userId).toBe(original.id);
});

it('requires immutable ownership when attaching a new transport to a stable identity', async () => {
  const first = { ...input(`${name()}@bsky.social`), stableId: `did:plc:${name()}` };
  const original = await registerExternalIdentity(first);
  const next = input(first.canonicalAcct, `https://other.example/users/${name()}`);
  await expect(registerExternalIdentity(next)).rejects.toMatchObject({ statusCode: 409 });
  expect((await registerExternalIdentity({ ...next, stableId: first.stableId })).userId).toBe(original.userId);
});


it('refuses contradictory named legacy profiles before creating a registry entry', async () => {
  const acct = `${name()}@x.com`;
  await getDb().insert(users).values({ username: acct, type: 'federated', federationActorUri: `https://old.example/${name()}`, nameFirst: 'Previous owner' });
  const next = input(acct);
  await expect(registerExternalIdentity(next)).rejects.toMatchObject({ statusCode: 409 });
  expect(await lookupExternalIdentity(acct)).toBeNull();
});


it('bounds persisted source claims and excludes unrelated or unsafe source URLs', async () => {
  const links = Array.from({ length: 40 }, (_, i) => `https://threads.net/@person${i}`);
  const registered = await registerExternalIdentity({ ...input(`${name()}@instagram.com`), evidenceLinks: [
    'https://user:secret@threads.net/@person', 'https://unrelated.example/person',
    `https://threads.net/@${'x'.repeat(2100)}`, ...links, ...links,
  ] });
  expect(registered.identity.evidenceLinks).toEqual(links.slice(0, 32));
});
