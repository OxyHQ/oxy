import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../../config/postgres';
import { externalIdentities, externalIdentityMetaProofs, externalIdentityInstagramPins, users, blocks } from '../../../db/schema';
import { registerExternalIdentity, getEquivalentUserIds } from '../../externalIdentityRegistry.service';
import { recordInstagramSourcePin, recordMetaIdentityProof, revokeMetaIdentityProof, type BoundMetaIdentityProof } from '../metaIdentityProofRegistry.service';
import { userService } from '../../user.service';

beforeAll(connectPostgres);
afterAll(closePostgres);
async function sourcePair() {
  const handle = randomUUID().replaceAll('-', '');
  const ig = { canonicalAcct: `${handle}@instagram.com`, actorUri: `https://kilogram.makeup/users/${handle}`, transportAcct: `${handle}@kilogram.makeup`, protocol: 'activitypub', profile: { displayName: 'Author' } };
  const thUri = `https://threads.net/ap/users/${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const th = { canonicalAcct: `thread${handle}@threads.net`, actorUri: thUri, transportAcct: `thread${handle}@threads.net`, stableId: thUri, protocol: 'activitypub', profile: { displayName: 'Author' } };
  const a = await registerExternalIdentity(ig);
  const b = await registerExternalIdentity(th);
  const proof: BoundMetaIdentityProof = { instagramActorUri: ig.actorUri, threadsActorUri: th.actorUri,
    instagramAcct: ig.canonicalAcct, threadsAcct: th.canonicalAcct, instagramPk: '314216', instagramGraphId: '17841401746480004', threadsWebPk: '63055343223',
    instagramProfileUrl: `https://www.instagram.com/${handle}/`, threadsProfileUrl: `https://www.threads.com/@thread${handle}`,
    policyVersion: 'meta-profile-badges-2026-09-13-v1', instagramDocumentHash: 'b'.repeat(64), threadsDocumentHash: 'c'.repeat(64),
    evidenceDigest: 'a'.repeat(64), verifiedAt: new Date() };
  return { ig, th, a, b, proof };
}
it('converges new source users with distinct web/AP ID namespaces, preserving graph refs', async () => {
  const { a, b, proof } = await sourcePair();
  expect(a.createdUser).toBe(true);
  const [viewer] = await getDb().insert(users).values({ username: randomUUID() }).returning();
  await getDb().insert(blocks).values({ userId: viewer.id, blockedId: a.identity.userId });
  expect(await recordMetaIdentityProof(proof, { createdInstagramUserId: a.identity.userId })).toEqual({ state: 'verified' });
  expect(await getEquivalentUserIds(b.identity.userId)).toEqual(expect.arrayContaining([a.identity.userId, b.identity.userId]));
  expect((await userService.getViewerGraph(viewer.id)).blockedIds).toEqual(expect.arrayContaining([a.identity.userId, b.identity.userId]));
  const [ig] = await getDb().select().from(externalIdentities).where(eq(externalIdentities.canonicalAcct, proof.instagramAcct));
  const [th] = await getDb().select().from(externalIdentities).where(eq(externalIdentities.canonicalAcct, proof.threadsAcct));
  expect(ig.stableId).toBe('instagram:pk:314216');
  expect(th.stableId).toBe(proof.threadsActorUri);
  expect(th.stableId).not.toContain(proof.threadsWebPk);
});
it('retains preexisting null-pin users as pending without adopting their history', async () => {
  const { ig, a, b, proof } = await sourcePair();
  const existing = await registerExternalIdentity(ig);
  expect(existing.createdUser).toBe(false);
  expect(await recordMetaIdentityProof(proof, {})).toEqual({ state: 'pending', reason: 'legacy_source_lineage_unproven' });
  expect(await getEquivalentUserIds(a.identity.userId)).toEqual([a.identity.userId]);
  expect(await getEquivalentUserIds(b.identity.userId)).toEqual([b.identity.userId]);
  const [row] = await getDb().select().from(externalIdentities).where(eq(externalIdentities.canonicalAcct, proof.instagramAcct));
  expect(row.stableId).toBeNull();
});
it('revokes only the additional edge and rejects an older concurrent snapshot', async () => {
  const { a, b, proof } = await sourcePair();
  await recordMetaIdentityProof(proof, { createdInstagramUserId: a.identity.userId });
  await revokeMetaIdentityProof(proof.instagramAcct, 'badge_removed', new Date(proof.verifiedAt.getTime() + 1));
  expect(await getEquivalentUserIds(a.identity.userId)).toEqual([a.identity.userId]);
  expect(await recordMetaIdentityProof(proof, {})).toEqual({ state: 'refused', reason: 'proof_predates_revocation' });
  const [row] = await getDb().select().from(externalIdentityMetaProofs).where(eq(externalIdentityMetaProofs.threadsActorUri, proof.threadsActorUri));
  expect(row.revocationReason).toBe('badge_removed');
  expect(await getEquivalentUserIds(b.identity.userId)).toEqual([b.identity.userId]);
});
it('expires fresh proof without destructive merging and refuses changed ownership', async () => {
  const { a, proof } = await sourcePair();
  await recordMetaIdentityProof(proof, { createdInstagramUserId: a.identity.userId });
  await getDb().update(externalIdentityMetaProofs).set({ verifiedAt: sql`now() - interval '25 hours'`, expiresAt: sql`now() - interval '1 hour'` })
    .where(eq(externalIdentityMetaProofs.instagramActorUri, proof.instagramActorUri));
  expect(await getEquivalentUserIds(a.identity.userId)).toEqual([a.identity.userId]);
  expect(await recordMetaIdentityProof({ ...proof, instagramPk: '999' }, {})).toEqual({ state: 'refused', reason: 'source_binding_changed' });
  const [row] = await getDb().select().from(externalIdentityMetaProofs).where(eq(externalIdentityMetaProofs.instagramActorUri, proof.instagramActorUri));
  expect(row.instagramPk).toBe('314216');
  expect(row.state).toBe('revoked');
});
it('does not reinterpret ambiguous preexisting stable IDs as first-party IDs', async () => {
  const { a, proof } = await sourcePair();
  await getDb().update(externalIdentities).set({ stableId: '314216' }).where(eq(externalIdentities.canonicalAcct, proof.instagramAcct));
  expect(await recordMetaIdentityProof(proof, { createdInstagramUserId: a.identity.userId })).toEqual({ state: 'refused', reason: 'source_binding_changed' });
  const [row] = await getDb().select().from(externalIdentities).where(eq(externalIdentities.canonicalAcct, proof.instagramAcct));
  expect(row.stableId).toBe('314216');
});
it('new registration provenance is atomic: one concurrent creator, no legacy reuse', async () => {
  const handle = randomUUID().replaceAll('-', '');
  const input = { canonicalAcct: `${handle}@instagram.com`, actorUri: `https://kilogram.makeup/users/${handle}`, transportAcct: `${handle}@kilogram.makeup`, protocol: 'activitypub', profile: {} };
  const created = await Promise.all([registerExternalIdentity(input), registerExternalIdentity(input)]);
  expect(created.filter(result => result.createdUser)).toHaveLength(1);
  expect(created[0].identity.userId).toBe(created[1].identity.userId);
});

