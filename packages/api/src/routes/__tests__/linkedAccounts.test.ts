/**
 * `/linked-accounts`, against a REAL Postgres and a fake Mastodon server.
 *
 * The fake server is the linked-accounts transport itself (an in-memory
 * function): the production transport is `safeFetch`, which — correctly —
 * refuses loopback, so a socket-based fake could never be reached through it.
 * The atproto library is replaced by a double that drives Oxy's real state and
 * session stores exactly as `@atproto/oauth-client` does.
 *
 * What is pinned:
 *  - start → callback verifies the account the INSTANCE names and hands
 *    `returnTo` a one-time `link_code`; the token is revoked at the instance
 *    and never stored (no column exists for it);
 *  - only the user who started the flow can complete it: the victim of a flow
 *    somebody else started burns the code and nobody is linked;
 *  - a replayed or expired state is refused without redirecting anywhere;
 *  - a second Oxy user claiming a live account gets 409;
 *  - `returnTo` must be a redirect URI registered on a trusted app;
 *  - concurrent starts at a new instance register Oxy there once;
 *  - a private instance is refused before any request is made to it;
 *  - the service read requires `linked-accounts:read`;
 *  - aliases follow live ActivityPub links.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { headers: Record<string, string | undefined>; user?: { id: string; _id: string } }, res: { status(code: number): { json(body: unknown): void } }, next: () => void) => {
    const id = req.headers['x-test-user'];
    if (!id) return res.status(401).json({ error: 'Authentication required' });
    req.user = { id, _id: id };
    next();
  },
  serviceAuthMiddleware: (req: { headers: Record<string, string | undefined>; serviceApp?: unknown }, res: { status(code: number): { json(body: unknown): void } }, next: () => void) => {
    const scopes = req.headers['x-test-scopes'];
    if (scopes === undefined) return res.status(401).json({ error: 'Authentication required' });
    req.serviceApp = { appId: 'move-app', credentialId: 'cred', scopes: scopes ? scopes.split(',') : [], tier: 'internal' };
    next();
  },
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../utils/userCache', () => ({ __esModule: true, default: { invalidate: jest.fn() } }));
// The real module is ESM and cannot load under ts-jest, so the loader hands out
// only the two error classes Oxy classifies a failed start by, shaped as
// `@atproto/oauth-client` defines them. No `NodeOAuthClient`: the client is the
// double below, so building a real one fails loudly.
jest.mock('../../services/linkedAccounts/atprotoClientLoader', () => {
  class OAuthResolverError extends Error {}
  class OAuthResponseError extends Error {
    readonly error?: string;
    constructor(readonly response: { status: number }, readonly payload: { error?: string }) {
      super(`OAuth "${payload.error}" error`);
      this.error = payload.error;
    }
    get status(): number {
      return this.response.status;
    }
  }
  const module = { OAuthResolverError, OAuthResponseError };
  return { loadAtprotoOAuthModule: () => Promise.resolve(module) };
});

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { linkedAccountOauthChallenges, mastodonAppRegistrations, userLinkedAccounts } from '../../db/schema/userLinkedAccounts';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import userCache from '../../utils/userCache';
import { setLinkedAccountTransportForTesting, UnsafeHostError } from '../../services/linkedAccounts/http';
import { loadAtprotoOAuthModule } from '../../services/linkedAccounts/atprotoClientLoader';
import { logger } from '../../utils/logger';
import {
  atprotoSessionsInFlight,
  atprotoStoresForTesting,
  setAtprotoClientForTesting,
  type AtprotoOAuthClientLike,
} from '../../services/linkedAccounts/atproto.provider';
import { aliasesForUser } from '../../services/linkedAccounts/linkedAccounts.service';
import linkedAccountsRouter from '../linkedAccounts';

process.env.OXY_API_URL = 'https://api.oxy.test';

// ── the fake Mastodon server ────────────────────────────────────────────────

interface FakeInstance {
  host: string;
  /** code → { token, username } */
  codes: Map<string, { username: string; verifier: string | null }>;
  tokens: Map<string, string>;
  revoked: string[];
  registrations: number;
}

