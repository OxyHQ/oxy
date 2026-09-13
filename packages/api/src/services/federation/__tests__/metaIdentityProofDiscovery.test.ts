import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
const mockSafeFetch = jest.fn();
jest.mock('@oxy.so/core/server', () => ({ safeFetch: (...args: unknown[]) => mockSafeFetch(...args), SsrfRejection: class extends Error {} }));
jest.mock('../../signature.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../assetServiceSingleton', () => ({ assetService: { ensureOwnedAssetPublic: jest.fn() }, s3Service: {} }));
jest.mock('../../../utils/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
import { eq } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../../config/postgres';
import { inspectReconciliationActor, inspectReconciliationActorResult } from '../../../../scripts/reconcile-external-identities';
import { externalIdentities, externalIdentityInstagramPins, externalIdentityMetaProofs, externalIdentityActors, externalIdentityClaims, users } from '../../../db/schema';
import { userService } from '../../user.service';
import { federationService } from '../../federation.service';
import { getEquivalentUserIds, registerExternalIdentity } from '../../externalIdentityRegistry.service';
beforeAll(connectPostgres);
afterAll(closePostgres);
afterEach(() => jest.restoreAllMocks());
function response(url: string, body: unknown, contentType = 'application/activity+json') {
  return { status: 200, finalUrl: url, headers: { 'content-type': contentType }, response: Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]) };
}
function setup() {
  const handle = `proof${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const igUri = `https://kilogram.makeup/users/${handle}`;
  const thUri = `https://threads.net/ap/users/${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const igAcct = `${handle}@instagram.com`;
  const thAcct = `${handle}@threads.net`;
  const pages = {
    ig: readFileSync(join(__dirname, '../__fixtures__/meta-profile-proof/instagram-zuck.html'), 'utf8').replaceAll('zuck', handle),
    th: readFileSync(join(__dirname, '../__fixtures__/meta-profile-proof/threads-zuck.html'), 'utf8').replaceAll('zuck', handle),
  };
  const actor = (id: string) => ({ id, type: 'Person', name: 'Mark Zuckerberg', preferredUsername: handle, inbox: `${id}/inbox`, summary: 'Source biography' });
  const threadActor = actor(thUri);
  const instagramActor = { ...actor(igUri), attachment: [{ name: 'Official', value: `<a href="https://www.instagram.com/${handle}/" rel="me">Official</a>` }] };
  mockSafeFetch.mockReset().mockImplementation(async (url: string) => {
    if (url === igUri) return response(url, instagramActor);
    if (url === thUri) return response(url, threadActor);
    if (url === `https://www.instagram.com/${handle}/`) return response(url, pages.ig, 'text/html');
    if (url === `https://www.threads.com/@${handle}`) return response(url, pages.th, 'text/html');
    if (url.includes('/.well-known/webfinger')) {
      const resource = new URL(url).searchParams.get('resource');
      return response(url, { subject: resource, links: [{ rel: 'self', type: 'application/activity+json', href: resource === `acct:${thAcct}` ? thUri : igUri }] }, 'application/jrd+json');
    }
    throw new Error(`Unexpected transport URL ${url}`);
  });
  jest.spyOn(federationService, 'scheduleAvatarRefresh').mockImplementation(() => undefined);
  return { handle, igUri, thUri, igAcct, thAcct, pages, threadActor, instagramActor };
}
it('cold discovery parses first-party layouts and converges independent AP/web ID namespaces', async () => {
  const source = setup();
  const ig = await federationService.resolveExternalActorIdentity(source.igUri);
  expect(ig?.identityProof).toEqual({ state: 'verified' });
  const th = await federationService.resolveExternalActorIdentity(source.thUri, source.thAcct);
  expect(th?.identityProof).toEqual({ state: 'verified' });
  expect(th?.user.id).toBe(ig?.user.id);
  expect(th?.externalIdentity.sourceUserId).not.toBe(ig?.externalIdentity.sourceUserId);
  const [stored] = await getDb().select().from(externalIdentities).where(eq(externalIdentities.canonicalAcct, source.thAcct));
  expect(stored.stableId).toBe(source.thUri);
  expect(stored.stableId).not.toContain('63055343223');
});
it('legacy null-pin Instagram never adopts historical lineage', async () => {
  const source = setup();
  const legacy = await registerExternalIdentity({ canonicalAcct: source.igAcct, actorUri: source.igUri, transportAcct: `${source.handle}@kilogram.makeup`, protocol: 'activitypub', profile: { displayName: 'Mark Zuckerberg' } });
  const result = await federationService.resolveExternalActorIdentity(source.igUri);
  expect(result?.identityProof).toEqual({ state: 'pending', reason: 'legacy_source_lineage_unproven' });
  expect(result?.user.id).toBe(legacy.identity.userId);
  expect(await getEquivalentUserIds(legacy.identity.userId)).toEqual([legacy.identity.userId]);
  const [stored] = await getDb().select().from(externalIdentities).where(eq(externalIdentities.canonicalAcct, source.igAcct));
  expect(stored.stableId).toBeNull();
});
it('a fresh missing badge revokes the existing group through public resolution', async () => {
  const source = setup();
  const first = await federationService.resolveExternalActorIdentity(source.igUri);
  expect(first?.identityProof).toEqual({ state: 'verified' });
  source.pages.ig = source.pages.ig.replace('aria-label="Threads"', 'aria-label="Other"');
  const refreshed = await federationService.resolveExternalActorIdentity(source.igUri);
  expect(refreshed?.identityProof).toEqual({ state: 'refused', reason: 'missing_profile_badge' });
  if (!first) throw new Error('Missing discovery result');
  expect(await getEquivalentUserIds(first.externalIdentity.sourceUserId)).toEqual([first.externalIdentity.sourceUserId]);
});
it('refuses a WebFinger actor whose source username contradicts the first-party owner', async () => {
  const source = setup();
  source.threadActor.preferredUsername = 'different_owner';
  const result = await federationService.resolveExternalActorIdentity(source.igUri);
  expect(result?.identityProof).toEqual({ state: 'refused', reason: 'threads_actor_binding_missing' });
  if (!result) throw new Error('Missing discovery result');
  expect(await getEquivalentUserIds(result.externalIdentity.sourceUserId)).toEqual([result.externalIdentity.sourceUserId]);
});

