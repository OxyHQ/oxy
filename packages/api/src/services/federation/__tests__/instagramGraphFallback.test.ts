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
import { externalIdentities, externalIdentityActors, externalIdentityInstagramPins, externalIdentityMetaProofs, users } from '../../../db/schema';
import { federationService } from '../../federation.service';
import { lookupExternalIdentity, registerExternalIdentity } from '../../externalIdentityRegistry.service';
import { logger } from '../../../utils/logger';
import { resetInstagramGraphStateForTests } from '../instagramGraph';

const TOKEN = 'EAAG-test-graph-token-never-logged';
const BUSINESS_ID = '17841400000000001';
/** The zuck fixture's first-party graph id, replaced per test by a unique one. */
const FIXTURE_GRAPH_ID = '17841401746480004';
const uniqueGraphId = () => `1784${String(Date.now()).slice(-8)}${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`;

beforeAll(connectPostgres);
afterAll(closePostgres);
beforeEach(() => {
  process.env.INSTAGRAM_GRAPH_FALLBACK_ENABLED = 'true';
  process.env.META_GRAPH_ACCESS_TOKEN = TOKEN;
  process.env.META_IG_BUSINESS_ACCOUNT_ID = BUSINESS_ID;
  delete process.env.META_GRAPH_API_VERSION;
  resetInstagramGraphStateForTests();
  jest.mocked(logger.warn).mockClear();
  jest.mocked(logger.info).mockClear();
});
afterEach(() => {
  delete process.env.INSTAGRAM_GRAPH_FALLBACK_ENABLED;
  delete process.env.META_GRAPH_ACCESS_TOKEN;
  delete process.env.META_IG_BUSINESS_ACCOUNT_ID;
  jest.restoreAllMocks();
});

function response(url: string, body: unknown, contentType = 'application/activity+json', status = 200, headers: Record<string, string> = {}) {
  return { status, finalUrl: url, headers: { 'content-type': contentType, ...headers },
    response: Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]) };
}

type GraphAnswer = { id: string; name?: string } | { status: number; code: number; subcode?: number };

function setup(options: { kilogram?: 'ok' | 'rate_limited'; graph?: GraphAnswer; firstPartyPages?: boolean } = {}) {
  const handle = `graph${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const acct = `${handle}@instagram.com`;
  const igUri = `https://kilogram.makeup/users/${handle}`;
  const thUri = `https://threads.net/ap/users/${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const graphId = uniqueGraphId();
  const state: { kilogram: 'ok' | 'rate_limited'; graph: GraphAnswer; firstPartyPages: boolean } = {
    kilogram: options.kilogram ?? 'rate_limited', graph: options.graph ?? { id: graphId }, firstPartyPages: options.firstPartyPages ?? false };
  const pages = {
    ig: readFileSync(join(__dirname, '../__fixtures__/meta-profile-proof/instagram-zuck.html'), 'utf8').replaceAll('zuck', handle).replaceAll(FIXTURE_GRAPH_ID, graphId),
    th: readFileSync(join(__dirname, '../__fixtures__/meta-profile-proof/threads-zuck.html'), 'utf8').replaceAll('zuck', handle),
  };
  const actor = (id: string) => ({ id, type: 'Person', name: 'Mark Zuckerberg', preferredUsername: handle, inbox: `${id}/inbox`, summary: 'Source biography' });
  const instagramActor = { ...actor(igUri), attachment: [{ name: 'Official', value: `<a href="https://www.instagram.com/${handle}/" rel="me">Official</a>` }] };
  mockSafeFetch.mockReset().mockImplementation(async (url: string) => {
    if (url.startsWith('https://graph.facebook.com/')) {
      const fields = new URL(url).searchParams.get('fields') ?? '';
      const username = /business_discovery\.username\(([^)]+)\)/.exec(fields)?.[1];
      const answer = state.graph;
      if ('status' in answer) {
        return response(url, { error: { message: 'Graph error', type: 'OAuthException', code: answer.code, error_subcode: answer.subcode, fbtrace_id: 'trace' } },
          'application/json', answer.status, { 'x-app-usage': '{"call_count":12,"total_cputime":1,"total_time":1}' });
      }
      return response(url, { business_discovery: { id: answer.id, username, name: answer.name ?? 'Mark Zuckerberg', biography: 'Graph biography @friend',
        profile_picture_url: 'https://scontent.example/avatar.jpg', followers_count: 1, follows_count: 2, media_count: 3 }, id: BUSINESS_ID }, 'application/json');
    }
    if (url.includes('kilogram.makeup/.well-known/webfinger')) {
      if (state.kilogram === 'rate_limited') return response(url, '', 'text/plain', 429);
      const resource = new URL(url).searchParams.get('resource');
      return response(url, { subject: resource, links: [{ rel: 'self', type: 'application/activity+json', href: igUri }] }, 'application/jrd+json');
    }
    if (url.includes('threads.net/.well-known/webfinger')) {
      return response(url, { subject: `acct:${handle}@threads.net`, links: [{ rel: 'self', type: 'application/activity+json', href: thUri }] }, 'application/jrd+json');
    }
    if (url === igUri) return state.kilogram === 'ok' ? response(url, instagramActor) : response(url, '', 'text/plain', 429);
    if (url === thUri) return response(url, actor(thUri));
    if (url === `https://www.instagram.com/${handle}/`) return state.firstPartyPages ? response(url, pages.ig, 'text/html') : response(url, '', 'text/html', 503);
    if (url === `https://www.threads.com/@${handle}`) return state.firstPartyPages ? response(url, pages.th, 'text/html') : response(url, '', 'text/html', 503);
    throw new Error(`Unexpected transport URL ${url}`);
  });
  jest.spyOn(federationService, 'scheduleAvatarRefresh').mockImplementation(() => undefined);
  return { handle, acct, igUri, thUri, state, graphId };
}