it('a newer observation wins over delayed successful or contradictory snapshots', async () => {
  const { a, proof } = await sourcePair();
  const old = { ...proof, verifiedAt: new Date(proof.verifiedAt.getTime() - 1000) };
  await recordMetaIdentityProof(proof, { createdInstagramUserId: a.identity.userId });
  expect(await recordMetaIdentityProof(old, {})).toEqual({ state: 'refused', reason: 'proof_older_than_recorded_observation' });
  expect(await recordMetaIdentityProof({ ...old, instagramPk: '999' }, {})).toEqual({ state: 'refused', reason: 'proof_older_than_recorded_observation' });
  const [row] = await getDb().select().from(externalIdentityMetaProofs).where(eq(externalIdentityMetaProofs.instagramActorUri, proof.instagramActorUri));
  expect(row.state).toBe('verified');
  expect(row.verifiedAt).toEqual(proof.verifiedAt);
  expect(row.instagramPk).toBe(proof.instagramPk);
});
it('a contradictory owner pins revocation against older in-flight successful proof', async () => {
  const { a, proof } = await sourcePair();
  const old = { ...proof, verifiedAt: new Date(proof.verifiedAt.getTime() - 1000) };
  await recordMetaIdentityProof(old, { createdInstagramUserId: a.identity.userId });
  await recordMetaIdentityProof({ ...proof, threadsWebPk: '888' }, {});
  expect(await recordMetaIdentityProof(old, {})).toEqual({ state: 'refused', reason: 'proof_predates_revocation' });
  expect(await getEquivalentUserIds(a.identity.userId)).toEqual([a.identity.userId]);
});

