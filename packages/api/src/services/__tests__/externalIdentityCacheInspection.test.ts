import { randomUUID } from 'node:crypto';
import { connectPostgres, closePostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { externalIdentities, externalIdentityActors } from '../../db/schema/externalIdentities';
import { inspectExternalIdentityCache, validateCacheInspectionInput } from '../externalIdentityCacheInspection.service';
import { eq, sql } from 'drizzle-orm';
import { externalIdentityInstagramPins, externalIdentityMetaProofs } from '../../db/schema/externalIdentityMetaProofs';

beforeAll(connectPostgres);
afterAll(closePostgres);
function input() {
  const local = randomUUID().replaceAll('-', '');
  return { actorUri: `https://bird.makeup/users/${local}`, canonicalAcct: `${local}@x.com`, transportAcct: `${local}@bird.makeup`, sourceSha: 'a'.repeat(40), imageDigest: `sha256:${'b'.repeat(64)}` };
}
it('reports an absent source without registering or resolving it', async () => {
  const request = input();
  const result = await inspectExternalIdentityCache(request);
  expect(result).toMatchObject({ operation: 'inspect_cache', absent: true, sourceSha: request.sourceSha, imageDigest: request.imageDigest, counts: { users: 0, registryActors: 0, registryIdentities: 0 } });
  expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
  expect(await inspectExternalIdentityCache(request)).toMatchObject({ absent: true });
});
it('counts a migrated registered source without changing it', async () => {
  const request = input();
  const [user] = await getDb().insert(users).values({ username: request.canonicalAcct, type: 'federated', federationActorUri: request.actorUri }).returning();
  await getDb().insert(externalIdentities).values({ canonicalAcct: request.canonicalAcct, userId: user.id, network: 'x.com' });
  await getDb().insert(externalIdentityActors).values({ actorUri: request.actorUri, canonicalAcct: request.canonicalAcct, transportAcct: request.transportAcct, protocol: 'activitypub' });
  expect(await inspectExternalIdentityCache(request)).toMatchObject({ absent: false, counts: { users: 1, registryActors: 1, registryIdentities: 1 } });
  expect((await getDb().select().from(users).where(eq(users.id, user.id)))[0]).toEqual(user);
});
it.each(['actor', 'canonical', 'transport'])('detects a private archived legacy orphan by %s before any registry exists', async matching => {
  const request = input();
  await getDb().insert(users).values({ username: matching === 'canonical' ? request.canonicalAcct : matching === 'transport' ? request.transportAcct : randomUUID(), type: 'federated', federationActorUri: matching === 'actor' ? request.actorUri : null, privacyIsPrivateAccount: true, accountStatus: 'archived' });
  expect(await inspectExternalIdentityCache(request)).toMatchObject({ absent: false, counts: { users: 1, registryActors: 0, registryIdentities: 0 } });
});
it('rejects injected identifiers and untrusted provenance before database access', () => {
  const request = input();
  expect(() => validateCacheInspectionInput({ ...request, canonicalAcct: "x' OR 1=1--@x.com" })).toThrow();
  expect(() => validateCacheInspectionInput({ ...request, actorUri: 'https://user:password@bird.makeup/users/x' })).toThrow();
  expect(() => validateCacheInspectionInput({ ...request, sourceSha: 'main' })).toThrow();
});

async function metaFixture(pinned: boolean) {
  const request = input();
  const handle = request.canonicalAcct.split('@')[0];
  request.actorUri = `https://kilogram.makeup/users/${handle}`;
  request.canonicalAcct = `${handle}@instagram.com`;
  request.transportAcct = `${handle}@kilogram.makeup`;
  const threadsActorUri = `https://threads.net/ap/users/${handle}`;
  const threadsAcct = `${handle}@threads.net`;
  const [igUser, thUser] = await getDb().insert(users).values([
    { username: request.canonicalAcct, type: 'federated', federationActorUri: request.actorUri, bio: 'PRIVATE-BIO-SENTINEL' },
    { username: threadsAcct, type: 'federated', federationActorUri: threadsActorUri },
  ]).returning();
  await getDb().insert(externalIdentities).values([
    { canonicalAcct: request.canonicalAcct, userId: igUser.id, network: 'instagram.com', stableId: pinned ? 'instagram:pk:314216' : null },
    { canonicalAcct: threadsAcct, userId: thUser.id, network: 'threads.net', stableId: threadsActorUri },
  ]);
  await getDb().insert(externalIdentityActors).values([
    { actorUri: request.actorUri, canonicalAcct: request.canonicalAcct, transportAcct: request.transportAcct, protocol: 'activitypub' },
    { actorUri: threadsActorUri, canonicalAcct: threadsAcct, transportAcct: threadsAcct, protocol: 'activitypub' },
  ]);
  const verifiedAt = new Date(Date.now() - 1000);
  const expiresAt = new Date(verifiedAt.getTime() + 60_000);
  await getDb().insert(externalIdentityInstagramPins).values({
    state: pinned ? 'pinned' : 'pending', actorUri: request.actorUri, canonicalAcct: request.canonicalAcct, sourceUserId: igUser.id,
    instagramPk: '314216', instagramGraphId: '17841401746480004', profileUrl: `https://www.instagram.com/${handle}/`,
    documentHash: 'a'.repeat(64), policyVersion: 'meta-profile-badges-2026-09-13-v1', firstVerifiedAt: verifiedAt, verifiedAt,
  });
  await getDb().insert(externalIdentityMetaProofs).values({
    instagramActorUri: request.actorUri, threadsActorUri, instagramAcct: request.canonicalAcct, threadsAcct,
    instagramPk: '314216', instagramGraphId: '17841401746480004', threadsWebPk: '63055343223',
    instagramProfileUrl: `https://www.instagram.com/${handle}/`, threadsProfileUrl: `https://www.threads.com/@${handle}`,
    policyVersion: 'meta-profile-badges-2026-09-13-v1', instagramDocumentHash: 'a'.repeat(64), threadsDocumentHash: 'b'.repeat(64),
    evidenceDigest: 'c'.repeat(64), state: pinned ? 'verified' : 'pending', verifiedAt, expiresAt,
  });
  return { request, igUser, thUser, threadsActorUri, threadsAcct, verifiedAt, expiresAt };
}

it.each([false, true])('inspects exact Meta lineage (pinned=%s) without changing source or proof rows', async pinned => {
  const fixture = await metaFixture(pinned);
  const snapshot = async () => ({
    users: await getDb().select().from(users),
    identities: await getDb().select().from(externalIdentities),
    actors: await getDb().select().from(externalIdentityActors),
    pins: await getDb().select().from(externalIdentityInstagramPins),
    proofs: await getDb().select().from(externalIdentityMetaProofs),
  });
  const before = await snapshot();
  const result = await inspectExternalIdentityCache(fixture.request);
  expect(result.lineage).toMatchObject({
    source: { sourceUserId: fixture.igUser.id, stableId: pinned ? 'instagram:pk:314216' : null, metaProofRevokedAt: null },
    instagramPin: { state: pinned ? 'pinned' : 'pending', sourceUserId: fixture.igUser.id, instagramPk: '314216', documentHash: 'a'.repeat(64), verifiedAt: fixture.verifiedAt },
    metaProofs: [{ state: pinned ? 'verified' : 'pending', threadsActorUri: fixture.threadsActorUri, threadsWebPk: '63055343223', evidenceDigest: 'c'.repeat(64), expiresAt: fixture.expiresAt, revokedAt: null }],
  });
  expect(result.lineage?.metaProofs).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('PRIVATE-BIO-SENTINEL');
  expect(JSON.stringify(result)).not.toContain('ProfileUrl');
  expect(await snapshot()).toEqual(before);
  // A correct actor paired with somebody else's canonical/transport selector
  // cannot use the broad absence counters to expose their lineage.
  const unrelated = await metaFixture(true);
  expect((await inspectExternalIdentityCache({ ...fixture.request, canonicalAcct: unrelated.request.canonicalAcct })).lineage).toBeNull();
  expect((await inspectExternalIdentityCache({ ...fixture.request, transportAcct: unrelated.request.transportAcct })).lineage).toBeNull();
});

it('uses an actual read-only repeatable-read PostgreSQL transaction for the entire inspection', async () => {
  const db = getDb();
  const transaction = db.transaction.bind(db);
  const spy = jest.spyOn(db, 'transaction').mockImplementationOnce(callback => transaction(async tx => {
    const result = await callback(tx);
    const [settings] = await tx.execute<{ readonly: string; isolation: string }>(sql`select current_setting('transaction_read_only') as readonly, current_setting('transaction_isolation') as isolation`);
    expect(settings).toEqual({ readonly: 'on', isolation: 'repeatable read' });
    return result;
  }));
  try { expect((await inspectExternalIdentityCache(input())).lineage).toBeNull(); }
  finally { spy.mockRestore(); }
});