const graphCalls = () => mockSafeFetch.mock.calls.filter(([url]) => String(url).startsWith('https://graph.facebook.com/'));
const logged = () => JSON.stringify([jest.mocked(logger.warn).mock.calls, jest.mocked(logger.info).mock.calls, jest.mocked(logger.error).mock.calls]);

it('falls back to Business Discovery when kilogram answers 429, without a stable id or a URL-borne token', async () => {
  const source = setup();
  const result = await federationService.resolveExternalIdentity({ handle: source.acct });
  expect(result?.externalIdentity).toMatchObject({ canonicalAcct: source.acct, network: 'instagram.com', protocol: 'instagram-graph',
    actorUri: `instagram-graph:${source.graphId}`, transportAcct: source.acct });
  expect(result?.user.username).toBe(source.acct);
  expect(result?.user.bio).toBe('Graph biography @friend@instagram.com');
  const [stored] = await getDb().select().from(externalIdentities).where(eq(externalIdentities.canonicalAcct, source.acct));
  expect(stored.stableId).toBeNull();
  const [call] = graphCalls();
  expect(String(call[0])).toMatch(new RegExp(`^https://graph\\.facebook\\.com/v23\\.0/${BUSINESS_ID}\\?fields=`));
  expect(String(call[0])).not.toContain(TOKEN);
  expect(call[1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  expect(logged()).not.toContain(TOKEN);
});

it.each([
  ['the flag is off', () => { delete process.env.INSTAGRAM_GRAPH_FALLBACK_ENABLED; }],
  ['the token is missing', () => { delete process.env.META_GRAPH_ACCESS_TOKEN; }],
  ['the business account id is not numeric', () => { process.env.META_IG_BUSINESS_ACCOUNT_ID = 'abc'; }],
])('is fully inert when %s: the kilogram 429 stays a null', async (_label, configure) => {
  const source = setup();
  configure();
  expect(await federationService.resolveExternalIdentity({ handle: source.acct })).toBeNull();
  expect(await federationService.resolveExternalIdentity({ handle: source.acct, protocol: 'instagram-graph' })).toBeNull();
  expect(graphCalls()).toHaveLength(0);
  expect(await lookupExternalIdentity(source.acct)).toBeNull();
});

it('an explicit instagram-graph request goes straight to Graph and never to WebFinger', async () => {
  const source = setup({ kilogram: 'ok' });
  const result = await federationService.resolveExternalIdentity({ handle: `https://www.instagram.com/${source.handle}/`, protocol: 'instagram-graph' });
  expect(result?.externalIdentity.protocol).toBe('instagram-graph');
  expect(mockSafeFetch.mock.calls.some(([url]) => String(url).includes('webfinger'))).toBe(false);
  expect(await federationService.resolveExternalIdentity({ handle: `${source.handle}@mastodon.social`, protocol: 'instagram-graph' })).toBeNull();
});

it('kilogram first, then Graph: both sources converge on one Oxy user', async () => {
  const source = setup({ kilogram: 'ok' });
  const bridge = await federationService.resolveExternalIdentity({ handle: source.acct });
  expect(bridge?.externalIdentity.protocol).toBe('activitypub');
  const graph = await federationService.resolveExternalIdentity({ handle: source.acct, protocol: 'instagram-graph' });
  expect(graph?.externalIdentity.protocol).toBe('instagram-graph');
  expect(graph?.user.id).toBe(bridge?.user.id);
  expect(graph?.externalIdentity.sourceUserId).toBe(bridge?.externalIdentity.sourceUserId);
  expect(graph?.externalIdentities.map(identity => identity.protocol).sort()).toEqual(['activitypub', 'instagram-graph']);
  // With both stored, a kilogram outage for the known account still answers through Graph.
  source.state.kilogram = 'rate_limited';
  resetInstagramGraphStateForTests();
  expect((await federationService.resolveExternalIdentity({ handle: source.acct }))?.user.id).toBe(bridge?.user.id);
});

it('Graph first, then kilogram: both sources converge, and the Graph creator can acquire the owner pin', async () => {
  const source = setup({ kilogram: 'rate_limited', firstPartyPages: true });
  const graph = await federationService.resolveExternalIdentity({ handle: source.acct });
  expect(graph?.externalIdentity.protocol).toBe('instagram-graph');
  source.state.kilogram = 'ok';
  const bridge = await federationService.resolveExternalActorIdentity(source.igUri, `${source.handle}@kilogram.makeup`);
  expect(bridge?.user.id).toBe(graph?.user.id);
  expect(bridge?.identityProof).toEqual({ state: 'verified' });
  const [pin] = await getDb().select().from(externalIdentityInstagramPins).where(eq(externalIdentityInstagramPins.actorUri, source.igUri));
  expect(pin).toMatchObject({ state: 'pinned', instagramGraphId: source.graphId });
  const [stored] = await getDb().select().from(externalIdentities).where(eq(externalIdentities.canonicalAcct, source.acct));
  expect(stored.stableId).toBe('instagram:pk:314216');
});

it('a Graph creator whose id differs from the first-party owner never acquires the pin', async () => {
  const source = setup({ kilogram: 'rate_limited', firstPartyPages: true, graph: { id: uniqueGraphId() } });
  const graph = await federationService.resolveExternalIdentity({ handle: source.acct });
  expect(graph).not.toBeNull();
  source.state.kilogram = 'ok';
  const bridge = await federationService.resolveExternalActorIdentity(source.igUri, `${source.handle}@kilogram.makeup`);
  expect(bridge?.identityProof).toEqual({ state: 'pending', reason: 'legacy_source_lineage_unproven' });
  const [stored] = await getDb().select().from(externalIdentities).where(eq(externalIdentities.canonicalAcct, source.acct));
  expect(stored.stableId).toBeNull();
});

async function pinnedByColdDiscovery() {
  const source = setup({ kilogram: 'ok', firstPartyPages: true });
  const bridge = await federationService.resolveExternalActorIdentity(source.igUri);
  expect(bridge?.identityProof).toEqual({ state: 'verified' });
  const [identity] = await getDb().select().from(externalIdentities).where(eq(externalIdentities.canonicalAcct, source.acct));
  expect(identity.stableId).toBe('instagram:pk:314216');
  const [proof] = await getDb().select().from(externalIdentityMetaProofs).where(eq(externalIdentityMetaProofs.instagramActorUri, source.igUri));
  expect(proof.state).toBe('verified');
  if (!bridge) throw new Error('Expected pinned discovery');
  return { source, bridge, identity };
}

it('a pinned identity admits a Graph source whose id matches the pin, without clobbering or revoking anything', async () => {
  const { source, bridge, identity } = await pinnedByColdDiscovery();
  source.state.kilogram = 'rate_limited';
  const graph = await federationService.resolveExternalIdentity({ handle: source.acct });
  expect(graph?.externalIdentity.protocol).toBe('instagram-graph');
  expect(graph?.user.id).toBe(bridge.user.id);
  const [after] = await getDb().select().from(externalIdentities).where(eq(externalIdentities.canonicalAcct, source.acct));
  expect(after.stableId).toBe(identity.stableId);
  expect(after.evidenceLinks).toEqual(identity.evidenceLinks);
  // The bridge's own 429 revokes as it always has; a Graph outage afterwards does not.
  const [proofBefore] = await getDb().select().from(externalIdentityMetaProofs).where(eq(externalIdentityMetaProofs.instagramActorUri, source.igUri));
  const revokedAtBefore = after.metaProofRevokedAt;
  source.state.graph = { status: 500, code: 2 };
  resetInstagramGraphStateForTests();
  expect(await federationService.resolveExternalActorIdentity(`instagram-graph:${source.graphId}`)).toBeNull();
  const [proofAfter] = await getDb().select().from(externalIdentityMetaProofs).where(eq(externalIdentityMetaProofs.instagramActorUri, source.igUri));
  expect(proofAfter).toEqual(proofBefore);
  const [final] = await getDb().select().from(externalIdentities).where(eq(externalIdentities.canonicalAcct, source.acct));
  expect(final.metaProofRevokedAt).toEqual(revokedAtBefore);
  expect(final.stableId).toBe(identity.stableId);
});

it('a pinned identity defers a Graph source whose id differs from the pin', async () => {
  const { source } = await pinnedByColdDiscovery();
  source.state.kilogram = 'rate_limited';
  const other = uniqueGraphId();
  source.state.graph = { id: other };
  expect(await federationService.resolveExternalIdentity({ handle: source.acct })).toBeNull();
  expect(await getDb().select().from(externalIdentityActors).where(eq(externalIdentityActors.actorUri, `instagram-graph:${other}`))).toEqual([]);
  const [after] = await getDb().select().from(externalIdentities).where(eq(externalIdentities.canonicalAcct, source.acct));
  expect(after.stableId).toBe('instagram:pk:314216');
});

it('refuses to refresh a Graph source whose username now names another IG user', async () => {
  const source = setup();
  const first = await federationService.resolveExternalIdentity({ handle: source.acct });
  expect(first?.externalIdentity.actorUri).toBe(`instagram-graph:${source.graphId}`);
  const recycled = uniqueGraphId();
  source.state.graph = { id: recycled, name: 'Somebody Else' };
  resetInstagramGraphStateForTests();
  expect(await federationService.resolveExternalActorIdentity(`instagram-graph:${source.graphId}`)).toBeNull();
  expect(await getDb().select().from(externalIdentityActors).where(eq(externalIdentityActors.actorUri, `instagram-graph:${recycled}`))).toEqual([]);
  const [user] = await getDb().select({ name: users.nameDisplay }).from(users).where(eq(users.id, first?.user.id ?? ''));
  expect(user.name).toBe('Mark Zuckerberg');
  expect(logged()).toContain('username_names_another_account');
});

it('a refresh of the same Graph id updates the profile in place', async () => {
  const source = setup();
  const first = await federationService.resolveExternalIdentity({ handle: source.acct });
  source.state.graph = { id: source.graphId, name: 'Mark Updated' };
  resetInstagramGraphStateForTests();
  const refreshed = await federationService.resolveExternalActorIdentity(`instagram-graph:${source.graphId}`);
  expect(refreshed?.user.id).toBe(first?.user.id);
  const [user] = await getDb().select({ name: users.nameDisplay }).from(users).where(eq(users.id, first?.user.id ?? ''));
  expect(user.name).toBe('Mark Updated');
});

it('a personal or missing account (110/2207013) is null, and the answer is cached', async () => {
  const source = setup({ graph: { status: 400, code: 110, subcode: 2207013 } });
  expect(await federationService.resolveExternalIdentity({ handle: source.acct })).toBeNull();
  expect(await federationService.resolveExternalIdentity({ handle: source.acct })).toBeNull();
  expect(graphCalls()).toHaveLength(1);
  expect(await lookupExternalIdentity(source.acct)).toBeNull();
});

it.each([
  ['token_invalid', { status: 400, code: 190 }],
  ['throttled', { status: 400, code: 4 }],
  ['throttled', { status: 400, code: 17 }],
] as const)('a %s Graph error is null with a clear log and no token', async (reason, graph) => {
  const source = setup({ graph });
  expect(await federationService.resolveExternalIdentity({ handle: source.acct })).toBeNull();
  expect(jest.mocked(logger.warn)).toHaveBeenCalledWith('Instagram Graph lookup failed', expect.objectContaining({ reason, code: graph.code, username: source.handle }));
  expect(logged()).not.toContain(TOKEN);
  if (reason === 'throttled') {
    // The throttle opens a local cooldown: the next lookup does not call Meta.
    const other = setup();
    expect(await federationService.resolveExternalIdentity({ handle: other.acct })).toBeNull();
    expect(graphCalls()).toHaveLength(0);
  }
});

it('a renamed account whose Graph id already backs another handle is refused, not re-pointed', async () => {
  const before = setup();
  expect(await federationService.resolveExternalIdentity({ handle: before.acct })).not.toBeNull();
  const after = setup({ graph: { id: before.graphId } });
  expect(await federationService.resolveExternalIdentity({ handle: after.acct })).toBeNull();
  const [actor] = await getDb().select().from(externalIdentityActors).where(eq(externalIdentityActors.actorUri, `instagram-graph:${before.graphId}`));
  expect(actor.canonicalAcct).toBe(before.acct);
  expect(await lookupExternalIdentity(after.acct)).toBeNull();
  expect(logged()).toContain('graph_id_bound_to_other_account');
});

it('never trusts a Graph answer naming a different username', async () => {
  const source = setup();
  mockSafeFetch.mockImplementation(async (url: string) => url.startsWith('https://graph.facebook.com/')
    ? response(url, { business_discovery: { id: uniqueGraphId(), username: 'someoneelse' } }, 'application/json')
    : response(url, '', 'text/plain', 429));
  expect(await federationService.resolveExternalIdentity({ handle: source.acct })).toBeNull();
});

it('a stored Graph-only source is registered through the registry guard as instagram-graph without a stable id', async () => {
  await expect(registerExternalIdentity({ canonicalAcct: 'x@instagram.com', actorUri: 'instagram-graph:not-a-number', transportAcct: 'x@instagram.com',
    protocol: 'instagram-graph', profile: {} })).rejects.toThrow('Invalid Instagram Graph source');
  await expect(registerExternalIdentity({ canonicalAcct: 'x@threads.net', actorUri: 'instagram-graph:1', transportAcct: 'x@threads.net',
    protocol: 'instagram-graph', profile: {} })).rejects.toThrow('Invalid Instagram Graph source');
  await expect(registerExternalIdentity({ canonicalAcct: 'x@instagram.com', actorUri: 'instagram-graph:1', transportAcct: 'x@instagram.com',
    protocol: 'instagram-graph', stableId: 'instagram:pk:1', profile: {} })).rejects.toThrow('Invalid Instagram Graph source');
});
