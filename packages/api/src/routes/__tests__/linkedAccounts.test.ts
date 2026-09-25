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
 *  - start → callback links the account the INSTANCE names, and the token is
 *    revoked at the instance and never stored (no column exists for it);
 *  - a replayed or expired state is refused without redirecting anywhere;
 *  - a second Oxy user claiming a live account gets `already_linked` (409);
 *  - `returnTo` must be a redirect URI registered on the calling app;
 *  - a private instance is refused before any request is made to it;
 *  - the service read requires `linked-accounts:read`;
 *  - aliases follow live, alias-enabled ActivityPub links.
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
jest.mock('../../services/linkedAccounts/atprotoClientLoader', () => ({
  loadAtprotoOAuthModule: () => Promise.reject(new Error('the real atproto client is not loaded in tests')),
}));

import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { applicationCredentials } from '../../db/schema/applicationCredentials';
import { applications } from '../../db/schema/applications';
import { linkedAccountOauthChallenges, mastodonAppRegistrations, userLinkedAccounts } from '../../db/schema/userLinkedAccounts';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import userCache from '../../utils/userCache';
import { setLinkedAccountTransportForTesting, UnsafeHostError } from '../../services/linkedAccounts/http';
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
      server.registrations += 1;
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
      return json({
        subject: `acct:${username}@${server.host}`,
        links: [{ rel: 'self', type: 'application/activity+json', href: `https://${server.host}/users/${username}` }],
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

async function registeredClient(redirectUris: string[]): Promise<string> {
  const owner = await newUser();
  const [app] = await getDb()
    .insert(applications)
    .values({ name: `Move ${randomUUID()}`, ownerAccountId: owner, type: 'first_party', redirectUris })
    .returning({ id: applications.id });
  const publicKey = `oxy_dk_${randomUUID().replace(/-/g, '')}`;
  await getDb()
    .insert(applicationCredentials)
    .values({ applicationId: app.id, name: 'web', publicKey, type: 'public', environment: 'production' });
  return publicKey;
}

/** Start a Mastodon link, then have the fake instance approve it for `username`. */
async function authorizeAt(user: string, host: string, username: string, extra: Record<string, unknown> = {}) {
  const started = await call('POST', '/activitypub/start', { user, body: { instance: host, ...extra } });
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

beforeAll(async () => {
  await connectPostgres();
  restoreTransport = setLinkedAccountTransportForTesting({
    fetch: fakeFetch,
    async assertPublicHost(host) {
      if (privateHosts.has(host)) throw new UnsafeHostError('private address');
    },
  });
  setAtprotoClientForTesting(fakeAtproto);
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

describe('Mastodon-API: start → callback', () => {
  it('links the account the instance names, revokes the token, and stores none', async () => {
    const user = await newUser();
    const host = `social-${randomUUID().slice(0, 8)}.example`;
    const { authorizeUrl, state, code } = await authorizeAt(user, `@alice@${host}`, 'alice');

    expect(authorizeUrl.hostname).toBe(host);
    expect(authorizeUrl.pathname).toBe('/oauth/authorize');
    expect(authorizeUrl.searchParams.get('scope')).toBe('read:accounts');
    expect(authorizeUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizeUrl.searchParams.get('redirect_uri')).toBe('https://api.oxy.test/linked-accounts/activitypub/callback');

    const done = await call('GET', `/activitypub/callback?state=${encodeURIComponent(state)}&code=${code}`);
    expect(done.status).toBe(200);
    expect(done.text).toContain('Account linked');

    const links = await call('GET', '/', { user });
    expect(links.body.data.linkedAccounts).toEqual([
      expect.objectContaining({
        network: 'activitypub',
        accountKey: `alice@${host}`,
        actorUri: `https://${host}/users/alice`,
        handle: `@alice@${host}`,
        host,
        proofMethod: 'oauth',
        useAsAlias: true,
      }),
    ]);

    // The one token the instance issued was revoked there.
    const fake = instance(host);
    expect(fake.revoked).toHaveLength(1);
    expect(fake.tokens.size).toBe(0);
    // …and the challenge's secret is gone.
    const [spent] = await getDb()
      .select({ usedAt: linkedAccountOauthChallenges.usedAt, pkceVerifier: linkedAccountOauthChallenges.pkceVerifier })
      .from(linkedAccountOauthChallenges)
      .where(eq(linkedAccountOauthChallenges.userId, user));
    expect(spent.usedAt).not.toBeNull();
    expect(spent.pkceVerifier).toBeNull();

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

  it('refuses a replayed state without redirecting anywhere', async () => {
    const user = await newUser();
    const client = await registeredClient(['https://move.oxy.test/linked']);
    const host = `replay-${randomUUID().slice(0, 8)}.example`;
    const { state, code } = await authorizeAt(user, host, 'bob', { clientId: client, returnTo: 'https://move.oxy.test/linked' });
    const first = await call('GET', `/activitypub/callback?state=${encodeURIComponent(state)}&code=${code}`);
    expect(first.status).toBe(303);
    const second = await call('GET', `/activitypub/callback?state=${encodeURIComponent(state)}&code=${code}`);
    expect(second.status).toBe(400);
    expect(second.location).toBeNull();
    expect(second.text).toContain('expired or was already used');
  });

  it('refuses an expired state', async () => {
    const user = await newUser();
    const host = `expired-${randomUUID().slice(0, 8)}.example`;
    const { state, code } = await authorizeAt(user, host, 'carol');
    await getDb()
      .update(linkedAccountOauthChallenges)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(linkedAccountOauthChallenges.userId, user));
    const done = await call('GET', `/activitypub/callback?state=${encodeURIComponent(state)}&code=${code}`);
    expect(done.status).toBe(400);
    expect(await call('GET', '/', { user })).toMatchObject({ body: { data: { linkedAccounts: [] } } });
  });

  it('refuses a second Oxy user claiming a live account (409 / already_linked)', async () => {
    const host = `claim-${randomUUID().slice(0, 8)}.example`;
    const first = await authorizeAt(await newUser(), host, 'dana');
    expect((await call('GET', `/activitypub/callback?state=${encodeURIComponent(first.state)}&code=${first.code}`)).status).toBe(200);

    const intruder = await newUser();
    const second = await authorizeAt(intruder, host, 'dana');
    const page = await call('GET', `/activitypub/callback?state=${encodeURIComponent(second.state)}&code=${second.code}`);
    expect(page.status).toBe(409);

    const client = await registeredClient(['oxymove://linked']);
    const third = await authorizeAt(intruder, host, 'dana', { clientId: client, returnTo: 'oxymove://linked' });
    const redirect = await call('GET', `/activitypub/callback?state=${encodeURIComponent(third.state)}&code=${third.code}`);
    expect(redirect.status).toBe(303);
    expect(redirect.location).toBe('oxymove://linked?link_error=already_linked');
    expect(await aliasesForUser(intruder)).toEqual([]);
  });

  it('re-linking one\'s own live account refreshes it instead of failing', async () => {
    const user = await newUser();
    const host = `relink-${randomUUID().slice(0, 8)}.example`;
    for (let i = 0; i < 2; i++) {
      const flow = await authorizeAt(user, host, 'erin');
      expect((await call('GET', `/activitypub/callback?state=${encodeURIComponent(flow.state)}&code=${flow.code}`)).status).toBe(200);
    }
    expect((await call('GET', '/', { user })).body.data.linkedAccounts).toHaveLength(1);
  });

  it('sends a cancelled authorization back as access_denied', async () => {
    const user = await newUser();
    const client = await registeredClient(['https://move.oxy.test/linked']);
    const host = `deny-${randomUUID().slice(0, 8)}.example`;
    const { state } = await authorizeAt(user, host, 'finn', { clientId: client, returnTo: 'https://move.oxy.test/linked' });
    const done = await call('GET', `/activitypub/callback?state=${encodeURIComponent(state)}&error=access_denied`);
    expect(done.location).toBe('https://move.oxy.test/linked?link_error=access_denied');
  });
});

describe('start — input and returnTo validation', () => {
  it('redirects a successful link to the registered returnTo with ?linked=', async () => {
    const user = await newUser();
    const client = await registeredClient(['https://move.oxy.test', 'https://move.oxy.test/linked']);
    const host = `rt-${randomUUID().slice(0, 8)}.example`;
    const { state, code } = await authorizeAt(user, host, 'gina', { clientId: client, returnTo: 'https://move.oxy.test/linked' });
    const done = await call('GET', `/activitypub/callback?state=${encodeURIComponent(state)}&code=${code}`);
    expect(done.status).toBe(303);
    const linkedId = new URL(done.location ?? '').searchParams.get('linked');
    const [row] = await getDb().select({ userId: userLinkedAccounts.userId }).from(userLinkedAccounts).where(eq(userLinkedAccounts.id, linkedId ?? ''));
    expect(row.userId).toBe(user);
  });

  it('refuses a returnTo that is not registered on the client (no prefix matching)', async () => {
    const user = await newUser();
    const client = await registeredClient(['https://move.oxy.test/linked']);
    for (const returnTo of ['https://evil.example/linked', 'https://move.oxy.test/linked/../steal', 'https://move.oxy.test/linkedx']) {
      const res = await call('POST', '/activitypub/start', { user, body: { instance: 'mastodon.example', clientId: client, returnTo } });
      expect(res.status).toBe(400);
    }
    const noClient = await call('POST', '/activitypub/start', { user, body: { instance: 'mastodon.example', returnTo: 'https://move.oxy.test/linked' } });
    expect(noClient.status).toBe(400);
    const unknownClient = await call('POST', '/activitypub/start', {
      user,
      body: { instance: 'mastodon.example', clientId: 'oxy_dk_nope', returnTo: 'https://move.oxy.test/linked' },
    });
    expect(unknownClient.status).toBe(400);
  });

  it('refuses private, malformed and IP-literal instances before contacting them', async () => {
    const user = await newUser();
    for (const instanceName of ['intranet.example', 'localhost', '127.0.0.1', 'http://mastodon.example', 'mastodon.example:8443', 'https://u:p@mastodon.example']) {
      const res = await call('POST', '/activitypub/start', { user, body: { instance: instanceName } });
      expect(res.status).toBe(400);
    }
    expect(instances.has('intranet.example')).toBe(false);
  });

  it('requires a session', async () => {
    expect((await call('POST', '/activitypub/start', { body: { instance: 'mastodon.example' } })).status).toBe(401);
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
    const flow = await authorizeAt(user, host, 'hal');
    await call('GET', `/activitypub/callback?state=${encodeURIComponent(flow.state)}&code=${flow.code}`);
    const [link] = (await call('GET', '/', { user })).body.data.linkedAccounts;

    expect((await call('DELETE', `/${link.id}`, { user: await newUser() })).status).toBe(404);
    expect((await call('DELETE', `/${link.id}`, { user })).status).toBe(204);
    expect((await call('DELETE', `/${link.id}`, { user })).status).toBe(404);
    expect(await aliasesForUser(user)).toEqual([]);

    // The account is free for someone else now.
    const other = await newUser();
    const again = await authorizeAt(other, host, 'hal');
    expect((await call('GET', `/activitypub/callback?state=${encodeURIComponent(again.state)}&code=${again.code}`)).status).toBe(200);
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
    const flow = await authorizeAt(user, host, 'ivy');
    await call('GET', `/activitypub/callback?state=${encodeURIComponent(flow.state)}&code=${flow.code}`);
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
  });

  it('links the verified DID, signs the session out and keeps none of it', async () => {
    const user = await newUser();
    const client = await registeredClient(['oxymove://linked']);
    const started = await call('POST', '/atproto/start', { user, body: { handle: '@alice.bsky.social', clientId: client, returnTo: 'oxymove://linked' } });
    expect(started.status).toBe(200);
    const state = new URL(started.body.data.authorizeUrl).searchParams.get('state') ?? '';

    const done = await call('GET', `/atproto/callback?state=${encodeURIComponent(state)}&code=abc&iss=https%3A%2F%2Fbsky.social`);
    expect(done.status).toBe(303);
    expect(done.location).toMatch(/^oxymove:\/\/linked\?linked=/);
    expect(signedOut).toContain(atprotoDid);
    expect(atprotoSessionsInFlight.size).toBe(0);

    const [link] = (await call('GET', '/', { user })).body.data.linkedAccounts;
    expect(link).toMatchObject({ network: 'atproto', accountKey: atprotoDid, actorUri: atprotoDid, handle: 'alice.bsky.social', host: 'pds.example', useAsAlias: false });

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

  it('returns a denied authorization to the registered returnTo', async () => {
    const user = await newUser();
    const client = await registeredClient(['https://move.oxy.test/linked']);
    const started = await call('POST', '/atproto/start', { user, body: { handle: 'bob.bsky.social', clientId: client, returnTo: 'https://move.oxy.test/linked' } });
    const state = new URL(started.body.data.authorizeUrl).searchParams.get('state') ?? '';
    const done = await call('GET', `/atproto/callback?state=${encodeURIComponent(state)}&error=access_denied`);
    expect(done.location).toBe('https://move.oxy.test/linked?link_error=access_denied');
  });
});
