/**
 * A federated user's avatar is an Oxy Cloud mirror or nothing — never the raw
 * remote URL — against a REAL Postgres with every outbound fetch mocked.
 *
 * The production case this pins: kilogram served ibaillanos@instagram.com a
 * picture URL signed with `oe=6869EA02` (2025-07-06). The registry seeded that
 * URL as an "interim" avatar, the mirror download got a 403, and the dead URL
 * was served to Mention indefinitely.
 */

const mockCacheInvalidate = jest.fn();
const mockAssetFileContentExists = jest.fn();
const mockAssetUploadFileDirect = jest.fn();
const mockAssetDeleteFile = jest.fn();
const mockSafeFetch = jest.fn();

process.env.AWS_ACCESS_KEY_ID ||= 'test-access-key';
process.env.AWS_SECRET_ACCESS_KEY ||= 'test-secret-key';
process.env.AWS_S3_BUCKET ||= 'test-bucket';

jest.mock('../../utils/userCache', () => ({ __esModule: true, default: { invalidate: mockCacheInvalidate } }));
jest.mock('../../utils/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));
jest.mock('../assetService', () => ({
  __esModule: true,
  AssetService: class {
    fileContentExists(...args: unknown[]) { return mockAssetFileContentExists(...args); }
    uploadFileDirect(...args: unknown[]) { return mockAssetUploadFileDirect(...args); }
    deleteFile(...args: unknown[]) { return mockAssetDeleteFile(...args); }
  },
}));
jest.mock('../s3Service', () => ({ __esModule: true, createS3Service: jest.fn(() => ({})) }));
jest.mock('@oxy.so/core/server', () => ({
  __esModule: true,
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfRejection: class extends Error {},
}));
jest.mock('../federation/avatarFetchBackpressure', () => ({
  acquireAvatarOriginLease: () => Promise.resolve(0),
  clearAvatarOriginFailures: () => Promise.resolve(),
  recordAvatarOriginRateLimit: () => Promise.resolve(30_000),
}));

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { externalIdentities, externalIdentityActors } from '../../db/schema/externalIdentities';
import { externalIdentityInstagramPins } from '../../db/schema/externalIdentityMetaProofs';
import { federationService, isExpiredSignedAvatarUrl } from '../federation.service';
import { registerExternalIdentity } from '../externalIdentityRegistry.service';
import { resetInstagramGraphStateForTests } from '../federation/instagramGraph';
import { formatUserResponse } from '../../utils/userTransform';
import { repairFederatedRemoteAvatars } from '../../scripts/repair-federated-remote-avatars';
import { FederatedAvatarWriteRefused, isAvatarFileId, persistFederatedAvatar } from '../../utils/federatedAvatar';

/** Signed with an `oe` in the past: the exact shape kilogram served. */
const EXPIRED_FBCDN = 'https://instagram.fymq2-1.fna.fbcdn.net/v/t51.2885-19/70121982_n.jpg?stp=dst-jpg&oe=6869EA02&_nc_sid=abc';
const futureOe = () => Math.floor(Date.now() / 1000 + 3 * 24 * 3600).toString(16).toUpperCase();
const LIVE_FBCDN = () => `https://scontent-iad3-1.cdninstagram.com/v/t51.2885-19/live_n.jpg?oe=${futureOe()}&_nc_sid=def`;
const GRAPH_PICTURE = () => `https://scontent.xx.fbcdn.net/v/t51.2885-15/graph_n.jpg?oe=${futureOe()}`;

type Fetched = { status: number; headers: Record<string, string>; finalUrl: string; response: Readable };
function reply(status: number, headers: Record<string, string> = {}, body: string | Buffer = ''): Fetched {
  return { status, headers, finalUrl: 'https://final.example/', response: Readable.from([typeof body === 'string' ? Buffer.from(body) : body]) };
}
const image = () => reply(200, { 'content-type': 'image/jpeg' }, Buffer.from('jpeg-bytes'));

interface Routes { [url: string]: () => Fetched }
function route(routes: Routes, graph?: { id: string; picture?: string } | { notBusiness: true }) {
  mockSafeFetch.mockReset().mockImplementation(async (url: string) => {
    if (url.startsWith('https://graph.facebook.com/') && graph) {
      const fields = new URL(url).searchParams.get('fields') ?? '';
      const username = /business_discovery\.username\(([^)]+)\)/.exec(fields)?.[1];
      if ('notBusiness' in graph) {
        return reply(400, { 'content-type': 'application/json' }, JSON.stringify({ error: { code: 110, error_subcode: 2207013, message: 'not business' } }));
      }
      return reply(200, { 'content-type': 'application/json' }, JSON.stringify({
        business_discovery: { id: graph.id, username, name: 'Name', biography: '', profile_picture_url: graph.picture },
      }));
    }
    const handler = routes[url];
    if (!handler) throw new Error(`Unexpected fetch ${url}`);
    return handler();
  });
}
const fetchedUrls = () => mockSafeFetch.mock.calls.map(([url]) => String(url));
const graphCalls = () => fetchedUrls().filter((url) => url.startsWith('https://graph.facebook.com/'));