const instances = new Map<string, FakeInstance>();
const privateHosts = new Set<string>(['intranet.example']);

function instance(host: string): FakeInstance {
  let found = instances.get(host);
  if (!found) {
    found = { host, codes: new Map(), tokens: new Map(), revoked: [], registrations: 0 };
    instances.set(host, found);
  }
  return found;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (privateHosts.has(url.hostname)) throw new UnsafeHostError('private');
  const server = instance(url.hostname);
  const form = request.method === 'POST' ? await request.text() : '';
  switch (`${request.method} ${url.pathname}`) {
    case 'POST /api/v1/apps':
      // A `notmastodon-*` server has no app registration; a `down-*` one is failing.
      if (server.host.startsWith('notmastodon-')) return json({ error: 'not found' }, 404);
      if (server.host.startsWith('down-')) return json({ error: 'unavailable' }, 503);
      server.registrations += 1;
      // A `race-*` server answers slowly, so concurrent starts overlap.
      if (server.host.startsWith('race-')) await new Promise((resolve) => setTimeout(resolve, 100));
      return json({ client_id: `client-${server.host}`, client_secret: `secret-${server.host}` });
    case 'POST /oauth/token': {
      const params = new URLSearchParams(form);
      const grant = server.codes.get(params.get('code') ?? '');
      if (!grant || params.get('client_secret') !== `secret-${server.host}` || params.get('code_verifier') !== grant.verifier) {
        return json({ error: 'invalid_grant' }, 400);
      }
      server.codes.delete(params.get('code') ?? '');
      const token = `token-${randomUUID()}`;
      server.tokens.set(token, grant.username);
      return json({ access_token: token, token_type: 'Bearer', scope: 'read:accounts' });
    }
    case 'GET /api/v1/accounts/verify_credentials': {
      const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
      const username = server.tokens.get(token);
      if (!username) return json({ error: 'unauthorized' }, 401);
      return json({ id: '1', username, acct: username, url: `https://${server.host}/@${username}` });
    }
    case 'GET /.well-known/webfinger': {
      const resource = url.searchParams.get('resource') ?? '';
      const username = resource.replace(/^acct:/, '').split('@')[0];
      // A `liar-*` server claims an account and actor on another host.
      const home = server.host.startsWith('liar-') ? 'mastodon.social' : server.host;
      return json({
        subject: `acct:${username}@${home}`,
        links: [{ rel: 'self', type: 'application/activity+json', href: `https://${home}/users/${username}` }],
      });
    }
    case 'POST /oauth/revoke': {
      const token = new URLSearchParams(form).get('token') ?? '';
      server.revoked.push(token);
      server.tokens.delete(token);
      return json({});
    }
    default:
      return json({ error: 'not found' }, 404);
  }
}) as typeof fetch;

let restoreTransport: () => void;

// ── the atproto library double ──────────────────────────────────────────────

const atprotoDid = 'did:plc:abcdefghijklmnopqrstuvwx';
const signedOut: string[] = [];

const fakeAtproto: AtprotoOAuthClientLike = {
  async authorize(_input, options) {
    const key = `atp-${randomUUID()}`;
    await atprotoStoresForTesting.stateStore.set(key, {
      iss: 'https://bsky.social',
      dpopJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'private' },
      authMethod: { method: 'none' },
      verifier: 'library-verifier',
      appState: options?.state,
    });
    return new URL(`https://bsky.social/oauth/authorize?state=${key}`);
  },
  async callback(params) {
    const state = params.get('state') ?? '';
    const data = await atprotoStoresForTesting.stateStore.get(state);
    if (!data) throw new Error(`Unknown authorization session "${state}"`);
    if (params.get('error')) throw Object.assign(new Error('denied'), { state: data.appState });
    // The library stores the session it created before handing it back.
    await atprotoStoresForTesting.sessionStore.set(atprotoDid, { tokenSet: { access_token: 'secret' } });
    return {
      session: { did: atprotoDid, signOut: async () => void signedOut.push(atprotoDid) },
      state: String(data.appState),
    };
  },
  oauthResolver: {
    identityResolver: {
      async resolve(did) {
        return {
          did,
          handle: 'alice.bsky.social',
          didDoc: { service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example' }] },
        };
      },
    },
  },
};