it('reconciliation preserves active proof in dryrun but revokes unavailable actors in apply', async () => {
  const source = setup();
  const resolved = await federationService.resolveExternalActorIdentity(source.igUri);
  if (!resolved) throw new Error('Expected fixture discovery');
  const sourceId = resolved.externalIdentity.sourceUserId;
  const [before] = await getDb().select().from(externalIdentityMetaProofs).where(eq(externalIdentityMetaProofs.instagramActorUri, source.igUri));
  expect(before.state).toBe('verified');
  expect(await getEquivalentUserIds(sourceId)).toHaveLength(2);
  mockSafeFetch.mockRejectedValue(new Error('Source unavailable'));
  expect(await inspectReconciliationActor(source.igUri, false)).toBeNull();
  const [preview] = await getDb().select().from(externalIdentityMetaProofs).where(eq(externalIdentityMetaProofs.instagramActorUri, source.igUri));
  expect(preview).toEqual(before);
  expect(await getEquivalentUserIds(sourceId)).toHaveLength(2);
  expect(await inspectReconciliationActor(source.igUri, true)).toBeNull();
  const [applied] = await getDb().select().from(externalIdentityMetaProofs).where(eq(externalIdentityMetaProofs.instagramActorUri, source.igUri));
  expect(applied).toMatchObject({ state: 'revoked', revocationReason: 'source_actor_unavailable' });
  expect(await getEquivalentUserIds(sourceId)).toEqual([sourceId]);
});

it.each(['threads_html', 'threads_actor', 'instagram_badge'])('cold Instagram ownership survives %s failure and safely joins after recovery', async failure => {
  const source = setup();
  const originalFetch = mockSafeFetch.getMockImplementation();
  if (!originalFetch) throw new Error('Expected fixture transport');
  const originalIgPage = source.pages.ig;
  if (failure === 'instagram_badge') source.pages.ig = originalIgPage.replace('aria-label="Threads"', 'aria-label="Unrelated"');
  mockSafeFetch.mockImplementation(async (url: string) => {
    if ((failure === 'threads_html' && url === `https://www.threads.com/@${source.handle}`)
      || (failure === 'threads_actor' && url === source.thUri)) throw new Error('Temporary upstream outage');
    return originalFetch(url);
  });
  const initial = await federationService.resolveExternalActorIdentity(source.igUri);
  if (!initial) throw new Error('Expected source identity');
  expect(initial.identityProof?.state).toBe('refused');
  const sourceId = initial.externalIdentity.sourceUserId;
  expect(await getEquivalentUserIds(sourceId)).toEqual([sourceId]);
  const [pin] = await getDb().select().from(externalIdentityInstagramPins).where(eq(externalIdentityInstagramPins.actorUri, source.igUri));
  expect(pin).toMatchObject({ sourceUserId: sourceId, instagramPk: '314216', instagramGraphId: '17841401746480004' });
  expect(pin.documentHash).toMatch(/^[a-f0-9]{64}$/);
  source.pages.ig = originalIgPage;
  mockSafeFetch.mockImplementation(originalFetch);
  const recovered = await federationService.resolveExternalActorIdentity(source.igUri);
  expect(recovered?.identityProof).toEqual({ state: 'verified' });
  expect(recovered?.externalIdentity.sourceUserId).toBe(sourceId);
  expect(await getEquivalentUserIds(sourceId)).toHaveLength(2);
});