function enableGraph() {
  process.env.INSTAGRAM_GRAPH_FALLBACK_ENABLED = 'true';
  process.env.META_GRAPH_ACCESS_TOKEN = 'EAAG-test-token';
  process.env.META_IG_BUSINESS_ACCOUNT_ID = '17841400000000001';
}

/** A federated user as the pre-fix registry left it. */
async function seedUser(domain: string, avatar: string | null, over: Partial<typeof users.$inferInsert> = {}) {
  const local = `u${randomUUID().replaceAll('-', '').slice(0, 14)}`;
  const acct = `${local}@${domain}`;
  const actorUri = domain === 'instagram.com' ? `https://kilogram.makeup/users/${local}` : `https://${domain}/users/${local}`;
  const [row] = await getDb().insert(users).values({
    type: 'federated', username: acct, federationActorUri: actorUri, federationDomain: domain, avatar, ...over,
  }).returning({ id: users.id });
  return { id: row.id, acct, local, actorUri };
}

async function avatarOf(userId: string) {
  const [row] = await getDb().select({ avatar: users.avatar, fetchedAt: users.federationLastAvatarFetchedAt })
    .from(users).where(eq(users.id, userId));
  return row;
}

interface Workers { downloadAvatarForUser(...args: unknown[]): Promise<void> }
let workerSpy: jest.SpyInstance<Promise<void>, unknown[]>;
const settle = async () => { await Promise.allSettled(workerSpy.mock.results.map((r) => r.value as Promise<void>)); };

beforeAll(connectPostgres);
afterAll(closePostgres);
beforeEach(() => {
  jest.clearAllMocks();
  resetInstagramGraphStateForTests();
  mockAssetFileContentExists.mockResolvedValue(true);
  mockAssetUploadFileDirect.mockImplementation(async () => ({ id: `mirror-${randomUUID()}` }));
  mockAssetDeleteFile.mockResolvedValue(undefined);
  workerSpy = jest.spyOn(federationService as unknown as Workers, 'downloadAvatarForUser');
});
afterEach(async () => {
  await settle();
  workerSpy.mockRestore();
  delete process.env.INSTAGRAM_GRAPH_FALLBACK_ENABLED;
  delete process.env.META_GRAPH_ACCESS_TOKEN;
  delete process.env.META_IG_BUSINESS_ACCOUNT_ID;
  jest.restoreAllMocks();
});

describe('isExpiredSignedAvatarUrl', () => {
  it('reads the hex `oe` expiry of Meta CDN URLs only', () => {
    expect(isExpiredSignedAvatarUrl(EXPIRED_FBCDN)).toBe(true);
    expect(isExpiredSignedAvatarUrl(LIVE_FBCDN())).toBe(false);
    expect(isExpiredSignedAvatarUrl('https://scontent.cdninstagram.com/x.jpg?oe=6869EA02')).toBe(true);
    // Another host's `oe` means nothing.
    expect(isExpiredSignedAvatarUrl('https://files.mastodon.social/a.png?oe=6869EA02')).toBe(false);
    expect(isExpiredSignedAvatarUrl('https://instagram.x.fbcdn.net/a.jpg')).toBe(false);
    expect(isExpiredSignedAvatarUrl('not a url')).toBe(false);
  });
});