// ── harness ─────────────────────────────────────────────────────────────────

let server: http.Server;

interface Result {
  status: number;
  location: string | null;
  body: Record<string, any>;
  text: string;
}

async function call(method: string, path: string, options: { user?: string; scopes?: string; body?: unknown } = {}): Promise<Result> {
  const { port } = server.address() as AddressInfo;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.user) headers['x-test-user'] = options.user;
  if (options.scopes !== undefined) headers['x-test-scopes'] = options.scopes;
  const response = await fetch(`http://127.0.0.1:${port}/linked-accounts${path}`, {
    method,
    headers,
    redirect: 'manual',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: Record<string, any> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  return { status: response.status, location: response.headers.get('location'), body, text };
}

async function newUser(): Promise<string> {
  const [row] = await getDb().insert(users).values({ color: 'teal' }).returning({ id: users.id });
  return row.id;
}

async function registeredClient(redirectUris: string[], type: 'first_party' | 'third_party' = 'first_party'): Promise<string> {
  const owner = await newUser();
  const [app] = await getDb()
    .insert(applications)
    .values({ name: `Move ${randomUUID()}`, ownerAccountId: owner, type, redirectUris })
    .returning({ id: applications.id });
  const publicKey = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  await getDb()
    .insert(applicationCredentials)
    .values({ applicationId: app.id, name: 'web', publicKey, type: 'public', environment: 'production' });
  return publicKey;
}

const RETURN_TO = 'https://move.oxy.test/linked';
/** A trusted app registering `RETURN_TO` and `oxymove://linked`. */
let client: string;

/** Start a Mastodon link, then have the fake instance approve it for `username`. */
async function authorizeAt(user: string, host: string, username: string, extra: Record<string, unknown> = {}) {
  const started = await call('POST', '/activitypub/start', { user, body: { instance: host, clientId: client, returnTo: RETURN_TO, ...extra } });
  expect(started.status).toBe(200);
  const authorizeUrl = new URL(started.body.data.authorizeUrl);
  const state = authorizeUrl.searchParams.get('state') ?? '';
  const code = `code-${randomUUID()}`;
  // The instance remembers the PKCE challenge's verifier the way a real one
  // checks it: here we look the verifier up to hand the fake server the pair.
  const [challenge] = await getDb()
    .select({ pkceVerifier: linkedAccountOauthChallenges.pkceVerifier })
    .from(linkedAccountOauthChallenges)
    .where(sql`${linkedAccountOauthChallenges.stateHash} = encode(sha256(convert_to(${state}, 'UTF8')), 'hex')`);
  instance(authorizeUrl.hostname).codes.set(code, { username, verifier: challenge?.pkceVerifier ?? null });
  return { authorizeUrl, state, code };
}

/** The provider sends the approving browser back to Oxy's callback. */
function callback(flow: { state: string; code: string }, network = 'activitypub'): Promise<Result> {
  return call('GET', `/${network}/callback?state=${encodeURIComponent(flow.state)}&code=${flow.code}`);
}

/** The one-time code a successful callback appended to `returnTo`. */
function linkCode(result: Result): string {
  expect(result.status).toBe(303);
  const code = new URL(result.location ?? '').searchParams.get('link_code');
  expect(code).toBeTruthy();
  return code ?? '';
}

function complete(user: string, code: string): Promise<Result> {
  return call('POST', '/complete', { user, body: { code } });
}

/** start → the instance approves → callback → complete, all as `user`. */
async function linkVia(user: string, host: string, username: string): Promise<Result> {
  return complete(user, linkCode(await callback(await authorizeAt(user, host, username))));
}

beforeAll(async () => {
  await connectPostgres();
  restoreTransport = setLinkedAccountTransportForTesting({
    fetch: fakeFetch,
    async assertPublicHost(host) {
      if (privateHosts.has(host)) throw new UnsafeHostError('private address');
    },
  });
  setAtprotoClientForTesting(fakeAtproto);
  client = await registeredClient([RETURN_TO, 'oxymove://linked']);
  const app = express();
  app.use(express.json());
  app.use('/linked-accounts', linkedAccountsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  restoreTransport();
  setAtprotoClientForTesting(null);
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await closePostgres();
});

describe('Mastodon-API: start → callback → complete', () => {
  it('verifies the account the instance names, links it only on complete, revokes the token, and stores none', async () => {
    const user = await newUser();
    const host = `social-${randomUUID().slice(0, 8)}.example`;
    const flow = await authorizeAt(user, `@alice@${host}`, 'alice');

    expect(flow.authorizeUrl.hostname).toBe(host);
    expect(flow.authorizeUrl.pathname).toBe('/oauth/authorize');
    expect(flow.authorizeUrl.searchParams.get('scope')).toBe('read:accounts');
    expect(flow.authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.authorizeUrl.searchParams.get('redirect_uri')).toBe('https://api.oxy.test/linked-accounts/activitypub/callback');

    const done = await callback(flow);
    expect(done.location?.startsWith(`${RETURN_TO}?link_code=`)).toBe(true);
    const code = linkCode(done);
    // The callback verified; it did not link.
    expect((await call('GET', '/', { user })).body.data.linkedAccounts).toEqual([]);

    const completed = await complete(user, code);
    expect(completed.status).toBe(200);
    const expected = {
      network: 'activitypub',
      accountKey: `alice@${host}`,
      actorUri: `https://${host}/users/alice`,
      handle: `@alice@${host}`,
      host,
      proofMethod: 'oauth',
    };
    expect(completed.body.data.linkedAccount).toMatchObject(expected);
    expect((await call('GET', '/', { user })).body.data.linkedAccounts).toEqual([expect.objectContaining(expected)]);

    // Completing again within the code's lifetime answers the same link.
    const again = await complete(user, code);
    expect(again.status).toBe(200);
    expect(again.body.data.linkedAccount.id).toBe(completed.body.data.linkedAccount.id);

    // The one token the instance issued was revoked there.
    const fake = instance(host);
    expect(fake.revoked).toHaveLength(1);
    expect(fake.tokens.size).toBe(0);
    // …and the challenge keeps no secret and no code, only its hash.
    const [spent] = await getDb()
      .select({
        usedAt: linkedAccountOauthChallenges.usedAt,
        pkceVerifier: linkedAccountOauthChallenges.pkceVerifier,
        status: linkedAccountOauthChallenges.status,
        linkCodeHash: linkedAccountOauthChallenges.linkCodeHash,
      })
      .from(linkedAccountOauthChallenges)
      .where(eq(linkedAccountOauthChallenges.userId, user));
    expect(spent).toMatchObject({ pkceVerifier: null, status: 'linked' });
    expect(spent.usedAt).not.toBeNull();
    expect(spent.linkCodeHash).not.toBe(code);

    expect(await aliasesForUser(user)).toEqual([`https://${host}/users/alice`]);
    expect(userCache.invalidate).toHaveBeenCalledWith(user);
  });

  it('registers Oxy once per instance and reuses it', async () => {
    const host = `reuse-${randomUUID().slice(0, 8)}.example`;
    await authorizeAt(await newUser(), host, 'one');
    await authorizeAt(await newUser(), host, 'two');
    expect(instance(host).registrations).toBe(1);
    const [row] = await getDb()
      .select({ scopes: mastodonAppRegistrations.scopes })
      .from(mastodonAppRegistrations)
      .where(eq(mastodonAppRegistrations.host, host));
    expect(row.scopes).toBe('read:accounts');
  });

  it('registers Oxy once when two starts race at a new instance', async () => {
    const host = `race-${randomUUID().slice(0, 8)}.example`;
    const [first, second] = [await newUser(), await newUser()];
    const [a, b] = await Promise.all([authorizeAt(first, host, 'one'), authorizeAt(second, host, 'two')]);
    expect(instance(host).registrations).toBe(1);
    expect(a.authorizeUrl.searchParams.get('client_id')).toBe(b.authorizeUrl.searchParams.get('client_id'));
  });

  it('refuses a replayed state without redirecting anywhere', async () => {
    const flow = await authorizeAt(await newUser(), `replay-${randomUUID().slice(0, 8)}.example`, 'bob');
    expect((await callback(flow)).status).toBe(303);
    const second = await callback(flow);
    expect(second.status).toBe(400);
    expect(second.location).toBeNull();
    expect(second.text).toContain('expired or was already used');
  });

  it('refuses an expired state', async () => {
    const user = await newUser();
    const flow = await authorizeAt(user, `expired-${randomUUID().slice(0, 8)}.example`, 'carol');
    await getDb()
      .update(linkedAccountOauthChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(linkedAccountOauthChallenges.userId, user));
    expect((await callback(flow)).status).toBe(400);
    expect(await call('GET', '/', { user })).toMatchObject({ body: { data: { linkedAccounts: [] } } });
  });

  it('refuses an expired or unknown link code', async () => {
    const user = await newUser();
    const code = linkCode(await callback(await authorizeAt(user, `late-${randomUUID().slice(0, 8)}.example`, 'lee')));
    await getDb()
      .update(linkedAccountOauthChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(linkedAccountOauthChallenges.userId, user));
    expect((await complete(user, code)).status).toBe(404);
    expect((await complete(user, 'not-a-code')).status).toBe(404);
    expect((await call('GET', '/', { user })).body.data.linkedAccounts).toEqual([]);
  });

  it('refuses a second Oxy user claiming a live account (409)', async () => {
    const host = `claim-${randomUUID().slice(0, 8)}.example`;
    expect((await linkVia(await newUser(), host, 'dana')).status).toBe(200);

    const intruder = await newUser();
    expect((await linkVia(intruder, host, 'dana')).status).toBe(409);
    expect(await aliasesForUser(intruder)).toEqual([]);
  });

  it('re-linking one\'s own live account refreshes it instead of failing', async () => {
    const user = await newUser();
    const host = `relink-${randomUUID().slice(0, 8)}.example`;
    for (let i = 0; i < 2; i++) expect((await linkVia(user, host, 'erin')).status).toBe(200);
    expect((await call('GET', '/', { user })).body.data.linkedAccounts).toHaveLength(1);
  });

  it('sends a cancelled authorization back as access_denied', async () => {
    const { state } = await authorizeAt(await newUser(), `deny-${randomUUID().slice(0, 8)}.example`, 'finn');
    const done = await call('GET', `/activitypub/callback?state=${encodeURIComponent(state)}&error=access_denied`);
    expect(done.location).toBe(`${RETURN_TO}?link_error=access_denied`);
  });
});

describe('a flow somebody else started cannot link anyone (login CSRF)', () => {
  it('burns the code when the approving user completes it, and links nobody', async () => {
    const attacker = await newUser();
    const victim = await newUser();
    const host = `csrf-${randomUUID().slice(0, 8)}.example`;

    // The attacker starts a flow and sends the authorize URL to the victim.
    // Nothing the attacker holds carries a link code.
    const flow = await authorizeAt(attacker, host, 'victim');
    expect(JSON.stringify(flow.authorizeUrl)).not.toContain('link_code');

    // The victim approves at their instance; the callback redirects THEIR
    // browser to the trusted app, which completes with the victim's session.
    const code = linkCode(await callback(flow));
    const refused = await complete(victim, code);
    expect(refused.status).toBe(403);

    // The code is burned: not even the starting user can use it now.
    expect((await complete(attacker, code)).status).toBe(404);
    expect(
      await getDb().select({ id: userLinkedAccounts.id }).from(userLinkedAccounts).where(eq(userLinkedAccounts.accountKey, `victim@${host}`)),
    ).toEqual([]);
    expect(await aliasesForUser(attacker)).toEqual([]);
  });
});

describe('Mastodon-API: an instance vouches only for its own accounts', () => {
  it('refuses an actor the instance publishes on another host', async () => {
    const user = await newUser();
    const done = await callback(await authorizeAt(user, `liar-${randomUUID().slice(0, 8)}.example`, 'nate'));
    expect(done.location).toBe(`${RETURN_TO}?link_error=verification_failed`);
    expect((await call('GET', '/', { user })).body.data.linkedAccounts).toHaveLength(0);
  });
});

describe('start — input and returnTo validation', () => {
  it('refuses a returnTo that is not registered on a trusted client (no prefix matching)', async () => {
    const user = await newUser();
    for (const returnTo of ['https://evil.example/linked', 'https://move.oxy.test/linked/../steal', 'https://move.oxy.test/linkedx']) {
      const res = await call('POST', '/activitypub/start', { user, body: { instance: 'mastodon.example', clientId: client, returnTo } });
      expect(res.status).toBe(400);
    }
    for (const body of [
      { instance: 'mastodon.example' },
      { instance: 'mastodon.example', returnTo: RETURN_TO },
      { instance: 'mastodon.example', clientId: 'oxy_dk_nope', returnTo: RETURN_TO },
      // A self-registered app may not receive link codes, even at its own URI.
      { instance: 'mastodon.example', clientId: await registeredClient(['https://attacker.example/linked'], 'third_party'), returnTo: 'https://attacker.example/linked' },
    ]) {
      expect((await call('POST', '/activitypub/start', { user, body })).status).toBe(400);
    }
  });

  it('refuses private, malformed and IP-literal instances before contacting them', async () => {
    const user = await newUser();
    for (const instanceName of ['localhost', '127.0.0.1', 'http://mastodon.example', 'mastodon.example:8443', 'https://u:p@mastodon.example']) {
      const res = await call('POST', '/activitypub/start', { user, body: { instance: instanceName, clientId: client, returnTo: RETURN_TO } });
      expect(res.status).toBe(400);
      expect(res.body.details).toEqual({ reason: 'instance_invalid' });
    }
    const unreachable = await call('POST', '/activitypub/start', { user, body: { instance: 'intranet.example', clientId: client, returnTo: RETURN_TO } });
    expect(unreachable.status).toBe(400);
    expect(unreachable.body.details).toEqual({ reason: 'instance_unreachable' });
    expect(instances.has('intranet.example')).toBe(false);
  });

  it('tells a server that refuses Oxy from one that is down, and warns about both', async () => {
    const user = await newUser();
    const refused = await call('POST', '/activitypub/start', { user, body: { instance: `notmastodon-${randomUUID().slice(0, 8)}.example`, clientId: client, returnTo: RETURN_TO } });
    expect(refused.status).toBe(400);
    expect(refused.body.details).toEqual({ reason: 'provider_rejected' });
    const down = await call('POST', '/activitypub/start', { user, body: { instance: `down-${randomUUID().slice(0, 8)}.example`, clientId: client, returnTo: RETURN_TO } });
    expect(down.status).toBe(400);
    expect(down.body.details).toEqual({ reason: 'provider_unavailable' });
    expect(jest.mocked(logger.warn)).toHaveBeenCalledWith('[LinkedAccounts] Mastodon app registration refused', expect.objectContaining({ status: 404 }));
  });

  it('a refusal the client caused carries no reason to show the user', async () => {
    const res = await call('POST', '/activitypub/start', { user: await newUser(), body: { instance: 'mastodon.example', clientId: client, returnTo: 'https://evil.example/linked' } });
    expect(res.status).toBe(400);
    expect(res.body.details).toBeUndefined();
  });

  it('requires a session', async () => {
    expect((await call('POST', '/activitypub/start', { body: { instance: 'mastodon.example', clientId: client, returnTo: RETURN_TO } })).status).toBe(401);
    expect((await call('POST', '/complete', { body: { code: 'x' } })).status).toBe(401);
    expect((await call('GET', '/')).status).toBe(401);
  });

  it('rejects an unknown network', async () => {
    expect((await call('POST', '/twitter/start', { user: await newUser(), body: {} })).status).toBe(400);
  });
});

describe('revoke', () => {
  it('revokes only the caller\'s own live link, and drops the alias', async () => {
    const user = await newUser();
    const host = `rev-${randomUUID().slice(0, 8)}.example`;
    const { linkedAccount: link } = (await linkVia(user, host, 'hal')).body.data;

    expect((await call('DELETE', `/${link.id}`, { user: await newUser() })).status).toBe(404);
    expect((await call('DELETE', `/${link.id}`, { user })).status).toBe(204);
    expect((await call('DELETE', `/${link.id}`, { user })).status).toBe(404);
    expect(await aliasesForUser(user)).toEqual([]);

    // The account is free for someone else now.
    expect((await linkVia(await newUser(), host, 'hal')).status).toBe(200);
  });
});

describe('service read — GET /by-user/:userId', () => {
  it('requires linked-accounts:read', async () => {
    const user = await newUser();
    expect((await call('GET', `/by-user/${user}`)).status).toBe(401);
    expect((await call('GET', `/by-user/${user}`, { scopes: 'files:write,federation:write' })).status).toBe(403);
    const ok = await call('GET', `/by-user/${user}`, { scopes: 'linked-accounts:read' });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ userId: user, linkedAccounts: [] });
  });

  it('returns live links with the federated shadow user, when Oxy has none: null', async () => {
    const user = await newUser();
    const host = `svc-${randomUUID().slice(0, 8)}.example`;
    await linkVia(user, host, 'ivy');
    const ok = await call('GET', `/by-user/${user}`, { scopes: 'linked-accounts:read' });
    expect(ok.body.data.linkedAccounts).toEqual([
      expect.objectContaining({ accountKey: `ivy@${host}`, federatedUserId: null }),
    ]);
  });
});

