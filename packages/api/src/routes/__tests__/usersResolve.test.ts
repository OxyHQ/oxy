/**
 * Oxy external identity boundaries against real PostgreSQL. Only remote HTTP,
 * service credentials, and avatar transfer are mocked. Actor documents control
 * identity; caller fields cannot impersonate authors. Both public discovery and
 * connector requests converge on the same registry and public DTO.
 */

import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';


const mockSafeFetch = jest.fn();

class FakeSsrfRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfRejection';
  }
}

jest.mock('@oxy.so/core/server', () => ({
  __esModule: true,
  safeFetch: (...args: unknown[]) => mockSafeFetch(...args),
  SsrfRejection: FakeSsrfRejection,
}));

/** The scopes the mocked service-auth middleware grants. */
let currentScopes: string[] = ['federation:write'];

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
  serviceAuthMiddleware: (
    req: { serviceApp?: { type: string; appId: string; appName: string; scopes: string[] } },
    _res: unknown,
    next: () => void,
  ) => {
    req.serviceApp = {
      type: 'service',
      appId: 'app-1',
      appName: 'fed-svc',
      scopes: currentScopes,
    };
    next();
  },
}));
jest.mock('../../middleware/optionalAuth', () => ({
  optionalUserOrServiceAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveViewerId: (): string | undefined => undefined,
}));
jest.mock('../../middleware/rateLimiter', () => ({
  rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
// Peripheral modules the users router imports for OTHER endpoints. Stubbed so
// mounting it does not open an S3 client or the signed-export model graph;
// none of them is on the `/resolve` path.
jest.mock('../../services/email.service', () => ({
  emailService: { deleteAllUserData: jest.fn() },
}));
jest.mock('../../services/assetServiceSingleton', () => ({
  assetService: { ensureOwnedAssetPublic: jest.fn().mockResolvedValue(undefined) },
  s3Service: {},
}));
jest.mock('../../services/identityExport.service', () => ({
  buildExportBundle: jest.fn(),
}));
jest.mock('../../services/signature.service', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../config/postgres';
import { users } from '../../db/schema/users';
import { errorHandler } from '../../middleware/errorHandler';
import { federationService } from '../../services/federation.service';
import userCache from '../../utils/userCache';
import usersRouter from '../users';
import federationRouter from '../federation';
import profilesRouter from '../profiles';
import { registerExternalIdentity } from '../../services/externalIdentityRegistry.service';
import { externalIdentities, externalIdentityActors } from '../../db/schema/externalIdentities';

interface JsonResponse {
  status: number;
  raw: string;
  body: { error?: string; message?: string; data?: Record<string, unknown> };
}

let server: http.Server;
let scheduleAvatarRefreshSpy: jest.SpyInstance;
let invalidateSpy: jest.SpyInstance;

function resolveUser(payload: unknown, path = '/users/resolve'): Promise<JsonResponse> {
  const address = server.address() as AddressInfo;
  const body = JSON.stringify(payload ?? {});
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        method: path === '/users/resolve' ? 'PUT' : 'POST',
        host: '127.0.0.1',
        port: address.port,
        path,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            raw,
            body: raw.length > 0 ? JSON.parse(raw) : {},
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** A `safeFetch` result carrying a WebFinger JRD body. */
function webFingerResult(status: number, body: unknown) {
  const buffer = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const response = Readable.from([buffer]) as Readable & { destroy: jest.Mock };
  response.destroy = jest.fn();
  return {
    status,
    headers: { 'content-type': 'application/jrd+json' },
    finalUrl: 'https://example.com/.well-known/webfinger',
    response,
  };
}

function token(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

async function account(fields: Partial<typeof users.$inferInsert> = {}): Promise<string> {
  const [row] = await getDb().insert(users).values(fields).returning({ id: users.id });
  return row.id;
}

async function storedByActorUri(actorUri: string) {
  const [row] = await getDb()
    .select({
      id: users.id,
      username: users.username,
      type: users.type,
      nameFirst: users.nameFirst,
      bio: users.bio,
      avatar: users.avatar,
      federationActorUri: users.federationActorUri,
      federationDomain: users.federationDomain,
      federationLastResolvedAt: users.federationLastResolvedAt,
      federationUnavailableAt: users.federationUnavailableAt,
      federationUnavailableReason: users.federationUnavailableReason,
    })
    .from(users)
    .where(eq(users.federationActorUri, actorUri))
    .limit(1);
  return row;
}

beforeAll(async () => {
  await connectPostgres();
  const app = express();
  app.use(express.json());
  app.use('/users', usersRouter);
  app.use('/federation', federationRouter);
  app.use('/profiles', profilesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closePostgres();
});

beforeEach(() => {
  currentScopes = ['federation:write'];
  mockSafeFetch.mockReset();
  mockSafeFetch.mockResolvedValue(webFingerResult(404, '{}'));
  scheduleAvatarRefreshSpy = jest
    .spyOn(federationService, 'scheduleAvatarRefresh')
    .mockImplementation(() => undefined);
  invalidateSpy = jest.spyOn(userCache, 'invalidate');
});

afterEach(() => {
  jest.restoreAllMocks();
});

function publishedActor(uri: string, overrides: Record<string, unknown> = {}) {
  const local = new URL(uri).pathname.split('/').pop();
  if (!local) throw new Error('Actor fixture requires username path');
  return { id: uri, type: 'Person', preferredUsername: local, name: 'Remote Author',
    inbox: `${uri}/inbox`, summary: 'Source biography', ...overrides };
}

function serveActor(uri: string, overrides: Record<string, unknown> = {}) {
  mockSafeFetch.mockImplementation(async (url: string) => url === uri
    ? webFingerResult(200, publishedActor(uri, overrides)) : webFingerResult(404, {}));
}

describe('PUT /users/resolve — Oxy identity authority', () => {
  it('canonicalizes an unverified migrated bridge row before a public profile response', async () => {
    const handle = `migrated${token()}`;
    const uri = `https://bird.makeup/users/${handle}`;
    const id = await account({ type: 'federated', username: `${handle}@bird.makeup`, federationActorUri: uri, federationDomain: 'bird.makeup', bio: 'Old transport bio' });
    await getDb().insert(externalIdentities).values({ canonicalAcct: `${handle}@bird.makeup`, userId: id, network: 'bird.makeup' });
    await getDb().insert(externalIdentityActors).values({ actorUri: uri, canonicalAcct: `${handle}@bird.makeup`, transportAcct: `${handle}@bird.makeup`, protocol: 'activitypub', updatedAt: new Date(0) });
    serveActor(uri, { attachment: [{ name: 'Official', value: `<a href="https://https://twitter.com/${handle}" rel="me">Official</a>` }] });
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/profiles/resolve?handle=${encodeURIComponent(`${handle}@bird.makeup`)}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { data: { id: string; username: string; bio: string } };
    expect(body.data).toMatchObject({ id, username: `${handle}@x.com`, bio: 'Source biography' });
    expect((await storedByActorUri(uri)).username).toBe(`${handle}@x.com`);
  });

  it('refuses user-id-only retirement when another source actor remains', async () => {
    const handle = `multiple${token()}`;
    const first = await registerExternalIdentity({ canonicalAcct: `${handle}@x.com`, actorUri: `https://bird.makeup/users/${handle}`,
      transportAcct: `${handle}@bird.makeup`, protocol: 'activitypub', profile: { displayName: 'Author', bio: 'Bio' } });
    await registerExternalIdentity({ canonicalAcct: `${handle}@x.com`, actorUri: `https://mastox.eu/users/${handle}`,
      transportAcct: `${handle}@mastox.eu`, protocol: 'activitypub', profile: { displayName: 'Author', bio: 'Bio' } });
    expect((await resolveUser({ oxyUserId: first.userId }, '/federation/actor-gone')).status).toBe(409);
    expect((await resolveUser({ oxyUserId: first.userId }, '/federation/actor-delete')).status).toBe(409);
    const [row] = await getDb().select().from(users).where(eq(users.id, first.userId));
    expect(row.accountStatus).toBe('active');
  });
  it('resolves handle URLs through Oxy and exposes a coherent source lookup', async () => {
    const handle = `bird${token()}`;
    const uri = `https://bird.makeup/users/${handle}`;
    mockSafeFetch.mockImplementation(async (url: string) => url === uri
      ? webFingerResult(200, publishedActor(uri, { attachment: [{ name: 'Official', value: `<a href="https://https://twitter.com/${handle}" rel="me">Official</a>` }] }))
      : url.startsWith('https://bird.makeup/.well-known/webfinger?')
        ? webFingerResult(200, { subject: `acct:${handle}@bird.makeup`, links: [{ rel: 'self', type: 'application/activity+json', href: uri }] })
        : webFingerResult(404, {}));
    const resolved = await resolveUser({ handle: `https://x.com/${handle}` }, '/federation/identities/resolve');
    expect(resolved.status).toBe(200);
    expect(resolved.body.data?.externalIdentity).toMatchObject({ actorUri: uri, canonicalAcct: `${handle}@x.com`, sourceUserId: expect.any(String), userId: expect.any(String) });
    const lookup = await resolveUser({ identifiers: [uri, `${handle}@x.com`, `${handle}@bird.makeup`] }, '/federation/identities/lookup');
    expect(lookup.status).toBe(200);
    const mappings = lookup.body.data?.identities as Array<{ userId: string }>;
    expect(mappings).toHaveLength(3);
    expect(new Set(mappings.map(mapping => mapping.userId)).size).toBe(1);
  });

  it('refuses ambiguous resolve input before fetching', async () => {
    expect((await resolveUser({ actorUri: 'https://example.com/a', handle: 'a@example.com' }, '/federation/identities/resolve')).status).toBe(400);
    expect(mockSafeFetch).not.toHaveBeenCalled();
  });
  it('requires federation:write before any fetch or write', async () => {
    currentScopes = [];
    const uri = `https://social.example/users/${token()}`;
    const response = await resolveUser({ type: 'federated', actorUri: uri });
    expect(response.status).toBe(403);
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(await storedByActorUri(uri)).toBeUndefined();
  });

  it('rejects unsupported types and missing actor references', async () => {
    expect((await resolveUser({ type: 'local', username: token() })).status).toBe(400);
    expect((await resolveUser({ type: 'federated' })).status).toBe(400);
  });

  it('does not mint an own-domain shadow even when the caller labels it external', async () => {
    const uri = `https://oxy.so/users/${token()}`;
    serveActor(uri);
    expect((await resolveUser({ type: 'federated', actorUri: uri })).status).toBe(400);
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(await storedByActorUri(uri)).toBeUndefined();
  });

  it('never repurposes a non-federated account that holds the actor URI', async () => {
    const uri = `https://social.example/users/${token()}`;
    const id = await account({ type: 'agent', federationActorUri: uri, username: `protected${token()}` });
    serveActor(uri);
    const response = await resolveUser({ type: 'federated', actorUri: uri });
    expect(response.status).toBe(409);
    expect(await storedByActorUri(uri)).toMatchObject({ id, type: 'agent' });
  });

  it.each(['refresh', 'forceAvatarRefresh'])('honors %s using only the source-owned avatar URL', async flag => {
    const uri = `https://social.example/users/${token()}`;
    const id = await account({ type: 'federated', federationActorUri: uri, username: `${uri.split('/').pop()}@social.example`, avatar: 'existing-file' });
    const sourceAvatar = 'https://social.example/avatars/source.png';
    serveActor(uri, { icon: { type: 'Image', url: sourceAvatar } });
    const response = await resolveUser({ type: 'federated', actorUri: uri, [flag]: true, avatar: 'https://evil.example/forged.png' });
    expect(response.status).toBe(200);
    expect(scheduleAvatarRefreshSpy).toHaveBeenCalledWith(id, sourceAvatar, 'existing-file', { force: true });
  });

  it('refetches actor identity and ignores forged caller fields, even on the same host', async () => {
    const uri = `https://social.example/users/bob${token()}`;
    serveActor(uri);
    const response = await resolveUser({ type: 'federated', actorUri: uri, username: 'alice@social.example',
      domain: 'social.example', displayName: 'Forged Name', bio: 'Forged biography', avatar: 'private-file-id' });
    expect(response.status).toBe(200);
    const row = await storedByActorUri(uri);
    expect(row.username).toBe(`${uri.split('/').pop()}@social.example`);
    expect(row.nameFirst).toBe('Remote Author');
    expect(row.bio).toBe('Source biography');
    expect(row.avatar).toBeNull();
    expect(mockSafeFetch).toHaveBeenCalledWith(uri, expect.objectContaining({ headers: expect.objectContaining({ Signature: expect.any(String) }) }));
  });

  it('canonicalizes cold BirdsiteLive discovery and returns the same user to public discovery', async () => {
    const handle = `jordievole${token()}`;
    const uri = `https://bird.makeup/users/${handle}`;
    const summary = "Uno @delbarriotv@bird.makeup y de @lodeevole@bird.makeup\nThis account is a replica from Twitter. Its author can't see your replies. If you find this service useful, please consider supporting us via our Patreon.";
    serveActor(uri, { type: 'Service', summary, attachment: [{ name: 'Official', value: `<a href="https://twitter.com/${handle}" rel="me">Official</a>` }] });
    const response = await resolveUser({ type: 'federated', actorUri: uri, username: `${handle}@bird.makeup` });
    expect(response.status).toBe(200);
    const row = await storedByActorUri(uri);
    expect(row.username).toBe(`${handle}@x.com`);
    expect(row.bio).toBe('Uno @delbarriotv@x.com y de @lodeevole@x.com');
    const direct = await federationService.resolveAndUpsert(`${handle}@bird.makeup`);
    expect(direct?._id).toBe(row.id);
    expect(response.body.data).toMatchObject({ id: row.id, username: row.username,
      externalIdentities: expect.arrayContaining([expect.objectContaining({ actorUri: uri, canonicalAcct: row.username, sourceUserId: row.id })]) });
  });

  it('canonicalizes a verified Instagram mirror while keeping unproven Threads equivalence separate', async () => {
    const handle = `zuck${token()}`;
    const uri = `https://kilogram.makeup/users/${handle}`;
    serveActor(uri, { attachment: [{ name: 'Official', value: `<a href="https://www.instagram.com/${handle}" rel="me">Official</a>` },
      { name: 'Threads', value: `<a href="https://threads.net/@${handle}" rel="me">Threads</a>` }] });
    const response = await resolveUser({ type: 'federated', actorUri: uri });
    expect(response.status).toBe(200);
    expect(response.body.data?.username).toBe(`${handle}@instagram.com`);
    expect(response.body.data?.externalIdentities).toHaveLength(1);
  });

  it('leaves bridge administrator identities on their transport domain', async () => {
    const handle = `admin${token()}`;
    const uri = `https://bird.makeup/users/${handle}`;
    serveActor(uri);
    expect((await resolveUser({ type: 'federated', actorUri: uri, username: `${handle}@x.com` })).status).toBe(200);
    expect((await storedByActorUri(uri)).username).toBe(`${handle}@bird.makeup`);
  });

  it('rejects a mismatched actor id and writes no impersonated identity', async () => {
    const uri = `https://evil.example/users/${token()}`;
    serveActor(uri, { id: 'https://victim.example/users/alice' });
    expect((await resolveUser({ type: 'federated', actorUri: uri })).status).toBe(400);
    expect(await storedByActorUri(uri)).toBeUndefined();
  });

  it('fails closed when the SSRF-safe fetch refuses a target', async () => {
    mockSafeFetch.mockRejectedValue(new FakeSsrfRejection('private target'));
    expect((await resolveUser({ type: 'federated', actorUri: 'https://127.0.0.1/users/alice' })).status).toBe(400);
  });

  it('verifies a split-host WebFinger identity against its account host', async () => {
    const local = token();
    const uri = `https://actors.example/users/${local}`;
    const handle = `${local}@accounts.example`;
    mockSafeFetch.mockImplementation(async (url: string) => url === uri ? webFingerResult(200, publishedActor(uri))
      : url.startsWith('https://accounts.example/.well-known/webfinger?') ? webFingerResult(200, { subject: `acct:${handle}`, links: [{ rel: 'self', type: 'application/activity+json', href: uri }] })
        : webFingerResult(404, {}));
    const response = await resolveUser({ type: 'federated', actorUri: uri, username: handle });
    expect(response.status).toBe(200);
    expect((await storedByActorUri(uri)).username).toBe(handle);
  });

  it('verifies atproto DID and derives its handle from the appview response', async () => {
    const did = `did:plc:${token()}`;
    mockSafeFetch.mockImplementation(async () => webFingerResult(200, { did, handle: 'alice.bsky.social', displayName: 'Alice', description: 'Real biography' }));
    const response = await resolveUser({ type: 'federated', actorUri: did, username: 'victim@bsky.social', bio: 'Fake' });
    expect(response.status).toBe(200);
    expect(response.body.data?.username).toBe('alice@bsky.social');
    expect(response.body.data?.bio).toBe('Real biography');
  });

  it('rejects an appview response for a different DID', async () => {
    mockSafeFetch.mockResolvedValue(webFingerResult(200, { did: 'did:plc:other', handle: 'alice.bsky.social' }));
    expect((await resolveUser({ type: 'federated', actorUri: `did:plc:${token()}` })).status).toBe(400);
  });

  it('repairs legacy bridge rows without changing their stable Oxy id', async () => {
    const handle = `legacy${token()}`;
    const uri = `https://bird.makeup/users/${handle}`;
    const id = await account({ type: 'federated', username: `${handle}@bird.makeup`, federationActorUri: uri,
      federationDomain: 'bird.makeup', federationUnavailableAt: new Date(), federationUnavailableReason: 'gone' });
    serveActor(uri, { attachment: [{ name: 'Official', value: `<a href="https://x.com/${handle}" rel="me">Official</a>` }] });
    expect((await resolveUser({ type: 'federated', actorUri: uri })).status).toBe(200);
    expect(await storedByActorUri(uri)).toMatchObject({ id, username: `${handle}@x.com`, federationUnavailableAt: null, federationUnavailableReason: null });
    expect(invalidateSpy).toHaveBeenCalledWith(id);
  });

  it('keeps existing automation collision and owner guards', async () => {
    const username = `local${token()}`;
    const id = await account({ username });
    expect((await resolveUser({ type: 'agent', username })).status).toBe(409);
    expect((await resolveUser({ type: 'agent', username: `agent${token()}`, ownerId: 'invalid' })).status).toBe(400);
    const agent = await resolveUser({ type: 'agent', username: `agent${token()}`, ownerId: id });
    expect(agent.status).toBe(200);
  });

  it('normalizes source display names and strips markup from source biographies', async () => {
    const uri = `https://social.example/users/${token()}`;
    serveActor(uri, { name: 'Alice 🚀', summary: '<b>Real biography</b><script>ignored()</script>' });
    expect((await resolveUser({ type: 'federated', actorUri: uri })).status).toBe(200);
    const row = await storedByActorUri(uri);
    expect(row.nameFirst).toBe('Alice');
    expect(row.bio).not.toMatch(/<[^>]*>/);
  });
});