describe('the federated avatar write boundary', () => {
  it.each([
    ['a Meta CDN URL', LIVE_FBCDN()],
    ['a Bluesky CDN URL', 'https://cdn.bsky.app/img/avatar/plain/did:plc:abc/bafk@jpeg'],
    ['a Mastodon media URL', 'https://files.mastodon.social/accounts/avatars/1.png'],
    ['a data URI', 'data:image/png;base64,AAAA'],
    ['a path', 'avatars/abc.png'],
    ['an empty string', ''],
  ])('refuses %s and leaves the row untouched', async (_label, value) => {
    const user = await seedUser('mastodon.social', 'previous-mirror');
    await expect(persistFederatedAvatar(user.id, { fileId: value })).rejects.toBeInstanceOf(FederatedAvatarWriteRefused);
    expect((await avatarOf(user.id)).avatar).toBe('previous-mirror');
  });

  it('accepts an Oxy file id (uuid or legacy ObjectId)', async () => {
    const user = await seedUser('mastodon.social', null);
    const id = randomUUID();
    expect(await persistFederatedAvatar(user.id, { fileId: id })).toBe(true);
    expect((await avatarOf(user.id)).avatar).toBe(id);
    expect(isAvatarFileId('65f1c0ffee00000000000001')).toBe(true);
  });

  it('keep_previous_mirror keeps a file id and clears any other value', async () => {
    const kept = await seedUser('bsky.social', 'kept-mirror');
    await persistFederatedAvatar(kept.id, 'keep_previous_mirror');
    expect((await avatarOf(kept.id)).avatar).toBe('kept-mirror');
    const legacy = await seedUser('bsky.social', 'https://cdn.bsky.app/img/avatar/plain/did:plc:x/y@jpeg');
    await persistFederatedAvatar(legacy.id, 'keep_previous_mirror');
    expect((await avatarOf(legacy.id)).avatar).toBeNull();
  });
});

describe('registration never persists the source picture URL', () => {
  it('creates a new federated user with NO avatar, then mirrors it', async () => {
    const local = `new${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const acct = `${local}@mastodon.social`;
    const actorUri = `https://mastodon.social/users/${local}`;
    const picture = `https://files.mastodon.social/${local}.png`;
    route({ [picture]: image });
    jest.spyOn(federationService, 'fetchActorProfile').mockResolvedValue({
      actorUri, transportAcct: acct, protocol: 'activitypub', evidenceLinks: [], domain: 'mastodon.social',
      username: acct, displayName: 'New', avatarUrl: picture, bio: '',
    });

    const result = await federationService.resolveExternalActorIdentity(actorUri);
    // The response never carries the remote URL, even before the mirror lands.
    expect(result?.user.avatar).toBeUndefined();
    await settle();
    const stored = await avatarOf(result!.externalIdentity.sourceUserId);
    expect(stored.avatar).toMatch(/^mirror-/);
  });

  it('an expired signed bridge picture is never fetched, never persisted, never served', async () => {
    const local = `ig${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const acct = `${local}@mastodon.social`;
    const actorUri = `https://mastodon.social/users/${local}`;
    route({});
    jest.spyOn(federationService, 'fetchActorProfile').mockResolvedValue({
      actorUri, transportAcct: acct, protocol: 'activitypub', evidenceLinks: [], domain: 'mastodon.social',
      username: acct, displayName: 'Expired', avatarUrl: EXPIRED_FBCDN, bio: '',
    });

    const result = await federationService.resolveExternalActorIdentity(actorUri);
    await settle();
    expect(result?.user.avatar).toBeUndefined();
    expect(fetchedUrls()).not.toContain(EXPIRED_FBCDN);
    const stored = await avatarOf(result!.externalIdentity.sourceUserId);
    expect(stored.avatar).toBeNull();
    // The failed attempt starts the retry clock.
    expect(stored.fetchedAt).toBeInstanceOf(Date);
  });

  it('clears a legacy remote URL (any host, even a live one) on re-registration but keeps a mirrored file id', async () => {
    const legacy = await seedUser('mastodon.social', 'https://files.mastodon.social/accounts/avatars/live.png');
    await getDb().insert(externalIdentities).values({ canonicalAcct: legacy.acct, userId: legacy.id, network: 'mastodon.social' });
    await getDb().insert(externalIdentityActors).values({ actorUri: legacy.actorUri, canonicalAcct: legacy.acct, transportAcct: legacy.acct, protocol: 'activitypub' });
    await registerExternalIdentity({ canonicalAcct: legacy.acct, actorUri: legacy.actorUri, transportAcct: legacy.acct, protocol: 'activitypub', profile: { displayName: 'L' } });
    expect((await avatarOf(legacy.id)).avatar).toBeNull();

    const mirrored = await seedUser('mastodon.social', 'kept-file-id');
    await getDb().insert(externalIdentities).values({ canonicalAcct: mirrored.acct, userId: mirrored.id, network: 'mastodon.social' });
    await getDb().insert(externalIdentityActors).values({ actorUri: mirrored.actorUri, canonicalAcct: mirrored.acct, transportAcct: mirrored.acct, protocol: 'activitypub' });
    await registerExternalIdentity({ canonicalAcct: mirrored.acct, actorUri: mirrored.actorUri, transportAcct: mirrored.acct, protocol: 'activitypub', profile: { displayName: 'M' } });
    expect((await avatarOf(mirrored.id)).avatar).toBe('kept-file-id');
  });
});

