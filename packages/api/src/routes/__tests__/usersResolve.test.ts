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

import { eq, sql } from 'drizzle-orm';
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
  return {
    id: uri,
    type: 'Person',
    preferredUsername: local,
    name: 'Remote Author',
    inbox: `${uri}/inbox`,
    summary: 'Source biography',
    ...overrides,
  };
}

function serveActor(uri: string, overrides: Record<string, unknown> = {}) {
  mockSafeFetch.mockImplementation(async (url: string) =>
    url === uri ? webFingerResult(200, publishedActor(uri, overrides)) : webFingerResult(404, {}),
  );
}

describe('PUT /users/resolve — Oxy identity authority', () => {
  it('keeps another linked source profile and avatar separate from the canonical representative', async () => {
    const handle = `sources${token()}`;
    const uri = `https://threads.net/ap/users/${Date.now()}`;
    const primary = await registerExternalIdentity({
      canonicalAcct: `${handle}@instagram.com`,
      actorUri: `https://instagram.example/actor/${handle}`,
      transportAcct: `${handle}@instagram.example`,
      protocol: 'activitypub',
      stableId: `instagram:test:${handle}`,
      profile: { displayName: 'Instagram source', bio: 'Instagram biography' },
      evidenceLinks: [`https://threads.net/@${handle}`],
    });
    await getDb()
      .update(users)
      .set({ avatar: 'instagram-file' })
      .where(eq(users.id, primary.userId));
    serveActor(uri, {
      preferredUsername: handle,
      name: 'Threads source',
      summary: 'Threads biography',
      alsoKnownAs: [`https://instagram.com/${handle}`],
      icon: { url: 'https://threads.net/avatar.jpg' },
    });
    const resolved = await federationService.resolveExternalActorIdentity(uri);
    expect(resolved?.user.id).toBe(primary.userId);
    expect(resolved?.externalIdentity.sourceUserId).not.toBe(primary.userId);
    expect(scheduleAvatarRefreshSpy).toHaveBeenCalledWith(
      resolved?.externalIdentity.sourceUserId,
      'https://threads.net/avatar.jpg',
      undefined,
      { force: false },
    );
    const [row] = await getDb().select().from(users).where(eq(users.id, primary.userId));
    expect(row.bio).toBe('Instagram biography');
    expect(row.avatar).toBe('instagram-file');
  });

  /** A bridge row exactly as the registry backfill left it: never through first discovery. */
  async function migratedBridgeRow() {
    const handle = `migrated${token()}`;
    const uri = `https://bird.makeup/users/${handle}`;
    const id = await account({
      type: 'federated',
      username: `${handle}@bird.makeup`,
      federationActorUri: uri,
      federationDomain: 'bird.makeup',
      bio: 'Old transport bio',
    });
    await getDb()
      .insert(externalIdentities)
      .values({ canonicalAcct: `${handle}@bird.makeup`, userId: id, network: 'bird.makeup' });
    await getDb()
      .insert(externalIdentityActors)
      .values({
        actorUri: uri,
        canonicalAcct: `${handle}@bird.makeup`,
        transportAcct: `${handle}@bird.makeup`,
        protocol: 'activitypub',
        updatedAt: new Date(0),
      });
    const officialLink = {
      attachment: [
        {
          name: 'Official',
          value: `<a href="https://https://twitter.com/${handle}" rel="me">Official</a>`,
        },
      ],
    };
    return { handle, uri, id, officialLink };
  }

  function getPath(path: string) {
    const address = server.address() as AddressInfo;
    return fetch(`http://127.0.0.1:${address.port}${path}`);
  }

  it('canonicalizes an unverified migrated bridge row off the read path, never serving it first', async () => {
    const { handle, uri, id, officialLink } = await migratedBridgeRow();
    serveActor(uri, officialLink);
    const discovery = jest.spyOn(federationService, 'resolveExternalActorIdentity');
    const path = `/profiles/resolve?handle=${encodeURIComponent(`${handle}@bird.makeup`)}`;

    const first = await getPath(path);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { data: unknown }).data).toBeNull();
    expect(discovery).toHaveBeenCalledTimes(1);
    expect(discovery).toHaveBeenCalledWith(uri);
    await discovery.mock.results[0].value;

    const second = await getPath(path);
    const body = (await second.json()) as { data: { id: string; username: string; bio: string } };
    expect(body.data).toMatchObject({ id, username: `${handle}@x.com`, bio: 'Source biography' });
    expect((await storedByActorUri(uri)).username).toBe(`${handle}@x.com`);
    expect(discovery).toHaveBeenCalledTimes(1);
  });

  it('answers a profile read without waiting on the remote bridge, then serves the canonical profile', async () => {
    const { handle, uri, id, officialLink } = await migratedBridgeRow();
    let release!: () => void;
    const remoteAnswered = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockSafeFetch.mockImplementation(async (url: string) => {
      await remoteAnswered;
      return url === uri
        ? webFingerResult(200, publishedActor(uri, officialLink))
        : webFingerResult(404, {});
    });
    const discovery = jest.spyOn(federationService, 'resolveExternalActorIdentity');

    // The remote has not answered, and the read has.
    const pending = await getPath(`/profiles/username/${handle}@bird.makeup`);
    expect(pending.status).toBe(404);
    expect(discovery).toHaveBeenCalledTimes(1);

    release();
    await discovery.mock.results[0].value;
    const served = await getPath(`/profiles/username/${handle}@x.com`);
    expect(served.status).toBe(200);
    expect(((await served.json()) as { data: unknown }).data).toMatchObject({
      id,
      username: `${handle}@x.com`,
    });
  });

  it('never answers a profile read with the conflict its background canonicalization meets', async () => {
    const { handle, uri, officialLink } = await migratedBridgeRow();
    // The verified source handle already names a LOCAL account, so the registry
    // refuses the bridge row: a ConflictError that used to become this read's 409.
    await account({ type: 'local', username: `${handle}@x.com` });
    serveActor(uri, officialLink);
    const discovery = jest.spyOn(federationService, 'resolveExternalActorIdentity');

    const response = await getPath(`/profiles/username/${handle}@bird.makeup`);
    expect(response.status).toBe(404);
    await expect(discovery.mock.results[0].value).rejects.toThrow(
      'External identity conflicts with local user',
    );
    expect((await storedByActorUri(uri)).username).toBe(`${handle}@bird.makeup`);
  });

  it('refuses user-id-only retirement when another source actor remains', async () => {
    const handle = `multiple${token()}`;
    const first = await registerExternalIdentity({
      canonicalAcct: `${handle}@x.com`,
      actorUri: `https://bird.makeup/users/${handle}`,
      transportAcct: `${handle}@bird.makeup`,
      protocol: 'activitypub',
      profile: { displayName: 'Author', bio: 'Bio' },
    });
    await registerExternalIdentity({
      canonicalAcct: `${handle}@x.com`,
      actorUri: `https://mastox.eu/users/${handle}`,
      transportAcct: `${handle}@mastox.eu`,
      protocol: 'activitypub',
      profile: { displayName: 'Author', bio: 'Bio' },
    });
    expect((await resolveUser({ oxyUserId: first.userId }, '/federation/actor-gone')).status).toBe(
      409,
    );
    expect(
      (await resolveUser({ oxyUserId: first.userId }, '/federation/actor-delete')).status,
    ).toBe(409);
    const [row] = await getDb().select().from(users).where(eq(users.id, first.userId));
    expect(row.accountStatus).toBe('active');
  });
  it('resolves handle URLs through Oxy and exposes a coherent source lookup', async () => {
    const handle = `bird${token()}`;
    const uri = `https://bird.makeup/users/${handle}`;
    mockSafeFetch.mockImplementation(async (url: string) =>
      url === uri
        ? webFingerResult(
            200,
            publishedActor(uri, {
              attachment: [
                {
                  name: 'Official',
                  value: `<a href="https://https://twitter.com/${handle}" rel="me">Official</a>`,
                },
              ],
            }),
          )
        : url.startsWith('https://bird.makeup/.well-known/webfinger?')
          ? webFingerResult(200, {
              subject: `acct:${handle}@bird.makeup`,
              links: [{ rel: 'self', type: 'application/activity+json', href: uri }],
            })
          : webFingerResult(404, {}),
    );
    const resolved = await resolveUser(
      { handle: `https://x.com/${handle}` },
      '/federation/identities/resolve',
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.data?.externalIdentity).toMatchObject({
      actorUri: uri,
      canonicalAcct: `${handle}@x.com`,
      sourceUserId: expect.any(String),
      userId: expect.any(String),
    });
    const lookup = await resolveUser(
      { identifiers: [uri, `${handle}@x.com`, `${handle}@bird.makeup`] },
      '/federation/identities/lookup',
    );
    expect(lookup.status).toBe(200);
    const mappings = lookup.body.data?.identities as Array<{ userId: string }>;
    expect(mappings).toHaveLength(3);
    expect(new Set(mappings.map((mapping) => mapping.userId)).size).toBe(1);
  });

  /**
   * A Mastodon whose accounts live on the bare domain and whose actors live on
   * a subdomain (`@alice@split.example`, actor at `social.split.example`).
   */
  function serveSplitDomainAccount(local: string) {
    const uri = `https://social.split.example/users/${local}`;
    mockSafeFetch.mockImplementation(async (url: string) =>
      url === uri
        ? webFingerResult(200, publishedActor(uri, { webfinger: `${local}@split.example` }))
        : url.startsWith('https://split.example/.well-known/webfinger?')
          ? webFingerResult(200, {
              subject: `acct:${local}@split.example`,
              links: [{ rel: 'self', type: 'application/activity+json', href: uri }],
            })
          : webFingerResult(404, {}),
    );
    return uri;
  }

  it('registers a split-domain account under its verified handle, keyed by its actor-host transport', async () => {
    const local = `split${token()}`;
    const uri = serveSplitDomainAccount(local);
    const resolved = await resolveUser(
      { actorUri: uri, transportAcct: `${local}@split.example`, protocol: 'activitypub' },
      '/federation/identities/resolve',
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.data?.externalIdentity).toMatchObject({
      actorUri: uri,
      canonicalAcct: `${local}@split.example`,
      transportAcct: `${local}@social.split.example`,
    });
  });

  it('converges a split-domain account registered under its actor host instead of refusing every resolve', async () => {
    const local = `split${token()}`;
    const uri = serveSplitDomainAccount(local);
    // As the registry backfill (or a resolve whose WebFinger binding failed)
    // left it: the actor-host handle as both canonical and transport.
    const hostForm = `${local}@social.split.example`;
    const id = await account({
      type: 'federated',
      username: hostForm,
      federationActorUri: uri,
      federationDomain: 'social.split.example',
    });
    await getDb()
      .insert(externalIdentities)
      .values({ canonicalAcct: hostForm, userId: id, network: 'social.split.example' });
    await getDb().insert(externalIdentityActors).values({
      actorUri: uri,
      canonicalAcct: hostForm,
      transportAcct: hostForm,
      protocol: 'activitypub',
    });

    const resolved = await resolveUser(
      { actorUri: uri, transportAcct: `${local}@split.example`, protocol: 'activitypub' },
      '/federation/identities/resolve',
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.data?.externalIdentity).toMatchObject({
      actorUri: uri,
      canonicalAcct: `${local}@split.example`,
      userId: id,
    });
    expect((await storedByActorUri(uri)).username).toBe(`${local}@split.example`);
    const lookup = await resolveUser(
      { identifiers: [`${local}@split.example`, hostForm] },
      '/federation/identities/lookup',
    );
    const mappings = lookup.body.data?.identities as Array<{ userId: string }>;
    expect(mappings.map((mapping) => mapping.userId)).toEqual([id, id]);
  });

  it('refuses ambiguous resolve input before fetching', async () => {
    expect(
      (
        await resolveUser(
          { actorUri: 'https://example.com/a', handle: 'a@example.com' },
          '/federation/identities/resolve',
        )
      ).status,
    ).toBe(400);
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
    const id = await account({
      type: 'agent',
      federationActorUri: uri,
      username: `protected${token()}`,
    });
    serveActor(uri);
    const response = await resolveUser({ type: 'federated', actorUri: uri });
    expect(response.status).toBe(409);
    expect(await storedByActorUri(uri)).toMatchObject({ id, type: 'agent' });
  });

  it.each(['refresh', 'forceAvatarRefresh'])(
    'honors %s using only the source-owned avatar URL',
    async (flag) => {
      const uri = `https://social.example/users/${token()}`;
      const id = await account({
        type: 'federated',
        federationActorUri: uri,
        username: `${uri.split('/').pop()}@social.example`,
        avatar: 'existing-file',
      });
      const sourceAvatar = 'https://social.example/avatars/source.png';
      serveActor(uri, { icon: { type: 'Image', url: sourceAvatar } });
      const response = await resolveUser({
        type: 'federated',
        actorUri: uri,
        [flag]: true,
        avatar: 'https://evil.example/forged.png',
      });
      expect(response.status).toBe(200);
      expect(scheduleAvatarRefreshSpy).toHaveBeenCalledWith(id, sourceAvatar, 'existing-file', {
        force: true,
      });
    },
  );

  it('refetches actor identity and ignores forged caller fields, even on the same host', async () => {
    const uri = `https://social.example/users/bob${token()}`;
    serveActor(uri);
    const response = await resolveUser({
      type: 'federated',
      actorUri: uri,
      username: 'alice@social.example',
      domain: 'social.example',
      displayName: 'Forged Name',
      bio: 'Forged biography',
      avatar: 'private-file-id',
    });
    expect(response.status).toBe(200);
    const row = await storedByActorUri(uri);
    expect(row.username).toBe(`${uri.split('/').pop()}@social.example`);
    expect(row.nameFirst).toBe('Remote Author');
    expect(row.bio).toBe('Source biography');
    expect(row.avatar).toBeNull();
    expect(mockSafeFetch).toHaveBeenCalledWith(
      uri,
      expect.objectContaining({
        headers: expect.objectContaining({ Signature: expect.any(String) }),
      }),
    );
  });

  it('canonicalizes cold BirdsiteLive discovery and returns the same user to public discovery', async () => {
    const handle = `jordievole${token()}`;
    const uri = `https://bird.makeup/users/${handle}`;
    const summary =
      "Uno @delbarriotv@bird.makeup y de @lodeevole@bird.makeup\nThis account is a replica from Twitter. Its author can't see your replies. If you find this service useful, please consider supporting us via our Patreon.";
    serveActor(uri, {
      type: 'Service',
      summary,
      attachment: [
        {
          name: 'Official',
          value: `<a href="https://twitter.com/${handle}" rel="me">Official</a>`,
        },
      ],
    });
    const response = await resolveUser({
      type: 'federated',
      actorUri: uri,
      username: `${handle}@bird.makeup`,
    });
    expect(response.status).toBe(200);
    const row = await storedByActorUri(uri);
    expect(row.username).toBe(`${handle}@x.com`);
    expect(row.bio).toBe('Uno @delbarriotv@x.com y de @lodeevole@x.com');
    const direct = await federationService.resolveAndUpsert(`${handle}@bird.makeup`);
    expect(direct?._id).toBe(row.id);
    expect(response.body.data).toMatchObject({
      id: row.id,
      username: row.username,
      externalIdentities: expect.arrayContaining([
        expect.objectContaining({
          actorUri: uri,
          canonicalAcct: row.username,
          sourceUserId: row.id,
        }),
      ]),
    });
  });

  it('canonicalizes a verified Instagram mirror while keeping unproven Threads equivalence separate', async () => {
    const handle = `zuck${token()}`;
    const uri = `https://kilogram.makeup/users/${handle}`;
    serveActor(uri, {
      attachment: [
        {
          name: 'Official',
          value: `<a href="https://www.instagram.com/${handle}" rel="me">Official</a>`,
        },
        { name: 'Threads', value: `<a href="https://threads.net/@${handle}" rel="me">Threads</a>` },
      ],
    });
    const response = await resolveUser({ type: 'federated', actorUri: uri });
    expect(response.status).toBe(200);
    expect(response.body.data?.username).toBe(`${handle}@instagram.com`);
    expect(response.body.data?.externalIdentities).toHaveLength(1);
  });

  it('leaves bridge administrator identities on their transport domain', async () => {
    const handle = `admin${token()}`;
    const uri = `https://bird.makeup/users/${handle}`;
    serveActor(uri);
    expect(
      (await resolveUser({ type: 'federated', actorUri: uri, username: `${handle}@x.com` })).status,
    ).toBe(200);
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
    expect(
      (await resolveUser({ type: 'federated', actorUri: 'https://127.0.0.1/users/alice' })).status,
    ).toBe(400);
  });

  it('verifies a split-host WebFinger identity against its account host', async () => {
    const local = token();
    const uri = `https://actors.example/users/${local}`;
    const handle = `${local}@accounts.example`;
    mockSafeFetch.mockImplementation(async (url: string) =>
      url === uri
        ? webFingerResult(200, publishedActor(uri))
        : url.startsWith('https://accounts.example/.well-known/webfinger?')
          ? webFingerResult(200, {
              subject: `acct:${handle}`,
              links: [{ rel: 'self', type: 'application/activity+json', href: uri }],
            })
          : webFingerResult(404, {}),
    );
    const response = await resolveUser({ type: 'federated', actorUri: uri, username: handle });
    expect(response.status).toBe(200);
    expect((await storedByActorUri(uri)).username).toBe(handle);
  });

  it('verifies atproto DID and derives its handle from the appview response', async () => {
    const did = `did:plc:${token()}`;
    mockSafeFetch.mockImplementation(async () =>
      webFingerResult(200, {
        did,
        handle: 'alice.bsky.social',
        displayName: 'Alice',
        description: 'Real biography',
      }),
    );
    const response = await resolveUser({
      type: 'federated',
      actorUri: did,
      username: 'victim@bsky.social',
      bio: 'Fake',
    });
    expect(response.status).toBe(200);
    expect(response.body.data?.username).toBe('alice@bsky.social');
    expect(response.body.data?.bio).toBe('Real biography');
  });

  it('rejects an appview response for a different DID', async () => {
    mockSafeFetch.mockResolvedValue(
      webFingerResult(200, { did: 'did:plc:other', handle: 'alice.bsky.social' }),
    );
    expect((await resolveUser({ type: 'federated', actorUri: `did:plc:${token()}` })).status).toBe(
      400,
    );
  });

  it('repairs legacy bridge rows without changing their stable Oxy id', async () => {
    const handle = `legacy${token()}`;
    const uri = `https://bird.makeup/users/${handle}`;
    const id = await account({
      type: 'federated',
      username: `${handle}@bird.makeup`,
      federationActorUri: uri,
      federationDomain: 'bird.makeup',
      federationUnavailableAt: new Date(),
      federationUnavailableReason: 'gone',
    });
    serveActor(uri, {
      attachment: [
        { name: 'Official', value: `<a href="https://x.com/${handle}" rel="me">Official</a>` },
      ],
    });
    expect((await resolveUser({ type: 'federated', actorUri: uri })).status).toBe(200);
    expect(await storedByActorUri(uri)).toMatchObject({
      id,
      username: `${handle}@x.com`,
      federationUnavailableAt: null,
      federationUnavailableReason: null,
    });
    expect(invalidateSpy).toHaveBeenCalledWith(id);
  });

  it('keeps existing automation collision and owner guards', async () => {
    const username = `local${token()}`;
    const id = await account({ username });
    expect((await resolveUser({ type: 'agent', username })).status).toBe(409);
    expect(
      (await resolveUser({ type: 'agent', username: `agent${token()}`, ownerId: 'invalid' }))
        .status,
    ).toBe(400);
    const agent = await resolveUser({ type: 'agent', username: `agent${token()}`, ownerId: id });
    expect(agent.status).toBe(200);
  });

  it('updates the agent that holds a handle and refuses to re-type it', async () => {
    const username = `agent${token()}`;
    const created = await resolveUser({ type: 'agent', username, displayName: 'First' });
    expect(created.status).toBe(200);
    const id = String(created.body.data?.id);

    const updated = await resolveUser({ type: 'agent', username, displayName: 'Second' });
    expect(updated.status).toBe(200);
    expect(updated.body.data?.id).toBe(id);
    const [row] = await getDb()
      .select({ nameFirst: users.nameFirst, type: users.type })
      .from(users)
      .where(eq(users.id, id));
    expect(row).toEqual({ nameFirst: 'Second', type: 'agent' });

    expect((await resolveUser({ type: 'automated', username })).status).toBe(409);
  });

  it('a resolve that loses the race to create a handle updates the winner instead of failing', async () => {
    const username = `agent${token()}`;
    // The winner's row exists but is uncommitted: the resolve's read cannot see
    // it, so it inserts — and blocks on the unique index until the winner commits,
    // then loses with a violation. That is the race, made deterministic.
    let winnerId = '';
    let raced = false;
    let response: Promise<JsonResponse> | undefined;
    await getDb().transaction(async (tx) => {
      const [winner] = await tx
        .insert(users)
        .values({ username, type: 'agent' })
        .returning({ id: users.id });
      winnerId = winner.id;
      response = resolveUser({ type: 'agent', username, displayName: 'Loser' });
      for (let waited = 0; waited < 5_000; waited += 25) {
        const [blocked] = await getDb().execute<{ n: number }>(
          sql`select count(*)::int as n from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'`,
        );
        raced = blocked.n > 0;
        if (raced) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    });
    const resolved = await (response as Promise<JsonResponse>);
    // The resolve really did wait on the winner's row, so it really did lose.
    expect(raced).toBe(true);
    expect(resolved.status).toBe(200);
    expect(resolved.body.data?.id).toBe(winnerId);
    const [row] = await getDb()
      .select({ nameFirst: users.nameFirst })
      .from(users)
      .where(eq(users.id, winnerId));
    expect(row.nameFirst).toBe('Loser');
  });

  it('normalizes source display names and strips markup from source biographies', async () => {
    const uri = `https://social.example/users/${token()}`;
    serveActor(uri, {
      name: 'Alice 🚀',
      summary: '<b>Real biography</b><script>ignored()</script>',
    });
    expect((await resolveUser({ type: 'federated', actorUri: uri })).status).toBe(200);
    const row = await storedByActorUri(uri);
    expect(row.nameFirst).toBe('Alice');
    expect(row.bio).not.toMatch(/<[^>]*>/);
  });
});