it('a changed reciprocal counterpart revokes the old pair and prevents stale restoration', async () => {
  const first = await sourcePair();
  const next = await sourcePair();
  const old = { ...first.proof, verifiedAt: new Date(Date.now() - 1000) };
  await recordMetaIdentityProof(old, { createdInstagramUserId: first.a.identity.userId });
  const changed = { ...first.proof, threadsActorUri: next.proof.threadsActorUri, threadsAcct: next.proof.threadsAcct,
    threadsWebPk: next.proof.threadsWebPk, threadsProfileUrl: next.proof.threadsProfileUrl, verifiedAt: new Date() };
  expect(await recordMetaIdentityProof(changed, {})).toEqual({ state: 'verified' });
  expect(await getEquivalentUserIds(first.a.identity.userId)).toEqual(expect.arrayContaining([first.a.identity.userId, next.b.identity.userId]));
  expect(await getEquivalentUserIds(first.b.identity.userId)).toEqual([first.b.identity.userId]);
  expect(await recordMetaIdentityProof(old, {})).toEqual({ state: 'refused', reason: 'proof_older_than_recorded_observation' });
});

it('renewing a replacement pair does not revoke the former counterpart’s independent group', async () => {
  const first = await sourcePair();
  const second = await sourcePair();
  const time = Date.now() - 5000;
  await recordMetaIdentityProof({ ...first.proof, verifiedAt: new Date(time) }, { createdInstagramUserId: first.a.identity.userId });
  const replacement = { ...first.proof, threadsActorUri: second.proof.threadsActorUri, threadsAcct: second.proof.threadsAcct,
    threadsWebPk: second.proof.threadsWebPk, threadsProfileUrl: second.proof.threadsProfileUrl, verifiedAt: new Date(time + 1000) };
  await recordMetaIdentityProof(replacement, {});
  const independent = { ...second.proof, threadsActorUri: first.proof.threadsActorUri, threadsAcct: first.proof.threadsAcct,
    threadsWebPk: first.proof.threadsWebPk, threadsProfileUrl: first.proof.threadsProfileUrl, verifiedAt: new Date(time + 2000) };
  expect(await recordMetaIdentityProof(independent, { createdInstagramUserId: second.a.identity.userId })).toEqual({ state: 'verified' });
  expect(await recordMetaIdentityProof({ ...replacement, verifiedAt: new Date(time + 3000) }, {})).toEqual({ state: 'verified' });
  expect(await getEquivalentUserIds(first.b.identity.userId)).toEqual(expect.arrayContaining([first.b.identity.userId, second.a.identity.userId]));
  expect(await getEquivalentUserIds(first.a.identity.userId)).not.toContain(second.a.identity.userId);
});

it.each([false, true])('delayed creator respects a newer pending owner observation (contradictory=%s)', async contradictory => {
  const { a, proof } = await sourcePair();
  const old = { canonicalAcct: proof.instagramAcct, profileUrl: proof.instagramProfileUrl, displayName: 'Author',
    pk: proof.instagramPk, graphId: proof.instagramGraphId, documentHash: 'd'.repeat(64),
    policyVersion: 'meta-profile-badges-2026-09-13-v1' as const, fetchedAt: new Date(Date.now() - 2000).toISOString() };
  const newer = { ...old, pk: contradictory ? '999' : old.pk, documentHash: 'e'.repeat(64), fetchedAt: new Date(Date.now() - 1000).toISOString() };
  expect(await recordInstagramSourcePin(proof.instagramActorUri, newer, {})).toEqual({ state: 'pending', reason: 'legacy_source_lineage_unproven' });
  const creator = await recordInstagramSourcePin(proof.instagramActorUri, old, { createdInstagramUserId: a.identity.userId });
  expect(creator).toEqual(contradictory ? { state: 'refused', reason: 'source_binding_changed' } : { state: 'verified' });
  const [pin] = await getDb().select().from(externalIdentityInstagramPins).where(eq(externalIdentityInstagramPins.actorUri, proof.instagramActorUri));
  expect(pin).toMatchObject({ state: contradictory ? 'pending' : 'pinned', instagramPk: newer.pk, documentHash: newer.documentHash, verifiedAt: new Date(newer.fetchedAt) });
  const [identity] = await getDb().select().from(externalIdentities).where(eq(externalIdentities.canonicalAcct, proof.instagramAcct));
  expect(identity.stableId).toBe(contradictory ? null : `instagram:pk:${old.pk}`);
  expect(await getEquivalentUserIds(a.identity.userId)).toEqual([a.identity.userId]);
});