describe('the avatar mirror worker', () => {
  it('a 403 from the source clears a legacy remote URL instead of keeping it', async () => {
    const picture = 'https://files.example.social/gone.png';
    const user = await seedUser('example.social', picture);
    route({ [picture]: () => reply(403) });

    federationService.scheduleAvatarRefresh(user.id, picture, undefined, { force: false });
    await settle();
    expect((await avatarOf(user.id)).avatar).toBeNull();
    expect(mockCacheInvalidate).toHaveBeenCalledWith(user.id);
  });

  it('an atproto user whose Bluesky CDN picture fails ends with no avatar, not the URL', async () => {
    const picture = `https://cdn.bsky.app/img/avatar/plain/did:plc:${randomUUID()}/x@jpeg`;
    const user = await seedUser('bsky.social', picture);
    route({ [picture]: () => reply(404) });
    federationService.scheduleAvatarRefresh(user.id, picture, undefined, { force: false });
    await settle();
    expect((await avatarOf(user.id)).avatar).toBeNull();
  });

  it('keeps the previous mirrored avatar on a transient failure', async () => {
    const picture = 'https://files.example.social/flaky.png';
    const user = await seedUser('example.social', 'previous-mirror', { federationLastAvatarFetchedAt: new Date(Date.now() - 60 * 60_000) });
    route({ [picture]: () => reply(503) });

    federationService.scheduleAvatarRefresh(user.id, picture, 'previous-mirror', { force: true });
    await settle();
    expect(fetchedUrls()).toContain(picture);
    expect((await avatarOf(user.id)).avatar).toBe('previous-mirror');
  });

  it('keeps the previous mirrored avatar when an instagram picture fails and Graph is disabled', async () => {
    const user = await seedUser('instagram.com', 'previous-mirror', { federationLastAvatarFetchedAt: new Date(Date.now() - 60 * 60_000) });
    route({});
    federationService.scheduleAvatarRefresh(user.id, EXPIRED_FBCDN, 'previous-mirror', { force: true });
    await settle();
    expect(graphCalls()).toHaveLength(0);
    expect((await avatarOf(user.id)).avatar).toBe('previous-mirror');
  });

  it('does not retry a failed mirror inside the throttle window', async () => {
    const picture = 'https://files.example.social/retry.png';
    const user = await seedUser('example.social', null, { federationLastAvatarFetchedAt: new Date(Date.now() - 60_000) });
    route({ [picture]: image });
    federationService.scheduleAvatarRefresh(user.id, picture, undefined, { force: false });
    await settle();
    expect(fetchedUrls()).toHaveLength(0);
    expect((await avatarOf(user.id)).avatar).toBeNull();
  });
});