describe('atproto', () => {
  it('serves the public-client metadata document at its client_id URL', async () => {
    const res = await call('GET', '/atproto/client-metadata.json');
    expect(res.body).toMatchObject({
      client_id: 'https://api.oxy.test/linked-accounts/atproto/client-metadata.json',
      redirect_uris: ['https://api.oxy.test/linked-accounts/atproto/callback'],
      scope: 'atproto',
      token_endpoint_auth_method: 'none',
      dpop_bound_access_tokens: true,
    });
    // Bluesky's authorization server refuses a document whose client_uri is
    // on another origin than its client_id (invalid_client_metadata).
    expect(new URL(res.body.client_uri).origin).toBe(new URL(res.body.client_id).origin);
  });

  it('verifies the DID, signs the session out, keeps none of it, and links on complete', async () => {
    const user = await newUser();
    const started = await call('POST', '/atproto/start', { user, body: { handle: '@alice.bsky.social', clientId: client, returnTo: 'oxymove://linked' } });
    expect(started.status).toBe(200);
    const state = new URL(started.body.data.authorizeUrl).searchParams.get('state') ?? '';

    const done = await call('GET', `/atproto/callback?state=${encodeURIComponent(state)}&code=abc&iss=https%3A%2F%2Fbsky.social`);
    expect(done.location).toMatch(/^oxymove:\/\/linked\?link_code=/);
    expect(signedOut).toContain(atprotoDid);
    expect(atprotoSessionsInFlight.size).toBe(0);

    const completed = await complete(user, linkCode(done));
    expect(completed.status).toBe(200);
    expect(completed.body.data.linkedAccount).toMatchObject({
      network: 'atproto', accountKey: atprotoDid, actorUri: atprotoDid, handle: 'alice.bsky.social', host: 'pds.example',
    });

    // The library's per-flow secrets are wiped from the spent row.
    const rows = await getDb()
      .select({ providerState: linkedAccountOauthChallenges.providerState })
      .from(linkedAccountOauthChallenges)
      .where(eq(linkedAccountOauthChallenges.userId, user));
    expect(rows).toEqual([{ providerState: null }]);

    // A replay finds nothing to spend.
    const replay = await call('GET', `/atproto/callback?state=${encodeURIComponent(state)}&code=abc`);
    expect(replay.status).toBe(400);

    // atproto links are never ActivityPub aliases.
    expect(await aliasesForUser(user)).toEqual([]);
  });

  describe('a refused start says why — a typo, or the provider refusing Oxy', () => {
    afterEach(() => setAtprotoClientForTesting(fakeAtproto));

    /** The double, with `authorize` or the identity resolver replaced. */
    function withFailure(failure: { resolve?: unknown; authorize?: unknown }): void {
      setAtprotoClientForTesting({
        ...fakeAtproto,
        async authorize(input, options) {
          if (failure.authorize) throw failure.authorize;
          return fakeAtproto.authorize(input, options);
        },
        oauthResolver: {
          identityResolver: {
            async resolve(identifier) {
              if (failure.resolve) throw failure.resolve;
              return fakeAtproto.oauthResolver.identityResolver.resolve(identifier);
            },
          },
        },
      });
    }

    async function startFor(user: string): Promise<Result> {
      return call('POST', '/atproto/start', { user, body: { handle: 'carol.bsky.social', clientId: client, returnTo: RETURN_TO } });
    }

    async function openChallenges(user: string): Promise<number> {
      const rows = await getDb().select({ id: linkedAccountOauthChallenges.id }).from(linkedAccountOauthChallenges).where(eq(linkedAccountOauthChallenges.userId, user));
      return rows.length;
    }

    it('an unresolvable handle is handle_unresolvable, before any challenge exists', async () => {
      const { OAuthResolverError } = await loadAtprotoOAuthModule();
      withFailure({ resolve: new OAuthResolverError('Failed to resolve identity: carol.bsky.social') });
      const user = await newUser();
      const res = await startFor(user);
      expect(res.status).toBe(400);
      expect(res.body.details).toEqual({ reason: 'handle_unresolvable' });
      expect(await openChallenges(user)).toBe(0);
    });

    it('invalid_client_metadata from the authorization server is provider_rejected, logged at warn', async () => {
      const { OAuthResponseError } = await loadAtprotoOAuthModule();
      withFailure({ authorize: new OAuthResponseError({ status: 400 } as never, { error: 'invalid_client_metadata' }) });
      const user = await newUser();
      const res = await startFor(user);
      expect(res.status).toBe(400);
      expect(res.body.details).toEqual({ reason: 'provider_rejected' });
      expect(jest.mocked(logger.warn)).toHaveBeenCalledWith(
        '[LinkedAccounts] atproto authorization server did not start the flow',
        expect.objectContaining({ reason: 'provider_rejected', oauthError: 'invalid_client_metadata', status: 400 }),
      );
      expect(await openChallenges(user)).toBe(0);
    });

    it('a failing authorization server or unreadable metadata is provider_unavailable', async () => {
      const { OAuthResponseError, OAuthResolverError } = await loadAtprotoOAuthModule();
      for (const failure of [
        new OAuthResponseError({ status: 503 } as never, { error: 'server_error' }),
        new OAuthResolverError('Failed to resolve OAuth server metadata for resource: https://pds.example'),
        new TypeError('fetch failed'),
      ]) {
        withFailure({ authorize: failure });
        const res = await startFor(await newUser());
        expect(res.status).toBe(400);
        expect(res.body.details).toEqual({ reason: 'provider_unavailable' });
      }
    });
  });

  it('returns a denied authorization to the registered returnTo', async () => {
    const user = await newUser();
    const started = await call('POST', '/atproto/start', { user, body: { handle: 'bob.bsky.social', clientId: client, returnTo: RETURN_TO } });
    const state = new URL(started.body.data.authorizeUrl).searchParams.get('state') ?? '';
    const done = await call('GET', `/atproto/callback?state=${encodeURIComponent(state)}&error=access_denied`);
    expect(done.location).toBe(`${RETURN_TO}?link_error=access_denied`);
  });
});