it('an Instagram owner change during counterpart outage cannot overwrite the initial pin', async () => {
  const source = setup();
  const originalFetch = mockSafeFetch.getMockImplementation();
  if (!originalFetch) throw new Error('Expected fixture transport');
  mockSafeFetch.mockImplementation(async (url: string) => {
    if (url === source.thUri) throw new Error('Temporary actor outage');
    return originalFetch(url);
  });
  const first = await federationService.resolveExternalActorIdentity(source.igUri);
  if (!first) throw new Error('Expected source identity');
  source.pages.ig = source.pages.ig.replace('"pk":"314216"', '"pk":"999"');
  mockSafeFetch.mockImplementation(originalFetch);
  const changed = await federationService.resolveExternalActorIdentity(source.igUri);
  expect(changed).toBeNull();
  const [pin] = await getDb().select().from(externalIdentityInstagramPins).where(eq(externalIdentityInstagramPins.actorUri, source.igUri));
  expect(pin.instagramPk).toBe('314216');
  expect(await getEquivalentUserIds(first.externalIdentity.sourceUserId)).toEqual([first.externalIdentity.sourceUserId]);
});

it('recovered counterpart availability does not enroll a historical unpinned Instagram source', async () => {
  const source = setup();
  const legacy = await registerExternalIdentity({ canonicalAcct: source.igAcct, actorUri: source.igUri,
    transportAcct: `${source.handle}@kilogram.makeup`, protocol: 'activitypub', profile: { displayName: 'Mark Zuckerberg' } });
  const originalFetch = mockSafeFetch.getMockImplementation();
  if (!originalFetch) throw new Error('Expected fixture transport');
  mockSafeFetch.mockImplementation(async (url: string) => { if (url === source.thUri) throw new Error('Outage'); return originalFetch(url); });
  await federationService.resolveExternalActorIdentity(source.igUri);
  mockSafeFetch.mockImplementation(originalFetch);
  const recovered = await federationService.resolveExternalActorIdentity(source.igUri);
  expect(recovered?.identityProof).toEqual({ state: 'pending', reason: 'legacy_source_lineage_unproven' });
  const [observed] = await getDb().select().from(externalIdentityInstagramPins).where(eq(externalIdentityInstagramPins.actorUri, source.igUri));
  expect(observed.state).toBe('pending');
  const [identity] = await getDb().select().from(externalIdentities).where(eq(externalIdentities.canonicalAcct, source.igAcct));
  expect(identity.stableId).toBeNull();
  expect(await getEquivalentUserIds(legacy.identity.userId)).toEqual([legacy.identity.userId]);
});