describe('Instagram Graph picture fallback', () => {
  it('mirrors a FRESH Business Discovery picture when the bridge URL has expired', async () => {
    enableGraph();
    const user = await seedUser('instagram.com', EXPIRED_FBCDN);
    const fresh = GRAPH_PICTURE();
    route({ [fresh]: image }, { id: `1784${Date.now()}`, picture: fresh });

    federationService.scheduleAvatarRefresh(user.id, EXPIRED_FBCDN, undefined, { force: false });
    await settle();
    expect(fetchedUrls()).not.toContain(EXPIRED_FBCDN);
    expect(graphCalls()).toHaveLength(1);
    expect(fetchedUrls()).toContain(fresh);
    expect((await avatarOf(user.id)).avatar).toMatch(/^mirror-/);
    expect(mockAssetUploadFileDirect).toHaveBeenCalledWith(user.id, expect.any(Buffer), 'image/jpeg', expect.any(String), 'public',
      expect.objectContaining({ remoteUrl: fresh }));
  });

  it('also falls back when a live-looking bridge URL answers 403', async () => {
    enableGraph();
    const bridge = LIVE_FBCDN();
    const user = await seedUser('instagram.com', null);
    const fresh = GRAPH_PICTURE();
    route({ [bridge]: () => reply(403), [fresh]: image }, { id: `1784${Date.now()}`, picture: fresh });

    federationService.scheduleAvatarRefresh(user.id, bridge, undefined, { force: false });
    await settle();
    expect(fetchedUrls()).toEqual(expect.arrayContaining([bridge, fresh]));
    expect((await avatarOf(user.id)).avatar).toMatch(/^mirror-/);
  });

  it('does not call Graph for a transient bridge failure', async () => {
    enableGraph();
    const bridge = LIVE_FBCDN();
    const user = await seedUser('instagram.com', null);
    route({ [bridge]: () => reply(502) }, { id: '1', picture: GRAPH_PICTURE() });
    federationService.scheduleAvatarRefresh(user.id, bridge, undefined, { force: false });
    await settle();
    expect(graphCalls()).toHaveLength(0);
    expect((await avatarOf(user.id)).avatar).toBeNull();
  });

  it('a personal (non-Business) account falls back to no avatar', async () => {
    enableGraph();
    const user = await seedUser('instagram.com', EXPIRED_FBCDN);
    route({}, { notBusiness: true });
    federationService.scheduleAvatarRefresh(user.id, EXPIRED_FBCDN, undefined, { force: false });
    await settle();
    expect(graphCalls()).toHaveLength(1);
    expect((await avatarOf(user.id)).avatar).toBeNull();
  });

  it('refuses a Graph account that contradicts the pinned first-party owner', async () => {
    enableGraph();
    const user = await seedUser('instagram.com', null);
    await getDb().insert(externalIdentities).values({ canonicalAcct: user.acct, userId: user.id, network: 'instagram.com' });
    await getDb().insert(externalIdentityActors).values({ actorUri: user.actorUri, canonicalAcct: user.acct, transportAcct: `${user.local}@kilogram.makeup`, protocol: 'activitypub' });
    const now = new Date();
    await getDb().insert(externalIdentityInstagramPins).values({ state: 'pinned', actorUri: user.actorUri, canonicalAcct: user.acct, sourceUserId: user.id,
      instagramPk: '111', instagramGraphId: '17841400000000999', profileUrl: `https://www.instagram.com/${user.local}/`, documentHash: 'a'.repeat(64),
      policyVersion: 'meta-profile-badges-2026-09-13-v1', firstVerifiedAt: now, verifiedAt: now });
    const fresh = GRAPH_PICTURE();
    route({ [fresh]: image }, { id: '17841400000000123', picture: fresh });

    federationService.scheduleAvatarRefresh(user.id, EXPIRED_FBCDN, undefined, { force: false });
    await settle();
    expect(graphCalls()).toHaveLength(1);
    expect(fetchedUrls()).not.toContain(fresh);
    expect((await avatarOf(user.id)).avatar).toBeNull();
  });

  it('is never consulted for another network', async () => {
    enableGraph();
    const user = await seedUser('mastodon.social', null);
    route({}, { id: '1', picture: GRAPH_PICTURE() });
    federationService.scheduleAvatarRefresh(user.id, EXPIRED_FBCDN, undefined, { force: false });
    await settle();
    expect(graphCalls()).toHaveLength(0);
  });
});

describe('serializers withhold a federated remote-URL avatar', () => {
  it('drops it for a federated user and keeps a local user avatar untouched', () => {
    expect(formatUserResponse({ _id: 'a', type: 'federated', username: 'x@instagram.com', avatar: EXPIRED_FBCDN })?.avatar).toBeUndefined();
    expect(formatUserResponse({ _id: 'b', type: 'federated', username: 'y@instagram.com', avatar: 'file-id' })?.avatar).toBe('file-id');
    expect(formatUserResponse({ _id: 'd', type: 'federated', username: 'w@bsky.social', avatar: 'data:image/png;base64,AA' })?.avatar).toBeUndefined();
    expect(formatUserResponse({ _id: 'c', type: 'local', username: 'z', avatar: 'https://example.com/a.png' })?.avatar).toBe('https://example.com/a.png');
  });
});

