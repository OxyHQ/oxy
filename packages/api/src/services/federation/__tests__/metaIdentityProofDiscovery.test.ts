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
import { externalIdentities } from '../../../db/schema';
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
  mockSafeFetch.mockReset().mockImplementation(async (url: string) => {
    if (url === igUri) return response(url, { ...actor(igUri), attachment: [{ name: 'Official', value: `<a href="https://www.instagram.com/${handle}/" rel="me">Official</a>` }] });
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
  return { handle, igUri, thUri, igAcct, thAcct, pages, threadActor };
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