it.each(['resolve', 'background'])('changed pinned ownership cannot refresh metadata or claims through %s', async entry => {
  const source = setup();
  const initial = await federationService.resolveExternalActorIdentity(source.igUri);
  if (!initial) throw new Error('Expected initial identity');
  const sourceId = initial.externalIdentity.sourceUserId;
  const [pin] = await getDb().select().from(externalIdentityInstagramPins).where(eq(externalIdentityInstagramPins.actorUri, source.igUri));
  const [oldActor] = await getDb().select().from(externalIdentityActors).where(eq(externalIdentityActors.actorUri, source.igUri));
  const readProfile = () => getDb().select({ name: users.nameDisplay, bio: users.bio, resolvedAt: users.federationLastResolvedAt }).from(users).where(eq(users.id, sourceId));
  const before = await readProfile();
  await getDb().insert(externalIdentityClaims).values([
    { actorUri: source.igUri, targetAcct: source.thAcct, sourceStableId: 'instagram:pk:314216', targetStableId: source.thUri, state: 'linked' },
    { actorUri: source.thUri, targetAcct: source.igAcct, sourceStableId: source.thUri, targetStableId: 'instagram:pk:314216', state: 'linked' },
  ]);
  source.pages.ig = source.pages.ig.replace('"pk":"314216"', '"pk":"999"').replaceAll('Mark Zuckerberg', 'New Owner');
  source.instagramActor.name = 'New Owner';
  source.instagramActor.summary = 'Replacement owner biography';
  if (entry === 'resolve') expect(await federationService.resolveExternalActorIdentity(source.igUri)).toBeNull();
  else {
    const existing = await userService.readAccountDocument(sourceId);
    if (!existing) throw new Error('Expected stored account');
    await federationService['refreshFederatedUser']({ ...existing, _id: sourceId, federation: { ...existing.federation, actorUri: source.igUri } }, source.igAcct);
  }
  expect(await readProfile()).toEqual(before);
  const [afterActor] = await getDb().select().from(externalIdentityActors).where(eq(externalIdentityActors.actorUri, source.igUri));
  expect(afterActor).toEqual(oldActor);
  expect(await getEquivalentUserIds(sourceId)).toEqual([sourceId]);
  const claims = await getDb().select().from(externalIdentityClaims).where(eq(externalIdentityClaims.actorUri, source.igUri));
  expect(claims.every(claim => claim.state === 'revoked')).toBe(true);
  // A delayed matching observation cannot mutate evidence after the newer conflict.
  const delayed = await registerExternalIdentity({ canonicalAcct: source.igAcct, actorUri: source.igUri,
    transportAcct: `${source.handle}@kilogram.makeup`, protocol: 'activitypub', stableId: 'instagram:pk:314216',
    profile: { displayName: 'Delayed owner', bio: 'Delayed biography' }, evidenceLinks: [`https://www.threads.net/@${source.handle}`],
    verifiedInstagramPin: { documentHash: pin.documentHash, verifiedAt: pin.verifiedAt.toISOString() } });
  expect(delayed.deferredInstagramOwnerRefresh).toBe(true);
  expect(await readProfile()).toEqual(before);
  expect(await getDb().select().from(externalIdentityClaims).where(eq(externalIdentityClaims.actorUri, source.igUri))).toEqual(claims);
  expect(await getEquivalentUserIds(sourceId)).toEqual([sourceId]);
});

it('pinned source resolution withholds its ID during an own-page outage but recovers with a verified owner alone', async () => {
  const source = setup();
  const first = await federationService.resolveExternalActorIdentity(source.igUri);
  if (!first) throw new Error('Expected pinned identity');
  const originalFetch = mockSafeFetch.getMockImplementation();
  if (!originalFetch) throw new Error('Expected fixture transport');
  mockSafeFetch.mockImplementation(async (url: string) => {
    if (url === `https://www.instagram.com/${source.handle}/`) throw new Error('Own page unavailable');
    return originalFetch(url);
  });
  expect(await federationService.resolveExternalActorIdentity(source.igUri)).toBeNull();
  mockSafeFetch.mockImplementation(async (url: string) => {
    if (url === source.thUri) throw new Error('Threads actor still unavailable');
    return originalFetch(url);
  });
  source.instagramActor.summary = 'Same verified owner, refreshed biography';
  const recovered = await federationService.resolveExternalActorIdentity(source.igUri);
  expect(recovered?.externalIdentity.sourceUserId).toBe(first.externalIdentity.sourceUserId);
  expect(recovered?.user.bio).toBe('Same verified owner, refreshed biography');
  expect(recovered?.identityProof?.state).toBe('refused');
  expect(recovered?.identityProof).not.toHaveProperty('sourceOwnerVerified');
  expect(await getEquivalentUserIds(first.externalIdentity.sourceUserId)).toEqual([first.externalIdentity.sourceUserId]);
});


test('reconciliation reports the same source failure without an additional fetch', async () => {
  mockSafeFetch.mockReset();
  mockSafeFetch.mockResolvedValue({ ...response('https://bird.makeup/users/missing', {}), status: 404 });
  expect(await inspectReconciliationActorResult('https://bird.makeup/users/missing', false)).toMatchObject({
    ok: false, failure: { phase: 'actor_fetch', reason: 'http_status', httpStatus: 404 },
  });
  expect(mockSafeFetch).toHaveBeenCalledTimes(1);
});