describe('repairFederatedRemoteAvatars', () => {
  /** Only this test's rows: other files seed the shared database too. */
  async function seedCohort() {
    const expiredIg = await seedUser('instagram.com', EXPIRED_FBCDN);
    const liveUrl = `https://files.repair.example/${randomUUID()}.png`;
    const live = await seedUser('repair.example', liveUrl);
    const deadUrl = `https://files.repair.example/${randomUUID()}-gone.png`;
    const dead = await seedUser('repair.example', deadUrl);
    const mirrored = await seedUser('repair.example', 'already-a-file-id');
    const dataUri = await seedUser('repair.example', 'data:image/png;base64,AAAA');
    const local = await getDb().insert(users).values({ type: 'local', username: `l${randomUUID().slice(0, 8)}`, avatar: 'https://example.com/local.png' })
      .returning({ id: users.id });
    return { expiredIg, live, liveUrl, dead, deadUrl, mirrored, dataUri, localId: local[0].id };
  }
  const mine = (ids: string[]) => (line: string) => ids.some((id) => line.includes(id));

  it('dry run (the default) reports and writes nothing', async () => {
    const c = await seedCohort();
    route({});
    const lines: string[] = [];
    const result = await repairFederatedRemoteAvatars({ log: (l) => lines.push(l), batchSize: 2 });
    expect(result.apply).toBe(false);
    const ids = [c.expiredIg.id, c.live.id, c.dead.id, c.dataUri.id];
    const reported = lines.filter(mine(ids));
    expect(reported).toHaveLength(4);
    expect(lines.some(mine([c.mirrored.id, c.localId]))).toBe(false);
    expect(reported.find(mine([c.expiredIg.id]))).toContain('"expiredSigned":true');
    expect(result.scanned).toBeGreaterThanOrEqual(3);
    expect(fetchedUrls()).toHaveLength(0);
    expect((await avatarOf(c.expiredIg.id)).avatar).toBe(EXPIRED_FBCDN);
    expect((await avatarOf(c.live.id)).avatar).toBe(c.liveUrl);
  });

  it('apply mirrors what it can, clears the rest, and a second pass finds nothing', async () => {
    enableGraph();
    const c = await seedCohort();
    const fresh = GRAPH_PICTURE();
    route({ [c.liveUrl]: image, [c.deadUrl]: () => reply(404), [fresh]: image }, { id: `1784${Date.now()}`, picture: fresh });

    const lines: string[] = [];
    const first = await repairFederatedRemoteAvatars({ apply: true, log: (l) => lines.push(l) });
    expect(first.apply).toBe(true);
    expect((await avatarOf(c.live.id)).avatar).toMatch(/^mirror-/);
    expect((await avatarOf(c.expiredIg.id)).avatar).toMatch(/^mirror-/);
    expect(lines.find(mine([c.expiredIg.id]))).toContain('"source":"instagram_graph"');
    expect((await avatarOf(c.dead.id)).avatar).toBeNull();
    expect((await avatarOf(c.dataUri.id)).avatar).toBeNull();
    expect(fetchedUrls().some((url) => url.startsWith('data:'))).toBe(false);
    expect((await avatarOf(c.mirrored.id)).avatar).toBe('already-a-file-id');
    const [local] = await getDb().select({ avatar: users.avatar }).from(users).where(eq(users.id, c.localId));
    expect(local.avatar).toBe('https://example.com/local.png');
    expect(mockCacheInvalidate).toHaveBeenCalledWith(c.dead.id);
    expect(first.mirrored).toBeGreaterThanOrEqual(2);
    expect(first.cleared).toBeGreaterThanOrEqual(1);

    const again: string[] = [];
    await repairFederatedRemoteAvatars({ apply: true, log: (l) => again.push(l) });
    expect(again.filter(mine([c.expiredIg.id, c.live.id, c.dead.id, c.dataUri.id]))).toHaveLength(0);
  });

  it('never overwrites a row another writer changed after it was read', async () => {
    const url = `https://files.repair.example/${randomUUID()}-race.png`;
    const user = await seedUser('repair.example', url);
    route({ [url]: () => reply(404) });
    // A concurrent mirror lands between the read and the conditional write.
    jest.spyOn(federationService, 'mirrorFederatedAvatar').mockImplementation(async (userId) => {
      if (userId === user.id) await getDb().update(users).set({ avatar: 'concurrent-mirror' }).where(eq(users.id, user.id));
      return { fileId: null, notModified: false, failure: 'permanent' };
    });
    const lines: string[] = [];
    await repairFederatedRemoteAvatars({ apply: true, log: (l) => lines.push(l) });
    expect(lines.find(mine([user.id]))).toContain('changed_concurrently');
    expect((await avatarOf(user.id)).avatar).toBe('concurrent-mirror');
  });
});
